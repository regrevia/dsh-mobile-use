/**
 * 本地 OCR：macOS Vision 框架，常驻 python 进程，不联网、不上传。
 *
 * 用途：文本树几乎为空（Flutter / 自绘 / 相机 / 部分 WebView）时兜底，
 * 把画面上的文字和归一化位置变成可点的候选控件。
 *
 * 资源：进程空闲 45 秒自动退出；一次识别实测 150–180 ms（1618×1080 帧），
 * 首次启动约 230 ms（Vision 模型加载）。
 *
 * @module dsh-mobile-use/ocr
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER = join(HERE, 'ocr_worker.py')
const IDLE_MS = 45_000
/** 一次 ocrImage 的总时限：启动 + 识别共用，避免两边各自超时叠成半分钟。 */
const CALL_TIMEOUT_MS = 15_000
/** 启动 worker 的单独上限：worker 卡在 import Vision 时要尽快放弃。 */
const START_TIMEOUT_MS = 8_000
/**
 * 能跑 Vision 的 python 按优先级排：显式环境变量、本机 OCR venv、系统 python。
 * 系统 python 常常被 Xcode 许可协议挡住，venv 里的 pyobjc 才是这台机器实际能用的那个。
 */
const PYTHON_CANDIDATES = [
  process.env.DSH_OCR_PYTHON,
  join(homedir(), '.local/opt/ocr-venv/bin/python3'),
  '/usr/bin/python3',
].filter(Boolean)
let PYTHON = PYTHON_CANDIDATES[0]

/** 挑第一个真正能 import Vision 的解释器，找不到就返回空串。 @returns {string} python 路径。 */
function pickPython() {
  for (const candidate of PYTHON_CANDIDATES) {
    if (!existsSync(candidate)) continue
    const check = spawnSync(candidate, ['-c', 'import Vision, Quartz, Foundation'], { timeout: 5000, stdio: 'ignore' })
    if (!check.error && check.status === 0) return candidate
  }
  return ''
}

let worker = null
let ready = null
let idleTimer = null
let seq = 0
const pending = new Map()
let buffer = ''

/**
 * 探一次本机能不能跑 OCR：平台、worker 文件、python 能否 import Vision 三个条件。
 * 结果缓存，插件生命周期内只探一次（worker 起不来时也别每次调用都 spawn 一次 python）。
 * @returns {{ available: boolean, reason: string }} 可用性；不可用时 `reason` 说明原因。
 */
function probe() {
  if (process.platform !== 'darwin') return { available: false, reason: `本机是 ${process.platform}，Vision OCR 只有 macOS 有` }
  if (!existsSync(WORKER)) return { available: false, reason: `缺少 ${WORKER}` }
  /* 只探 import：worker 真正用到的 Vision/Quartz 都在这里，缺 pyobjc 会在启动后立刻崩。 */
  const picked = pickPython()
  if (!picked) {
    return { available: false, reason: `没找到带 Vision/Quartz 的 python，装一份：python3 -m venv ~/.local/opt/ocr-venv && ~/.local/opt/ocr-venv/bin/pip install pyobjc-framework-Vision pyobjc-framework-Quartz` }
  }
  PYTHON = picked
  return { available: true, reason: '' }
}

let availability = null

/**
 * 本机 OCR 状态：可用性和不可用原因。
 * @returns {{ available: boolean, reason: string }} `reason` 可直接写进工具结果，让上层回退到文本树/截图。
 */
export function ocrStatus() {
  if (availability === null) availability = probe()
  return availability
}

/** python3 与 Vision 是否可用（不存在就没有 OCR）。 @returns {boolean} 可用为 true。 */
export function ocrAvailable() {
  return ocrStatus().available
}

/**
 * 拿不可用原因；可用时返回空串。
 * @returns {string} 人话原因，例如「本机是 linux，Vision OCR 只有 macOS 有」。
 */
export function ocrReason() {
  return ocrStatus().reason
}

function kill() {
  if (worker) {
    try {
      worker.kill()
    } catch {
      /* 已经退了 */
    }
  }
  worker = null
  ready = null
  buffer = ''
  for (const [, entry] of pending) entry.reject(new Error('OCR 进程已退出'))
  pending.clear()
}

function armIdle() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (pending.size === 0) kill()
  }, IDLE_MS)
  idleTimer.unref?.()
}

function start() {
  if (ready) return ready
  const state = ocrStatus()
  if (!state.available) return Promise.reject(new Error(`本机没有 OCR：${state.reason}`))
  ready = new Promise((resolve, reject) => {
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
      kill()
    }
    const child = spawn(PYTHON, [WORKER], { stdio: ['pipe', 'pipe', 'pipe'] })
    worker = child
    const timer = setTimeout(() => {
      fail(new Error('OCR 进程启动超时'))
    }, START_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.ready === true) {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            resolve()
          }
          continue
        }
        const entry = pending.get(message.path)
        if (!entry) continue
        pending.delete(message.path)
        if (message.error) entry.reject(new Error(message.error))
        else entry.resolve({ blocks: message.blocks ?? [], width: message.w, height: message.h })
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', () => {})
    child.on('error', (error) => {
      fail(error)
    })
    child.on('exit', (code, signal) => {
      /* 关键：ready 之前就退出时必须 reject，否则 start() 的 Promise 永远挂着，
         上层 ocrImage 的 await 也跟着挂死（非 macOS / 缺 pyobjc 时的实际表现）。 */
      fail(new Error(`OCR 进程启动时退出（code=${String(code)}, signal=${String(signal)}）`))
      if (worker === child) {
        worker = null
        ready = null
        buffer = ''
        for (const [, entry] of pending) entry.reject(new Error('OCR 进程退出'))
        pending.clear()
      }
    })
  })
  return ready
}

/**
 * 识别一张本机图片上的文字。
 * @param {string} path - 图片绝对路径（PNG/JPEG）。
 * @returns {Promise<{blocks: Array<{text: string, conf: number, x: number, y: number, w: number, h: number}>, width: number, height: number}>}
 *   `x/y/w/h` 是归一化坐标，原点在**左下角**（Vision 的习惯）。
 */
export async function ocrImage(path) {
  /* 启动和识别共用一个 deadline：启动慢了，识别就少等，整体最多 CALL_TIMEOUT_MS。 */
  const deadline = Date.now() + CALL_TIMEOUT_MS
  await start()
  armIdle()
  const left = deadline - Date.now()
  if (left <= 0) throw new Error('OCR 超时')
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(path)
      reject(new Error('OCR 超时'))
    }, left)
    pending.set(path, {
      resolve: (result) => {
        clearTimeout(timer)
        resolve(result)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    })
    /* worker 可能在 start() resolve 之后、这里之前就退了：写不进去就明确失败，别抛同步异常。 */
    if (worker === null) {
      pending.delete(path)
      clearTimeout(timer)
      reject(new Error('OCR 进程已退出'))
      return
    }
    try {
      worker.stdin.write(`${path}\n`)
    } catch (error) {
      pending.delete(path)
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/** 关掉常驻进程（插件卸载时调）。 */
export function stopOcr() {
  if (idleTimer) clearTimeout(idleTimer)
  kill()
}

/**
 * 把归一化结果换算成设备像素矩形。
 * @param {Array} blocks - `ocrImage` 的返回值。
 * @param {number} width - 图片宽（= 设备宽，screencap 原图）。
 * @param {number} height - 图片高。
 * @returns {Array<{text: string, conf: number, x1: number, y1: number, x2: number, y2: number}>}
 */
export function toRects(blocks, width, height) {
  const rects = []
  for (const block of blocks) {
    if (!block.text || block.conf < 0.3) continue
    const x1 = Math.round(block.x * width)
    const x2 = Math.round((block.x + block.w) * width)
    const y1 = Math.round((1 - block.y - block.h) * height)
    const y2 = Math.round((1 - block.y) * height)
    if (x2 - x1 < 6 || y2 - y1 < 6) continue
    rects.push({ text: block.text, conf: block.conf, x1, y1, x2, y2 })
  }
  return rects
}

export { seq }
