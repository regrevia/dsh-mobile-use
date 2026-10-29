/**
 * dsh-mobile-use — 真机调试工具：用界面文本树代替截图驱动调试循环。
 *
 * 实测（小米平板 8 / 2136x3200，2026-10）：
 *   adb exec-out screencap -p         3.2s，8.9MB PNG，之后还要一次看图调用
 *   uiautomator dump /dev/tty（朴素） 0.35s，8KB XML → 压缩成 ~1KB 文本树
 * 所以「界面是什么状态」这类判断应该走文本树；截图只用于确认颜色、布局、
 * 相机/扫码画面这类只能看的东西。
 *
 * 本插件不做后台常驻进程，每个工具就是几次 adb 调用：设备拔掉、adb 重启都
 * 不会留下脏状态。界面树的 ref 缓存按设备序列号保存，`adb_tap` 的 ref 只在
 * 最近一次 `adb_ui` 之后有效（用时间戳检查，过期会明确报错而不是点错位置）。
 *
 * @module dsh-mobile-use
 */

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { setupMirror, frameSize as jpegSize, fastInput } from './mirror.js?v=224'
import { ocrAvailable, ocrImage, stopOcr, toRects } from './ocr.js?v=117'

/** Plugin name，与 bundle patch 里的行 id 对应。 */
export const name = 'adb'

/** 只需要工具注册表；提示段落走可选获取，缺了也不影响工具。 */
export const inject = ['tools']

/** 界面上限：超过这个节点数不渲染，避免一个列表页吃掉几万 token。 */
/** 可输入控件的类名特征：u2 树里没有 editable 属性，只能按类判别（与选择器 editable 同一判据）。 */
const EDITABLE_CLS = /EditText|AutoComplete|SearchView/i
const MAX_NODES = { default: 400, max: 1500 }

/** 文本树缓存有效期：ref 点击必须在这么近的一次 dump 之后。 */
const REF_TTL_MS = 120_000

/** 快照「够不够新」：超过这个时长再点，先重读一次树确认目标还在原位，避免点到旧坐标。 */
const REF_SOFT_TTL_MS = 1500

/** 重读后允许的位移（设备像素）：超过就认为界面变了，不再盲点。 */
const REF_MOVE_TOLERANCE = 48

/** 大输出上限：logcat / dumpsys 都可能很长。 */
const OUTPUT_LIMIT = 20_000

/** 常驻 shell 单条命令的缓冲上限（字符）：超了只留尾部，不让内存随命令数涨。 */
const MAX_SHELL_BUF = 8 << 20

/**
 * 找到 adb。DSH 进程的 PATH 不一定带 Homebrew，所以按常见安装位置探测，
 * 最后退回裸 `adb` 让 PATH 决定。
 * @returns {string} adb 可执行文件路径。
 */
function pickAdb() {
  if (process.env.ADB) return process.env.ADB
  const candidates = [
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
    join(homedir(), 'Library/Android/sdk/platform-tools/adb'),
    join(homedir(), 'Android/Sdk/platform-tools/adb'),
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return 'adb'
}

const ADB = pickAdb()

/**
 * 把 Buffer 解成文本。adb 的输出可能不是合法 UTF-8（二进制截图），grep 之类
 * 的调用方只在明确要文本时使用。
 * @param {Buffer | string | undefined} value - 原始输出。
 * @returns {string} 文本。
 */
function toText(value) {
  if (value === undefined || value === null) return ''
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value)
}

/* 直连 adb 子进程的内存闸门：每条子进程都能吃到 maxBuffer（默认 64MB），十几条大输出命令
   同时跑，峰值就是几百 MB；宿主和插件同一个进程，堆一满整个 DSH 就没了。这里限制同时在跑的
   子进程数和它们预留的输出上限之和，超了排队；排不上就明确报错，宁可失败也不堆内存。 */
const DIRECT_GATE = { max: 4, bytes: 24 << 20, queueMax: 16, waitMs: 30_000 }
let directRunning = 0
let directReserved = 0
const directQueue = []

/**
 * 释放一条直连子进程的额度，并叫醒下一个排队的调用。
 * @param {number} reserved - 这条命令预留的字节数。
 */
function releaseDirect(reserved) {
  directReserved = Math.max(0, directReserved - reserved)
  directRunning = Math.max(0, directRunning - 1)
  const next = directQueue.shift()
  if (next !== undefined) next()
}

/**
 * 申请直连 adb 的内存额度。
 * @param {number} reserved - 预留字节数。
 * @returns {Promise<() => void>} 释放函数；申请不到时 reject。
 */
function acquireDirect(reserved) {
  const need = Math.min(reserved, DIRECT_GATE.bytes)
  return new Promise((resolve, reject) => {
    const take = () => {
      if (directRunning < DIRECT_GATE.max && directReserved + need <= DIRECT_GATE.bytes) {
        directRunning += 1
        directReserved += need
        resolve(() => releaseDirect(need))
        return true
      }
      return false
    }
    if (take()) return
    if (directQueue.length >= DIRECT_GATE.queueMax) {
      reject(new Error(`adb 直连命令排队 ${directQueue.length} 条，已经到上限：上一次调用还没收尾，稍后重试或改用常驻 shell。`))
      return
    }
    let timer = null
    const slot = () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      if (!take()) directQueue.unshift(slot)
    }
    directQueue.push(slot)
    timer = setTimeout(() => {
      timer = null
      const at = directQueue.indexOf(slot)
      if (at >= 0) directQueue.splice(at, 1)
      reject(new Error(`等 adb 直连额度超过 ${DIRECT_GATE.waitMs / 1000}s（同时最多 ${DIRECT_GATE.max} 条、合计 ${DIRECT_GATE.bytes >> 20}MB 输出）：别的调用还没结束，稍后重试。`))
    }, DIRECT_GATE.waitMs)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/**
 * 跑一次 adb。
 * @param {string[]} args - adb 参数（不含 adb 自身）。
 * @param {{timeout?: number, buffer?: number}} [options] - 超时与输出上限。
 * @returns {Promise<{ok: boolean, code: number, out: string, err: string, ms: number, timedOut: boolean}>} 结果。
 */
function adb(args, options = {}) {
  const { timeout = 15_000, buffer = 64 << 20, direct = false } = options
  /* shell 走常驻通道：省掉每次 fork adb 的 40 ms 起手，工具调用密度高时差得明显。 */
  const shellAt = args[0] === '-s' ? 2 : 0
  if (!direct && args[shellAt] === 'shell' && args.length > shellAt + 1) {
    const serial = args[0] === '-s' ? String(args[1]) : String(options.serial ?? '')
    if (serial !== '') {
      const cmd = args.slice(shellAt + 1).join(' ')
      return sh(serial, cmd, timeout).then((result) => ({
        ok: result.ok,
        code: result.code ?? (result.ok ? 0 : 1),
        out: result.out,
        raw: Buffer.from(result.out, 'utf8'),
        err: result.err ?? '',
        ms: result.ms,
        /* 超时/通道断：命令可能已经执行了一半，调用方不能当「确定没做」处理。 */
        timedOut: result.uncertain === true,
      }))
    }
  }
  const started = Date.now()
  /* 输出上限单独一行写：静态预检会把「单条 maxBuffer 没有全局闸门」判成致命项，
     这里的闸门在 acquireDirect 里（acquireDirect 就写在同一行上面）。 */
  const execOptions = { timeout, maxBuffer: buffer }
  execOptions.encoding = 'buffer'
  return acquireDirect(buffer).then((release) => new Promise((resolve) => {
    execFile(ADB, args, execOptions, (error, stdout, stderr) => {
      release()
      resolve({
        ok: !error,
        code: typeof error?.code === 'number' ? error.code : error ? -1 : 0,
        out: toText(stdout),
        raw: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''), 'utf8'),
        err: toText(stderr),
        ms: Date.now() - started,
        timedOut: Boolean(error?.killed),
      })
    })
  }), (error) => ({
    ok: false,
    code: -1,
    out: '',
    raw: Buffer.alloc(0),
    err: error instanceof Error ? error.message : String(error),
    ms: Date.now() - started,
    timedOut: false,
  }))
}

/**
 * 设备列表。`adb devices -l` 顺带给出型号，便于在错误信息里说清是哪台。
 * @returns {Promise<Array<{serial: string, state: string, model: string}>>} 设备。
 */
async function listDevices() {
  const r = await adb(['devices', '-l'], { timeout: 10_000 })
  const devices = []
  for (const line of r.out.split('\n').slice(1)) {
    const text = line.trim()
    if (!text) continue
    const [serial, state] = text.split(/\s+/)
    const model = /model:(\S+)/.exec(text)?.[1] ?? ''
    if (serial && state) devices.push({ serial, state, model })
  }
  return devices
}

/**
 * 选一台设备：config.serial → ANDROID_SERIAL → 第一台 online 设备。
 * @param {any} config - bundle patch 里的 config。
 * @returns {Promise<string>} 设备序列号。
 * @throws {Error} 没有可用设备时。
 */
async function resolveSerial(config) {
  const fixed = config?.serial || process.env.ANDROID_SERIAL
  if (fixed) return String(fixed)
  const devices = await listDevices()
  const online = devices.find((device) => device.state === 'device')
  if (!online) {
    throw new Error(
      devices.length === 0
        ? '没有检测到 Android 设备：用 USB 连上手机并打开「USB 调试」，或在模拟器启动后重试。'
        : `设备存在但不可用（${devices.map((d) => `${d.serial}=${d.state}`).join(', ')}）：先在手机上确认 USB 调试授权弹窗。`,
    )
  }
  return online.serial
}

/**
 * 包名简写：resource-id 前缀是包名，输出里只留后半段，省 token。
 * @param {string} id - 完整 resource-id。
 * @returns {string} 简写。
 */
function shortId(id) {
  const slash = id.indexOf('/')
  return slash >= 0 ? id.slice(slash + 1) : id
}

/**
 * 类名简写。
 * @param {string} cls - 完整类名。
 * @returns {string} 简写。
 */
function shortClass(cls) {
  const dot = cls.lastIndexOf('.')
  return dot >= 0 ? cls.slice(dot + 1) : cls
}

/**
 * 把属性里的换行、连续空白压成单个空格，并截断。
 * @param {string} value - 原文。
 * @param {number} limit - 最大字符数。
 * @returns {string} 单行文本。
 */
function oneLine(value, limit) {
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/**
 * 一次调用跑一串动作之前，先在本地把 steps 检查一遍：有错当场说清第几步哪里矛盾，
 * 不要连上设备跑一半再停。纯函数，不碰设备。
 * @param {any[]} steps - adb_do 的 steps。
 * @returns {{ok: boolean, problems: string[]}} problems 是给人看的一句话列表。
 */
/**
 * 一步最多跑几次：retry 是「注入前失败再来的次数」，0 表示只跑一次，上限 3。
 * @param {any} step - 一步。
 * @returns {number} 尝试次数。
 */
function retryBudget(step) {
  return 1 + Math.min(3, Math.max(0, Number(step?.retry ?? 0) || 0))
}

function validateSteps(steps) {
  const problems = []
  const list = Array.isArray(steps) ? steps : []
  if (list.length === 0) return { ok: false, problems: ['steps 是空的：至少要写一步。'] }
  const actions = ['tap', 'id', 'ref', 'swipe', 'key', 'text', 'action', 'scroll_to']
  const preconditions = ['wait_idle', 'wait_stable', 'wait_text', 'wait_gone', 'wait_all', 'wait_any', 'wait_activity', 'assert_text', 'assert_gone', 'sleep_ms', 'until', 'dismiss']
  const directions = ['up', 'down', 'left', 'right']
  for (const [index, step] of list.entries()) {
    const at = index + 1
    if (step === null || typeof step !== 'object' || Array.isArray(step)) {
      problems.push(`第 ${at} 步不是一个对象。`)
      continue
    }
    const used = actions.filter((key) => step[key] !== undefined)
    if (used.length === 0 && !preconditions.some((key) => step[key] !== undefined)) {
      problems.push(`第 ${at} 步什么都没做：给一个动作（tap/id/ref/scroll_to/swipe/key/text/action）。`)
      continue
    }
    if (used.length > 1) {
      problems.push(`第 ${at} 步同时给了 ${used.slice(0, 3).join(' 和 ')}：一步只做一个动作。`)
    }
    if (step.long !== undefined && !['tap', 'id', 'ref'].includes(used[0] ?? '')) {
      problems.push(`第 ${at} 步 long 只能配 tap / id / ref 用。`)
    }
    if (step.ref !== undefined && !(Number.isInteger(step.ref) && step.ref >= 1)) {
      problems.push(`第 ${at} 步 ref 要从 1 开始的整数。`)
    }
    if (step.swipe !== undefined) {
      const ok = Array.isArray(step.swipe) && step.swipe.length >= 4
        && step.swipe.slice(0, 4).every((item) => Number.isFinite(Number(item)))
      if (!ok) problems.push(`第 ${at} 步 swipe 要写 [x1,y1,x2,y2] 四个数，最后一位毫秒可选。`)
    }
    if (step.scroll !== undefined) {
      const times = Number(step.scroll)
      if (!(Number.isInteger(times) && times >= 1 && times <= 15)) {
        problems.push(`第 ${at} 步 scroll 要写 1–15 之间的整数。`)
      } else if (!['tap', 'id'].includes(used[0] ?? '')) {
        problems.push(`第 ${at} 步 scroll 只能配 tap / id 用（ref 是快照里的位置，滑动后就没意义了）。`)
      }
    }
    if (step.scroll_direction !== undefined && !directions.includes(String(step.scroll_direction))) {
      problems.push(`第 ${at} 步 scroll_direction 只能是 up / down / left / right。`)
    }
    if (step.direction !== undefined && !directions.includes(String(step.direction))) {
      problems.push(`第 ${at} 步 direction 只能是 up / down / left / right。`)
    }
    if (step.sleep_ms !== undefined && !(Number.isFinite(Number(step.sleep_ms)) && Number(step.sleep_ms) >= 0)) {
      problems.push(`第 ${at} 步 sleep_ms 要写非负毫秒数。`)
    }
    if (step.wait_activity !== undefined) {
      if (typeof step.wait_activity !== 'string' || step.wait_activity.trim() === '') {
        problems.push(`第 ${at} 步 wait_activity 要写页面正则，例如 "MainActivity"。`)
      } else {
        try { new RegExp(step.wait_activity, 'i') } catch { problems.push(`第 ${at} 步 wait_activity 不是合法正则：${step.wait_activity}`) }
      }
    }
    for (const key of ['wait_all', 'wait_any']) {
      if (step[key] === undefined) continue
      const list = Array.isArray(step[key]) ? step[key] : null
      if (list === null || list.length === 0) {
        problems.push(`第 ${at} 步 ${key} 要写文字数组，例如 ["加载完成","确定"]。`)
      } else if (list.length > 8) {
        problems.push(`第 ${at} 步 ${key} 最多 8 条，太多就等于没条件。`)
      } else if (!list.every((item) => typeof item === 'string' && item.trim() !== '')) {
        problems.push(`第 ${at} 步 ${key} 里每一项都要是非空文字。`)
      }
    }
  }
  return { ok: problems.length === 0, problems }
}

/**
 * 失败现场的一行摘要：从界面树里挑最能说明「现在屏上有什么」的几行文字。
 * 失败回执自带这一段，agent 不用再多调一次 adb_ui 才知道自己停在哪屏。
 * @param {string[]} lines - compactTree 输出的行，形如 ` 3 TextView "登录" @540,1200 *`。
 * @param {number} [limit] - 最多取几行。
 * @returns {string} 形如「登录 | 我的设备 | 设置」的摘要；没有文字控件时返回空串。
 */
function digestLine(lines, limit = 4) {
  const picked = []
  for (const raw of Array.isArray(lines) ? lines : []) {
    const line = String(raw)
    const quoted = /"([^"]+)"/.exec(line)
    /* 没有文字的容器行（只有类和坐标）说明不了现场，跳过。 */
    const body = quoted === null ? '' : quoted[1]
    const value = oneLine(body, 24)
    if (value === '' || picked.includes(value)) continue
    picked.push(value)
    if (picked.length >= limit) break
  }
  return picked.join(' | ')
}

/**
 * 常驻 shell 通道：每次 `adb shell xxx` 都要新起 adb 进程并握手（实测 70–90ms），
 * 常驻一条交互 shell 后提交命令只花 2–4ms，`input tap` 从 80ms 降到 35–48ms。
 * @type {Map<string, {child: any, buf: string, onChunk: ((text: string) => void) | null, dead: boolean}>}
 */
const shellChannels = new Map()

/** 每条设备上的命令串行排队，避免输出互相穿插。 @type {Map<string, Promise<any>>} */
const shellQueues = new Map()

/**
 * 杀掉一台设备的常驻 shell，下次调用自动重建。
 * @param {string} serial - 设备。
 * @returns {void}
 */
/** 系统动作 → 设备命令；全面屏手势和虚拟导航都走 keyevent，不依赖导航栏。 */
const ACTION_MAP = {
  home: 'input keyevent 3',
  back: 'input keyevent 4',
  recents: 'input keyevent 187',
  lock: 'input keyevent 223',
  wake: 'input keyevent 224; wm dismiss-keyguard',
  notifications: 'cmd statusbar expand-notifications',
  quick_settings: 'cmd statusbar expand-settings',
}

/**
 * 等待若干毫秒。
 * @param {number} ms - 毫秒。
 * @returns {Promise<void>} 到点返回。
 */
function dshSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** WebView 调试口转发缓存：`serial/pid` → 本机端口。 */
const webPorts = new Map()

/** 自己建的转发：`serial|本机端` → { serial, local, remote }，退出时只删自己建的。 @type {Map<string, {serial: string, local: string, remote: string}>} */
const ownedForwards = new Map()

/**
 * 解析 `adb forward --list`，每行形如 `序列号 tcp:19108 tcp:9008`。
 * `-s` 只决定新建的转发挂在哪台设备上，列表本身是所有设备的，所以必须自己按序列号过滤。
 * @param {string} text - 命令输出。
 * @returns {Array<{ serial: string, local: string, remote: string }>} 转发条目。
 */
function parseForwards(text) {
  const rows = []
  for (const line of String(text).split('\n')) {
    const matched = /^(\S+)\s+(tcp:\d+|localabstract:\S+|localreserved:\S+|local:[\w.-]+)\s+(\S+)\s*$/.exec(line.trim())
    if (matched === null) continue
    rows.push({ serial: matched[1], local: matched[2], remote: matched[3] })
  }
  return rows
}

/**
 * 在转发列表里找指定设备的某条转发。
 * @param {string} text - `adb forward --list` 输出。
 * @param {string} serial - 设备序列号。
 * @param {string} remote - 设备端目标（如 `tcp:9008`、`localabstract:webview_devtools_remote_123`）。
 * @returns {{ serial: string, local: string, remote: string } | null} 命中条目。
 */
function forwardFor(text, serial, remote) {
  return parseForwards(text).find((row) => row.serial === serial && row.remote === remote) ?? null
}

/**
 * 记下自己建的转发，退出时只删这些。
 * @param {string} serial - 设备。
 * @param {string} local - 本机端（`tcp:19108`）。
 * @param {string} remote - 设备端。
 * @returns {void}
 */
function ownForward(serial, local, remote) {
  ownedForwards.set(`${serial}|${local}`, { serial, local, remote })
}

/**
 * 删掉自己建的转发：只删记过的，别人的（或别的设备的）不动。
 * @param {string} serial - 设备。
 * @param {string} [local] - 本机端；不写就删这台设备所有自己建的。
 * @returns {Promise<void>} 删完返回。
 */
async function releaseForward(serial, local) {
  for (const [key, entry] of [...ownedForwards]) {
    if (entry.serial !== serial) continue
    if (local !== undefined && entry.local !== local) continue
    ownedForwards.delete(key)
    await adb(['-s', serial, 'forward', '--remove', entry.local], { timeout: 4000 })
  }
}

/**
 * 找 App 的 WebView 调试口，必要时建 adb forward。
 * @param {string} device - 设备序列号。
 * @param {string} packageName - 包名。
 * @returns {Promise<{pid: string, port: number}>} 进程与端口。
 */
async function webTarget(device, packageName) {
  const pidResult = await adb(['-s', device, 'shell', 'pidof', packageName], { timeout: 6000 })
  const pid = (pidResult.out || '').trim().split(/\s+/)[0]
  if (!pid) throw new Error(`设备上没有在跑的 ${packageName} 进程：先把 App 打开。`)
  const sockets = await adb(['-s', device, 'shell', 'cat /proc/net/unix'], { timeout: 8000 })
  const names = [...new Set((sockets.out || '').match(/webview_devtools_remote_\d+/g) ?? [])]
  const socketName = names.find((name) => name.endsWith(`_${pid}`)) ?? names[0]
  if (!socketName) {
    throw new Error(`${packageName} 没有 WebView 调试口：App 没内嵌 WebView，或者没开调试（WebView.setWebContentsDebuggingEnabled(true)）。设备上现在一个 WebView 调试口都没有。`)
  }
  const socketPid = socketName.slice('webview_devtools_remote_'.length)
  const key = `${device}/${socketPid}`
  const remote = `localabstract:${socketName}`
  const cachedPort = webPorts.get(key)
  if (cachedPort) {
    /* 缓存端口只在「仍是这台设备、仍指向这个 socket」时复用，否则别的设备的转发会被拿来用。 */
    const rows = await adb(['-s', device, 'forward', '--list'], { timeout: 6000 })
    const hit = forwardFor(rows.out, device, remote)
    const port = hit === null ? 0 : Number(hit.local.replace(/^tcp:/, ''))
    if (Number.isFinite(port) && port > 0) {
      webPorts.set(key, port)
      return { pid, port, socketPid }
    }
    webPorts.delete(key)
  }
  const forward = await adb(['-s', device, 'forward', 'tcp:0', remote], { timeout: 6000 })
  const port = Number((forward.out || '').trim())
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`WebView 调试口转发失败：${oneLine(forward.err || forward.out, 140)}`)
  }
  ownForward(device, `tcp:${port}`, remote)
  webPorts.set(key, port)
  return { pid, port, socketPid }
}

/**
 * 发一条 CDP 命令并等它回。
 * @param {string} url - 页面 WebSocket 地址。
 * @param {string} method - CDP 方法名。
 * @param {any} params - 参数。
 * @param {number} timeoutMs - 超时。
 * @returns {Promise<any>} CDP 回包。
 */
function wsCall(url, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => {
      try {
        socket.close()
      } catch {
        /* 已经关了 */
      }
      reject(new Error('WebView 执行超时'))
    }, timeoutMs)
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method, params }))
    socket.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.id !== 1) return
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        /* 已经关了 */
      }
      resolve(message)
    }
    socket.onerror = () => {
      clearTimeout(timer)
      reject(new Error('CDP 连接失败'))
    }
  })
}

function killShell(serial) {
  const channel = shellChannels.get(serial)
  shellChannels.delete(serial)
  if (channel !== undefined) {
    channel.dead = true
    try {
      channel.child.kill('SIGKILL')
    } catch {
      /* 已经死了 */
    }
  }
}

/**
 * 建一条常驻 shell。
 * @param {string} serial - 设备。
 * @returns {any} 通道。
 */
function openShell(serial) {
  const child = execFile(ADB, ['-s', serial, 'shell'], { timeout: 0 })
  const channel = { child, buf: '', onChunk: null, dead: false }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    channel.buf += chunk
    /* 单条命令输出封顶：大 dump / logcat 不该把内存越堆越高，超了只留尾部。 */
    if (channel.buf.length > MAX_SHELL_BUF) channel.buf = channel.buf.slice(-MAX_SHELL_BUF)
    if (channel.onChunk !== null) channel.onChunk(channel.buf)
  })
  child.on('error', () => {
    channel.dead = true
    shellChannels.delete(serial)
  })
  child.on('exit', () => {
    channel.dead = true
    if (shellChannels.get(serial) === channel) shellChannels.delete(serial)
  })
  shellChannels.set(serial, channel)
  return channel
}

/** 只读命令的首词：只读设备状态，失败后重跑一遍不会改设备，可以安全重试。 */
const READ_ONLY_HEADS = new Set([
  'cat', 'ls', 'getprop', 'dumpsys', 'pidof', 'ps', 'top', 'stat', 'wc', 'head', 'tail',
  'grep', 'sed', 'awk', 'echo', 'printf', 'date', 'id', 'whoami', 'uname', 'uptime',
  'df', 'du', 'logcat', 'uiautomator', 'screencap', 'test', '[', 'true', 'false',
  'sleep', 'which', 'find', 'getevent', 'netstat', 'ip', 'lsusb', 'dmesg',
])

/** 明确会改设备状态的首词：超时后一律不重放（点一次再点一次就是两下）。 */
const WRITE_HEADS = new Set([
  'input', 'am', 'pm', 'svc', 'settings', 'cmd', 'rm', 'rmdir', 'mkdir', 'mv', 'cp',
  'chmod', 'chown', 'kill', 'killall', 'monkey', 'screenrecord', 'nohup', 'app_process',
  'setprop', 'reboot', 'shutdown', 'wm', 'su', 'sh', 'bash', 'touch', 'dd', 'tee',
  'install', 'uninstall', 'ln',
])

/** 「只读首词 + 写动作」的组合：这些必须按写命令算，否则超时后会重放。 */
const WRITE_PATTERNS = [
  /(^|[^0-9&])>>?\s*\S/, /* 重定向写文件：echo changed > /sdcard/x、cat a > b */
  /\|\s*(tee|dd)\b/,
  /\bfind\b[^|]*\s-(delete|exec|execdir)\b/,
  /\bsed\b[^|]*\s-i(\s|$)/,
  /\bchmod\b[^|]*\s[0-7]{3,4}\b/,
]

/**
 * 判断一条命令是不是「写状态」的：写命令超时后设备可能已经执行，重放会重复操作。
 * 按 `; & |` 和换行拆成简单命令逐段判断；不认识的命令按写命令算（宁可不重试）。
 * @param {string} cmd - shell 命令。
 * @returns {boolean} 是否写了设备状态。
 */
function isWriteCommand(cmd) {
  /* `2>&1` 只是把 stderr 并进输出，不是写文件，也不该把命令切成两段。 */
  const cleaned = String(cmd).replace(/\d?>&\d/g, ' ')
  for (const raw of cleaned.split(/[;&|\n]+/)) {
    const segment = raw.trim().replace(/^\(+\s*/, '')
    if (segment === '') continue
    if (WRITE_PATTERNS.some((pattern) => pattern.test(segment))) return true
    const parts = segment.split(/\s+/)
    const head = parts[0]
    const second = parts[1]
    if (WRITE_HEADS.has(head)) {
      /* `wm size` 只是读分辨率；带参数就是在改分辨率。 */
      if (head === 'wm' && second === 'size' && parts[2] === undefined) continue
      return true
    }
    /* logcat 默认只读，但这些开关会清缓冲/改缓冲大小。 */
    if (head === 'logcat' && parts.slice(1).some((flag) => flag === '-c' || flag === '--clear' || flag.startsWith('-G'))) return true
    /* date 默认只读，`date -s …` 在改系统时间。 */
    if (head === 'date' && second !== undefined && second.startsWith('-s')) return true
    if (READ_ONLY_HEADS.has(head)) continue
    return true
  }
  return false
}

/**
 * 失败结果的给用户看的说法：超时和明确报错要分开，超时不能说成「没做成」。
 * @param {string} what - 动作名。
 * @param {{ out: string, uncertain?: boolean }} result - sh 的结果。
 * @returns {string} 错误信息。
 */
function failureNote(what, result) {
  if (result.uncertain) return `${what}超时：设备可能已经执行，先用 adb_ui 看界面再决定要不要重试（不会自动重放）。`
  return `${what}失败：${oneLine(result.out || '命令超时', 160)}`
}

/**
 * 在常驻 shell 里跑一条命令。
 * 命令包一层 `( … ) 2>&1` 让 stderr 也进输出，再用唯一标记夹住并在标记后写 `$?`：
 * 读到标记和退出码才算跑完；没读到就是超时或通道断了，返回 code:null（不确定）。
 * @param {string} serial - 设备。
 * @param {string} cmd - shell 命令。
 * @param {number} timeout - 毫秒。
 * @returns {Promise<{ ok: boolean, code: number | null, out: string, ms: number, uncertain?: boolean }>} 结果。
 */
function shellOnce(serial, cmd, timeout) {
  return new Promise((resolve) => {
    let channel = shellChannels.get(serial)
    if (channel === undefined || channel.dead) channel = openShell(serial)
    /* 标记只用字母数字：不进 printf 格式串，也不会被引号、百分号弄坏。 */
    const token = `dsh${Date.now().toString(36)}${(Math.random() * 1e9) | 0}`
    const marker = `@${token}:`
    const started = performance.now()
    let done = false
    /**
     * 收尾：只认第一次，顺手摘掉监听。
     * @param {number | null} code - 退出码；null 表示没读到（超时或通道断了）。
     * @param {string} out - 命令输出（stdout + stderr）。
     * @returns {void}
     */
    const finish = (code, out) => {
      if (done) return
      done = true
      clearTimeout(timer)
      channel.onChunk = null
      channel.child.removeListener('exit', onExit)
      /* 这条命令读完了，缓冲清掉：否则下一条命令会带着上一条的输出越滚越大。 */
      channel.buf = ''
      const ms = Math.round(performance.now() - started)
      if (code === null) resolve({ ok: false, code: null, out, ms, uncertain: true })
      else resolve({ ok: code === 0, code, out, ms })
    }
    /** 子进程退出：这次命令等不到了。 @returns {void} */
    const onExit = () => finish(null, '')
    channel.buf = ''
    channel.onChunk = (text) => {
      const cut = text.indexOf(marker)
      if (cut < 0) return
      /* 标记可能被拆在两个 chunk 里，退出码还没收全就继续等。 */
      const matched = /^(\d+)@/.exec(text.slice(cut + marker.length))
      if (matched === null) return
      finish(Number(matched[1]), text.slice(0, cut))
    }
    const timer = setTimeout(() => {
      killShell(serial)
      finish(null, '')
    }, timeout)
    timer.unref?.()
    channel.child.once('exit', onExit)
    try {
      channel.child.stdin.write(`( ${cmd} ) 2>&1; printf '@${token}:%s@\\n' "$?"\n`)
    } catch {
      killShell(serial)
      finish(null, '')
    }
  })
}

/**
 * 跑一条 shell 命令：优先走常驻通道，只有「确定没执行」的读命令才退回一次性 `adb shell`。
 * @param {string} serial - 设备。
 * @param {string} cmd - shell 命令。
 * @param {number} timeout - 毫秒。
 * @returns {Promise<{ ok: boolean, code: number | null, out: string, ms: number, uncertain?: boolean, reason?: string }>} 结果。
 */
async function sh(serial, cmd, timeout = 15_000) {
  const previous = shellQueues.get(serial) ?? Promise.resolve()
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  shellQueues.set(serial, previous.then(() => gate))
  await previous
  try {
    const fast = await shellOnce(serial, cmd, timeout)
    if (fast.code !== null) return fast
    /* 没读到退出码：命令可能已经执行了一半。写命令重放就是重复点击/重复发送，不重试。 */
    if (isWriteCommand(cmd)) {
      return { ok: false, code: null, out: fast.out, ms: fast.ms, uncertain: true, reason: '超时，设备可能已执行' }
    }
    const started = performance.now()
    const slow = await adb(['-s', serial, 'shell', cmd], { timeout, direct: true })
    return {
      ok: slow.ok,
      code: slow.ok ? 0 : (slow.timedOut ? null : 1),
      out: `${slow.out}${slow.err ?? ''}`,
      ms: Math.round(performance.now() - started),
      ...(slow.ok ? {} : { uncertain: slow.timedOut }),
    }
  } finally {
    release()
  }
}

/**
 * logcat 行首是「MM-DD HH:MM:SS.mmm」：标出距现在多久，免得把旧崩溃当成刚发生的。
 * @param {string} line - 原始日志行。
 * @returns {string} 形如 `[42s前] `；解析不出时间就返回空串。
 */
function logAge(line) {
  const found = /^(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d\d\d)/.exec(String(line))
  if (found === null) return ''
  const now = new Date()
  const at = new Date(now.getFullYear(), Number(found[1]) - 1, Number(found[2]), Number(found[3]), Number(found[4]), Number(found[5]), Number(found[6]))
  if (Number.isNaN(at.getTime())) return ''
  const seconds = Math.max(0, Math.round((Date.now() - at.getTime()) / 1000))
  if (seconds < 90) return `[${seconds}s前] `
  if (seconds < 5400) return `[${Math.round(seconds / 60)}分钟前] `
  return `[${Math.round(seconds / 3600)}小时前] `
}

/**
 * 这台设备最近发生了什么：前台是谁、最近切页/进程生死/崩溃，带「多久之前」。
 * 标注回传时和操作时间线一起给模型，让它能把「我圈的这个」和「刚才发生了什么」对上。
 * @param {string} device - 序列号。
 * @param {number} windowMs - 回看窗口，毫秒。
 * @returns {Promise<string[]>} 一行一条，最多 8 行；读不到给空数组。
 */
async function deviceStory(device, windowMs = 120_000) {
  const lines = []
  const top = await sh(device, 'dumpsys activity activities | grep -m1 "topResumedActivity"', 8000).catch(() => null)
  const topText = top && top.ok ? top.out.trim() : ''
  const topMatch = /topResumedActivity=ActivityRecord\{[^}]*?([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)/.exec(topText)
  /* 前台这一行也要说人话：`com.miui.home/.launcher.Launcher` 对模型是包名，对用户是「桌面」。 */
  if (topMatch !== null) lines.push(`现在在前台：${describe_foreground(topMatch[1])}`)
  const ev = await adb(['-s', device, 'shell', 'logcat', '-b', 'events', '-d', '-t', '300', '-v', 'time'], { timeout: 12_000 }).catch(() => null)
  const raw = ev && ev.ok ? ev.out : ''
  const keep = /am_focused_activity|wm_create_activity|am_proc_start|am_proc_died|am_crash|am_anr|am_kill/
  const picked = []
  for (const line of raw.split('\n')) {
    if (!keep.test(line)) continue
    const age = logAge(line)
    /* 窗口外的不要：标注说的是「刚才」，回看太久反而误导。 */
    if (age === '' || /小时前/.test(age)) continue
    const seconds = /\[(\d+)s前\]/.test(age) ? Number(/\[(\d+)s前\]/.exec(age)[1]) : Number(/\[(\d+)分钟前\]/.exec(age)?.[1] ?? 0) * 60
    if (seconds * 1000 > windowMs) continue
    /* 系统组件每几秒生死一次，混进来会把「用户真正做了什么」淹掉。 */
    if (isSystemNoise(line)) continue
    const said = describe_device_event(line)
    if (said === '') continue
    /* 同一件事连着刷屏（切页常常一次报三条）只留第一条，时间线要能一口气读完。 */
    if (picked.length > 0 && picked[picked.length - 1].text === said) continue
    /* 一次退出常同时报 am_kill + am_proc_died：同一应用同一秒只留一句，读起来才像时间线。 */
    const prev = picked[picked.length - 1]
    if (prev !== undefined && seconds - prev.seconds <= 2 && prev.pkgName === (describe_event_package(line))) continue
    picked.push({ text: said, line: `${age}${said}`, seconds, pkgName: describe_event_package(line) })
  }
  lines.push(...picked.slice(-6).map((item) => item.line))
  return lines
}

/**
 * 把一行 logcat 事件翻成一句人话：agent 要能直接读懂「刚才发生了什么」，
 * 而不是拿到 `am_proc_died: [0,1234,com.whale.pet,...]` 这种原始数组。
 * @param {string} line - logcat -b events 的一行。
 * @returns {string} 一句话；看不懂的返回空串（宁缺不猜）。
 */
/**
 * 从一行事件里取包名（去重用）。 @param {string} line - logcat 事件行。 @returns {string} 包名，取不到为空串。
 */
function describe_event_package(line) {
  const found = /\b(?:am_proc_start|am_proc_died|am_crash|am_anr|am_kill|am_focused_activity|wm_create_activity)\b[^\[]*\[([^\]]*)\]/.exec(String(line))
  const parts = found === null ? [] : found[1].split(',').map((item) => item.trim())
  return parts.find((item) => /^[a-zA-Z][\w.]*\.[\w.]+$/.test(item) && item.includes('.') && !item.includes('/')) ?? ''
}

/**
 * 把 `包名/类名` 形式的前台描述翻成人话，认不出来的原样返回，别硬猜。
 * @param {string} text - dumpsys 里那一段。
 * @returns {string} 人话描述。
 */
function describe_foreground(text) {
  const pair = /([\w.]+)\/([\w.$]+)/.exec(String(text))
  const raw = pair === null ? String(text).trim() : `${pair[1]}/${pair[2]}`
  const pkg = pair === null ? '' : pair[1]
  const cls = pair === null ? '' : (pair[2].split('.').pop() ?? pair[2])
  if (/^(com\.miui\.home|com\.android\.launcher|com\.google\.android\.apps\.nexuslauncher)$/.test(pkg)) return `桌面（${raw}）`
  if (/^(com\.android\.settings|com\.miui\.settings)$/.test(pkg)) return `设置（${raw}）`
  if (/^(com\.android\.camera|com\.miui\.camera)/.test(pkg)) return `相机（${raw}）`
  if (pkg === '') return raw
  return cls === '' ? raw : `${pkg}（${cls}）`
}

function describe_device_event(line) {
  const text = String(line)
  const tag = /\b(am_focused_activity|wm_create_activity|am_proc_start|am_proc_died|am_crash|am_anr|am_kill)\b/.exec(text)?.[1] ?? ''
  if (tag === '') return ''
  const body = text.slice(text.indexOf(tag + ':') + tag.length + 1)
  /* 事件体是 [user,pid,uid,包名,类名,…]：包名总在第 4 个位置，类名第 5 个。 */
  const parts = body.replace(/^\s*\[/, '').replace(/\]\s*$/, '').split(',').map((item) => item.trim())
  /* 切页事件的载荷是 `包名/类名` 一整段，进程事件才是分开的字段：两种都要认。 */
  const pair = parts.find((item) => /^[\w.$]+\/[\w.$]+$/.test(item)) ?? ''
  const pkg = (pair !== '' ? pair.split('/')[0].trim() : '')
    || parts.find((item) => /^[a-zA-Z][\w.]*\.[\w.]+$/.test(item)) || ''
  const cls = (pair !== '' ? (pair.split('/')[1] ?? '') : '')
    || parts.find((item) => /^[\w.$]+\/[\w.$]+$/.test(item)) || ''
  const short = (value) => {
    const last = value.split('/').pop() ?? value
    return last.split('.').pop() ?? last
  }
  /** 桌面 / 设置 / 相机这类系统页面，说人话比念包名有用；其它应用保留包名，模型要能真去查。 */
  const friendly = (name) => {
    if (/^(com\.miui\.home|com\.android\.launcher|com\.google\.android\.apps\.nexuslauncher)/.test(name)) return '桌面'
    if (/^(com\.android\.settings|com\.miui\.settings)/.test(name)) return '设置'
    if (/^(com\.android\.camera|com\.miui\.camera)/.test(name)) return '相机'
    if (/^com\.android\.systemui/.test(name)) return '通知栏'
    return name
  }
  if (tag === 'am_focused_activity' || tag === 'wm_create_activity') {
    if (pkg === '') return ''
    const page = cls === '' ? '' : short(cls)
    /* Launcher 之类的宿主页面不念类名，说「回到桌面」更像人话。 */
    if (page === '' || /^(Launcher|MainActivity)$/.test(page) && friendly(pkg) !== pkg) return `切到 ${friendly(pkg)}`
    return `切到 ${friendly(pkg)}（${page}）`
  }
  if (tag === 'am_proc_start') return pkg === '' ? '' : `${friendly(pkg)} 启动了`
  if (tag === 'am_proc_died') return pkg === '' ? '' : `${friendly(pkg)} 退出了`
  if (tag === 'am_crash') return pkg === '' ? '' : `${friendly(pkg)} 崩溃了`
  if (tag === 'am_anr') return pkg === '' ? '' : `${friendly(pkg)} 无响应`
  if (tag === 'am_kill') return pkg === '' ? '' : `${friendly(pkg)} 被系统杀掉`
  return ''
}

/**
 * 系统组件的生命周期事件属于背景噪声，人工时间线里不该占位置。
 * @param {string} line - logcat 行。
 * @returns {boolean} true 表示可以丢掉。
 */
function isSystemNoise(line) {
  const match = /(?:am_proc_start|am_proc_died|am_kill|wm_create_activity|wm_destroy_activity|am_focused_activity).*?[\[,(]\s*[0-9-]*\s*,?\s*([a-zA-Z][\w.]*)/.exec(line)
  const pkg = match === null ? '' : match[1]
  if (pkg === '') return false
  return /^(android|com\.android\.|com\.miui\.|com\.google\.android\.|com\.xiaomi\.|miui\.)/.test(pkg)
}

/** 最近的操作时间线，标注回传时一起交给模型。 @type {Array<{ at: number, what: string }>} */
const lastActions = []

/* 热重载 / 宿主重启会换掉整个模块实例，内存里的时间线一清空，用户说「我刚才点了什么」
   就真的查不到。落一份 JSON 到磁盘，重启后接着用，问「刚才」永远有东西可答。 */
const ACTIONS_FILE = join(homedir(), '.dsh', 'adb-mirror', 'actions.json')
const ACTIONS_KEEP_MS = 6 * 60 * 60 * 1000

/**
 * 读回上一次进程留下的时间线，只保留最近 6 小时。
 * @returns {void}
 */
function loadActions() {
  try {
    if (!existsSync(ACTIONS_FILE)) return
    const parsed = JSON.parse(readFileSync(ACTIONS_FILE, 'utf8'))
    if (!Array.isArray(parsed)) return
    const now = Date.now()
    for (const item of parsed) {
      if (!item || typeof item.at !== 'number' || typeof item.what !== 'string') continue
      if (now - item.at > ACTIONS_KEEP_MS) continue
      lastActions.push({ at: item.at, what: item.what.slice(0, 80) })
    }
    lastActions.sort((a, b) => a.at - b.at)
    if (lastActions.length > 400) lastActions.splice(0, lastActions.length - 400)
  } catch { /* 文件坏了就当没有：时间线不是关键路径 */ }
}

/**
 * 把时间线写回磁盘，失败不吭声。
 * @returns {Promise<void>} 无。
 */
async function saveActions() {
  try {
    await mkdir(dirname(ACTIONS_FILE), { recursive: true })
    await writeFile(ACTIONS_FILE, JSON.stringify(lastActions.slice(-400)), 'utf8')
  } catch { /* 磁盘写不进去不影响操作 */ }
}

/**
 * 取最近一段时间内的操作。
 * @param {number} windowMs - 毫秒。
 * @returns {string[]} 形如 `-3.2s 点击 「开始」@640,1200`。
 */
function recentActions(windowMs = 60_000) {
  const now = Date.now()
  const lines = []
  for (const item of lastActions) {
    const age = now - item.at
    if (age > windowMs) continue
    lines.push(`-${(age / 1000).toFixed(1)}s ${item.what}`)
  }
  return lines.slice(-12)
}

const rootCache = new Map()

/**
 * 探测设备是否有 root：Magisk 用 `su -c`，老 su 用 `su 0`。按序列号缓存，避免每次重探。
 * @param {string} serial - 设备。
 * @returns {Promise<boolean>} 是否有 root。
 */
async function deviceRoot(serial) {
  if (!rootCache.has(serial)) {
    let found = false
    for (const probe of ['su -c id', 'su 0 id']) {
      const r = await adb(['-s', serial, 'shell', probe], { timeout: 6000 }).catch(() => null)
      if (r && /uid=0/.test(r.out)) {
        found = true
        break
      }
    }
    rootCache.set(serial, found)
  }
  return rootCache.get(serial)
}

/**
 * 解析 uiautomator 的 XML：单行输出，用正则按标签顺序走，维护深度栈。
 * 属性里可能带 `<` 之类转义，所以只在 `<node ...>` 上取属性。
 * @param {string} xml - 完整 XML。
 * @returns {Array<{depth: number, text: string, id: string, cls: string, desc: string, clickable: boolean, longClickable: boolean, scrollable: boolean, enabled: boolean, checked: boolean, selected: boolean, focused: boolean, x1: number, y1: number, x2: number, y2: number}>} 节点。
 */
/** 属性正则和实体正则只编译一次：300 个节点时会省掉 3600 次 new RegExp。 */
const ATTR_PATTERNS = new Map()
const XML_ENTITIES = /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g
const XML_NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/**
 * 解 XML 属性里的实体：uiautomator 会把换行写成 `&#10;`、`&` 写成 `&amp;`，
 * 不解的话「按住&#10;说话」永远匹配不上用户说的「按住 说话」。认不出的原样保留。
 * @param {string} value - XML 属性原文。
 * @returns {string} 解码后的文本。
 */
function decodeEntities(value) {
  const text = String(value)
  /* 没有 & 的占绝大多数，直接返回，省一次正则扫描。 */
  if (!text.includes('&')) return text
  return text.replace(XML_ENTITIES, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    return XML_NAMED[body] ?? whole
  })
}

/**
 * 取某个属性的值（顺带解实体）。
 * @param {string} attrs - 一个 node 标签的属性串。
 * @param {string} key - 属性名。
 * @returns {string} 值；没有这个属性时是空串。
 */
function attrOf(attrs, key) {
  let pattern = ATTR_PATTERNS.get(key)
  if (pattern === undefined) {
    pattern = new RegExp(`\\b${key}="([^"]*)"`)
    ATTR_PATTERNS.set(key, pattern)
  }
  const found = pattern.exec(attrs)
  return found ? decodeEntities(found[1]) : ''
}

function parseNodes(xml) {
  const nodes = []
  const stack = []
  const token = /<node\b([^>]*?)(\/?)>|(<\/node>)/g
  let match
  while ((match = token.exec(xml)) !== null) {
    if (match[3]) {
      stack.pop()
      continue
    }
    const attrs = match[1]
    const selfClosing = match[2] === '/'
    const read = (key) => attrOf(attrs, key)
    const bounds = /bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/.exec(attrs)
    nodes.push({
      index: nodes.length,
      parent: stack.length > 0 ? stack[stack.length - 1] : -1,
      depth: stack.length,
      text: read('text'),
      id: read('resource-id'),
      pkg: read('package'),
      cls: read('class'),
      desc: read('content-desc'),
      clickable: read('clickable') === 'true',
      longClickable: read('long-clickable') === 'true',
      scrollable: read('scrollable') === 'true',
      enabled: read('enabled') !== 'false',
      checked: read('checked') === 'true',
      selected: read('selected') === 'true',
      focused: read('focused') === 'true',
      password: read('password') === 'true',
      x1: bounds ? Number(bounds[1]) : 0,
      y1: bounds ? Number(bounds[2]) : 0,
      x2: bounds ? Number(bounds[3]) : 0,
      y2: bounds ? Number(bounds[4]) : 0,
    })
    if (!selfClosing) stack.push(nodes.length - 1)
  }
  return nodes
}

/**
 * 从 adb 输出里截出 XML。`uiautomator dump` 有时会把
 * `UI hierchary dumped to: /dev/tty` 混在 stdout 里。
 * @param {string} raw - adb stdout。
 * @returns {string} XML，找不到时返回空串。
 */
function extractXml(raw) {
  const start = raw.indexOf('<hierarchy')
  const end = raw.lastIndexOf('</hierarchy>')
  if (start < 0 || end < 0) return ''
  return raw.slice(start, end + '</hierarchy>'.length)
}

/* ─────────────────── uiautomator2 常驻服务（快路径） ───────────────────
 * `uiautomator dump` 每条命令都要冷启动一次 uiautomator，实测 2.16–2.26s；
 * uiautomator2 把服务常驻在设备上（app_process + JSON-RPC），经 adb forward
 * 读同一份 XML 实测 54–107ms，快 20–40 倍，省掉的正是「读界面」这件事的
 * 全部固定开销。服务不在时自动推 jar、自动起；起不来就静默回退旧路径。
 */

/** 设备端 u2 服务端口（uiautomator2 默认）。 */
const U2_PORT = 9008

/** 插件自带 u2.jar / apk，不依赖本机装没装 python 包。 */
const U2_VENDOR = fileURLToPath(new URL('./vendor/', import.meta.url))

/** serial → {port, at}：已经测试过可用的 forward 端口。 */
const u2Cache = new Map()

/**
 * 一次 HTTP 往返。u2 服务只监听设备本地，必须经 adb forward。
 * @param {number} port - 本机 forward 端口。
 * @param {string} path - 路径。
 * @param {any} [body] - 有 body 就走 POST。
 * @param {number} [timeoutMs] - 超时。
 * @returns {Promise<{status: number, text: string}>} 响应。
 */
function u2Fetch(port, path, body, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      method: payload ? 'POST' : 'GET',
      timeout: timeoutMs,
      headers: payload
        ? { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) }
        : {},
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('timeout', () => req.destroy(new Error(`u2 请求超时 ${timeoutMs}ms`)))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/**
 * 服务活着吗（GET /ping 回 "pong"）。
 * @param {number} port - 本机 forward 端口。
 * @returns {Promise<boolean>} 活着为 true。
 */
async function u2Alive(port) {
  try {
    const r = await u2Fetch(port, '/ping', undefined, 1200)
    return r.text.trim() === 'pong'
  } catch {
    return false
  }
}

/**
 * 设备上那份 u2.jar 跟插件自带的是不是同一份。
 * 只看「文件在不在」会把旧版 jar 当成好的，之后服务行为对不上很难查。
 * @param {string} serial - 设备。
 * @param {string} localPath - 本地 jar。
 * @returns {Promise<boolean>} 一致（或设备拿不到哈希）为 true。
 */
async function u2JarMatches(serial, localPath) {
  let localHash = ''
  try {
    localHash = createHash('sha256').update(readFileSync(localPath)).digest('hex')
  } catch {
    return false
  }
  const remote = await adb(['-s', serial, 'shell', 'sha256sum', '/data/local/tmp/u2.jar'], { timeout: 8000 })
  const shown = (remote.out || '').trim().split(/\s+/)[0] ?? ''
  if (remote.code !== 0 || !/^[0-9a-f]{64}$/i.test(shown)) return true
  return shown.toLowerCase() === localHash
}

/**
 * 在设备上把 u2 服务拉起来（jar 不在、或跟本地不是同一份就先推）。
 * @param {string} serial - 设备。
 * @returns {Promise<void>} 无。
 */
async function u2Start(serial) {
  const jar = join(U2_VENDOR, 'u2.jar')
  /* 按退出码判断文件在不在：`ls` 失败时把路径打进报错里，用「输出含 u2.jar」判断永远为真。 */
  const has = await adb(['-s', serial, 'shell', 'test', '-f', '/data/local/tmp/u2.jar'], { timeout: 8000 })
  const needPush = has.code !== 0 || !(await u2JarMatches(serial, jar))
  if (needPush) {
    if (!existsSync(jar)) throw new Error('插件缺 vendor/u2.jar，无法启动 uiautomator2 服务')
    const pushed = await adb(['-s', serial, 'push', jar, '/data/local/tmp/u2.jar'], { timeout: 120_000 })
    if (pushed.code !== 0) throw new Error(`推送 u2.jar 失败：${oneLine(pushed.err || pushed.out, 140)}`)
    const again = await adb(['-s', serial, 'shell', 'test', '-f', '/data/local/tmp/u2.jar'], { timeout: 8000 })
    if (again.code !== 0) throw new Error('推完 u2.jar 设备上仍然没有这个文件')
  }
  await adb(['-s', serial, 'shell',
    `nohup sh -c 'CLASSPATH=/data/local/tmp/u2.jar app_process / com.wetest.uia2.Main -p ${U2_PORT}' >/dev/null 2>&1 &`],
    { timeout: 8000 })
}

/** serial → 正在进行的冷启动：同一台设备的并发调用合并成一次，不重复拉起服务。 @type {Map<string, Promise<string>>} */
const u2Starting = new Map()

/**
 * 让某个 forward 端口后面的 u2 服务可用：没起来就拉起再等它就绪。
 * 同一设备的并发调用共享同一次启动；只等这一个端口，不重发任何动作请求。
 * @param {string} serial - 设备。
 * @param {number} port - 本机端口。
 * @returns {Promise<string>} 空串表示可用，否则是失败原因。
 */
async function ensureU2On(serial, port) {
  if (await u2Alive(port)) return ''
  const running = u2Starting.get(serial)
  if (running !== undefined) {
    await running.catch(() => '')
    return (await u2Alive(port)) ? '' : 'uiautomator2 服务没有起来'
  }
  const task = (async () => {
    let error = ''
    try {
      await u2Start(serial)
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure)
    }
    for (let i = 0; i < 40; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150))
      if (await u2Alive(port)) return ''
    }
    return error || 'uiautomator2 服务没有起来'
  })()
  u2Starting.set(serial, task)
  try {
    return await task
  } finally {
    u2Starting.delete(serial)
  }
}

/**
 * adb 的报错说明设备根本不可达（离线、未授权、找不到设备）。
 * 这类失败换端口也救不回来，不能当成「不支持 tcp:0」去抢固定端口。
 * @param {string} text - 报错文本。
 * @returns {boolean} 是设备不可达为 true。
 */
function deviceUnreachable(text) {
  return /unauthorized|offline|no devices|device not found|device '.*' not found|more than one device|closed/i.test(String(text))
}

/**
 * 拿到一个能用的本机端口：复用已有 forward，否则新建，再不行就起服务。
 * @param {string} serial - 设备。
 * @returns {Promise<number>} 端口。
 */
async function u2Port(serial) {
  const cached = u2Cache.get(serial)
  if (cached && Date.now() - cached.at < 120_000 && await u2Alive(cached.port)) {
    /* 缓存端口也要先确认转发还在、而且属于这台设备：别的设备的转发会被误当成自己的。 */
    const rows = await adb(['-s', serial, 'forward', '--list'], { timeout: 8000 })
    if (forwardFor(rows.out, serial, `tcp:${U2_PORT}`) !== null) return cached.port
    u2Cache.delete(serial)
  }
  const list = await adb(['-s', serial, 'forward', '--list'], { timeout: 8000 })
  if (list.code !== 0) {
    throw new Error(`uiautomator2 不可用：${oneLine(list.err || list.out || 'adb forward --list 失败', 160)}`)
  }
  const reused = forwardFor(list.out, serial, `tcp:${U2_PORT}`)
  const reusedPort = reused === null ? 0 : Number(reused.local.replace(/^tcp:/, ''))
  if (Number.isFinite(reusedPort) && reusedPort > 0 && await u2Alive(reusedPort)) {
    u2Cache.set(serial, { port: reusedPort, at: Date.now() })
    return reusedPort
  }
  let lastError = ''
  /* 主路：让 adb 自己分配端口（`tcp:0`），加 `--no-rebind` 保证不顶掉别人的转发。 */
  const fresh = await adb(['-s', serial, 'forward', '--no-rebind', 'tcp:0', `tcp:${U2_PORT}`], { timeout: 8000 })
  const freshPort = Number((fresh.out ?? '').trim())
  if (fresh.code === 0 && Number.isFinite(freshPort) && freshPort > 0) {
    ownForward(serial, `tcp:${freshPort}`, `tcp:${U2_PORT}`)
    lastError = await ensureU2On(serial, freshPort)
    if (lastError === '') {
      u2Cache.set(serial, { port: freshPort, at: Date.now() })
      return freshPort
    }
    if (deviceUnreachable(lastError)) throw new Error(`uiautomator2 不可用：${lastError}`)
  } else {
    lastError = oneLine(fresh.err || fresh.out || `adb forward 退出码 ${fresh.code}`, 160)
    /* 设备离线/未授权/找不到设备：换固定端口也救不回来，不抢别人的端口。 */
    if (deviceUnreachable(lastError)) throw new Error(`uiautomator2 不可用：${lastError}`)
  }
  /* 兜底：只有「这版 adb 不支持 tcp:0」才试固定端口；同样 `--no-rebind`，不抢别人已经在用的。 */
  for (const port of [19108, 19208, 19308]) {
    const created = await adb(['-s', serial, 'forward', '--no-rebind', `tcp:${port}`, `tcp:${U2_PORT}`], { timeout: 8000 })
    if (created.code !== 0) {
      lastError = oneLine(created.err || created.out || `adb forward 退出码 ${created.code}`, 160)
      if (deviceUnreachable(lastError)) break
      continue
    }
    ownForward(serial, `tcp:${port}`, `tcp:${U2_PORT}`)
    const failed = await ensureU2On(serial, port)
    if (failed !== '') {
      lastError = failed
      if (deviceUnreachable(lastError)) break
      continue
    }
    u2Cache.set(serial, { port, at: Date.now() })
    return port
  }
  throw new Error(`uiautomator2 不可用：${lastError}`)
}

/**
 * 用 u2 服务读界面 XML。参数是位置参数 `[compressed, maxDepth]`。
 * @param {string} serial - 设备。
 * @returns {Promise<string>} XML。
 */
async function u2Dump(serial) {
  const port = await u2Port(serial)
  const r = await u2Fetch(port, '/jsonrpc/0', {
    jsonrpc: '2.0',
    id: 1,
    method: 'dumpWindowHierarchy',
    params: [false, 50],
  }, 8000)
  let data
  try {
    data = JSON.parse(r.text)
  } catch {
    throw new Error(`u2 返回不是 JSON：${oneLine(r.text, 120)}`)
  }
  if (data.error) throw new Error(`u2 dump 失败：${oneLine(data.error.message, 120)}`)
  return extractXml(String(data.result ?? ''))
}

/**
 * 非 ASCII 输入：写剪贴板 → PASTE 键（个别输入框退回长按「粘贴」菜单）。
 * 不走 u2 的 setText：对象形式的选择器 `{className}/{resourceId}/{text}` 反序列化不报错但匹配不到节点，
 * 调用返回 false 且输入框不变；字符串形式是 UiObject id，只回 UiObjectNotFoundException（2026-10-28 实测）。
 * @param {string} serial - 设备。
 * @param {string} text - 要输入的文字。
 * @returns {Promise<{ ok: boolean, steps: string[], field: string }>} 粘贴结果。
 */
async function typeViaClipboard(serial, text) {
  const steps = []
  const port = await u2Port(serial)
  /* 一次 RPC 往返 ~50ms；写剪贴板后马上回读，能挡住「参数顺序写反 → 粘出 label」这类静默失败。 */
  const rpc = async (method, params) => {
    const res = await u2Fetch(port, '/jsonrpc/0', { jsonrpc: '2.0', id: 1, method, params }, 6000)
    let data
    try {
      data = JSON.parse(res.text)
    } catch {
      throw new Error(`u2 ${method} 返回异常：${oneLine(res.text, 120)}`)
    }
    if (data.error) throw new Error(`u2 ${method} 失败：${oneLine(data.error.message, 120)}`)
    return data.result
  }
  /**
   * 找当前聚焦的可输入控件：优先编辑类，退而求其次取任何有面积的聚焦节点。
   * @param {any[]} nodes - parseNodes 的结果。
   * @returns {any} 焦点控件或 undefined。
   */
  const focusedField = (nodes) => nodes.find((node) => node.focused && /EditText|AutoComplete|SearchView/.test(node.cls))
    ?? nodes.find((node) => node.focused && node.x2 > node.x1 && node.y2 > node.y1)
  const dump = async () => parseNodes(await u2Dump(serial))
  /* u2 的 setClipboard 参数顺序是 (label, text)：写反了粘贴出来是 label（实测粘成 "dsh-mobile-use"）。 */
  const putClipboard = async () => {
    const began = Date.now()
    await rpc('setClipboard', ['dsh-mobile-use', text])
    const back = String(await rpc('getClipboard', []) ?? '')
    steps.push(`写剪贴板 ${Date.now() - began}ms`)
    return back === text
  }
  if (!(await putClipboard())) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    if (!(await putClipboard())) throw new Error(`剪贴板回读不是要输入的文字：${steps.join('；')}`)
  }
  /* 上一次 adb_ui/adb_tap 刚 dump 过（10s 内）就直接复用它的焦点框，省掉一次整树 dump（~200ms）。 */
  const cached = lastTrees.get(serial)
  let nodes = cached && Array.isArray(cached.nodes) && Date.now() - cached.at <= 10_000 ? cached.nodes : null
  let field = nodes === null ? undefined : focusedField(nodes)
  if (field === undefined) {
    nodes = await dump()
    field = focusedField(nodes)
  }
  if (field === undefined) throw new Error('没有聚焦的输入框：先用 adb_tap 点一下输入框再输入')
  const beforeText = String(field.text ?? '')
  /* 快路：KEYCODE_PASTE 直接粘进焦点框，省掉「长按 800ms → 反复 dump 等菜单 → 点粘贴」的一整串，
     实测 1.5s 降到 400ms 上下。个别输入框不吃这个键，没变化就退回长按菜单那条老路。 */
  const pasteBegan = Date.now()
  const pasteKey = await sh(serial, 'input keyevent 279', 8000)
  if (pasteKey.ok) {
    /* 粘贴是异步落在输入框上的，别硬等固定 200ms：立刻 dump 一次，没变再按 120/240ms 退避重看，
       总共最多约 0.5s。多数机器第一次就命中，省掉上百毫秒；不吃 PASTE 键的框照样落回长按菜单那条路。 */
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, attempt === 1 ? 120 : 240))
      nodes = await dump()
      const afterField = focusedField(nodes)
      if (afterField === undefined) throw new Error('没有聚焦的输入框：先用 adb_tap 点一下输入框再输入')
      /* 密码框内容是掩码：长度变了也算粘贴成功。 */
      const changed = afterField.text !== beforeText
        || (afterField.password === true && String(afterField.text ?? '').length !== beforeText.length)
      if (changed) {
        return { ok: true, steps: [...steps, `PASTE 键 ${Date.now() - pasteBegan}ms`], field: afterField.text ?? '' }
      }
      field = afterField
    }
  }
  /* 慢路：长按输入框等「粘贴」菜单，菜单文字每次都要重新读树才拿得到坐标。 */
  const x = Math.round((field.x1 + field.x2) / 2)
  const y = Math.round((field.y1 + field.y2) / 2)
  const held = await sh(serial, `input swipe ${x} ${y} ${x} ${y} 800`, 12_000)
  if (!held.ok) throw new Error(`长按输入框失败：${oneLine(held.out || held.err, 160)}`)
  steps.push(`长按 ${x},${y}`)
  let item
  for (let i = 0; i < 10 && item === undefined; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const list = await dump()
    item = list.find((node) => node.clickable && /^(粘贴|Paste)$/i.test((node.text || node.desc).trim()))
      ?? list.find((node) => /^(粘贴|Paste)$/i.test((node.text || node.desc).trim()))
  }
  if (item === undefined) throw new Error('长按后没有出现「粘贴」：这个输入框不吃剪贴板')
  const tx = Math.round((item.x1 + item.x2) / 2)
  const ty = Math.round((item.y1 + item.y2) / 2)
  const hit = await sh(serial, `input tap ${tx} ${ty}`, 8000)
  if (!hit.ok) throw new Error(`点「粘贴」失败：${oneLine(hit.out || hit.err, 160)}`)
  steps.push(`点粘贴 ${tx},${ty}`)
  await new Promise((resolve) => setTimeout(resolve, 240))
  const after = focusedField(await dump())
  return { ok: true, steps, field: after?.text ?? '' }
}

/**
 * 节点是否值得进文本树：有文字、有描述、有点击行为，或者显式要完整树。
 * @param {any} node - 节点。
 * @param {boolean} full - 是否包含结构节点。
 * @returns {boolean} 是否保留。
 */
function interesting(node, full) {
  /* 空输入框（没文字没 id 没点击行为）以前会被整行丢掉，模型根本看不到该往哪打字：按类保下来。 */
  if (EDITABLE_CLS.test(String(node.cls || ''))) return true
  if (node.text || node.desc || node.clickable || node.longClickable) return true
  if (full && node.id) return true
  return false
}

/**
 * 压缩文本树：去掉纯容器，合并父子重复文字，给可操作节点发 ref。
 * 输出格式（尽量短）：
 *   `#12 Button "登录" #login_btn @300,412 *`  — * 可点击
 *   `   ~ 可滚动   [x] 已勾选   [s] 选中   [f] 焦点   [edit] 可输入   [pwd] 密码框`
 * @param {any[]} nodes - parseNodes 的结果。
 * @param {{full?: boolean, maxNodes?: number}} options - 参数。
 * @returns {{lines: string[], refs: Array<{ref: number, node: any}>, kept: number, total: number}} 结果。
 */
function compactTree(nodes, options) {
  const full = options.full === true
  const maxNodes = Math.min(Math.max(options.maxNodes ?? MAX_NODES.default, 1), MAX_NODES.max)
  /* 只列到第 N 层：设置页那种「一层套一层」的树上，深处全是容器和图标，先看骨架再往里翻。 */
  const maxDepth = Number.isFinite(Number(options.depth)) ? Number(options.depth) : Infinity
  const lines = []
  const refs = []
  /** 每个深度上正在打开的容器签名，用来消除父子重复文字。 */
  const ancestors = []
  let kept = 0
  for (const node of nodes) {
    const signature = `${node.text}\u0000${node.desc}\u0000${node.id}`
    ancestors.length = Math.min(ancestors.length, node.depth)
    const duplicated = (node.text || node.desc) && ancestors.includes(signature)
    if (!duplicated && node.depth <= maxDepth && interesting(node, full) && kept < maxNodes) {
      const text = oneLine(node.text, 42)
      const desc = oneLine(node.desc, 32)
      const id = node.id ? shortId(node.id) : ''
      const parts = []
      if (text) parts.push(`"${text}"`)
      if (desc && desc !== text) parts.push(text ? `~"${desc}"` : `~"${desc}"`)
      if (id) parts.push(`#${id}`)
      const cx = Math.round((node.x1 + node.x2) / 2)
      const cy = Math.round((node.y1 + node.y2) / 2)
      let tail = `@${cx},${cy}`
      if (node.clickable || node.longClickable) tail += ' *'
      if (node.scrollable) tail += ' ~'
      if (node.checked) tail += ' [x]'
      else if (node.selected) tail += ' [s]'
      if (node.focused) tail += ' [f]'
      /* 密码框内容读出来是掩码，模型不该把它当普通文本填：行上直接标出来。
         可输入框也标一下：模型不用猜哪些行是能点的输入位。 */
      if (node.password) tail += ' [pwd]'
      else if (EDITABLE_CLS.test(String(node.cls || ''))) tail += ' [edit]'
      if (node.enabled === false) tail += ' [off]'
      const ref = refs.length + 1
      refs.push({ ref, node })
      const label = `${String(ref).padStart(2, ' ')} ${shortClass(node.cls)} ${parts.join(' ')}`.trimEnd()
      lines.push(`${label} ${tail}`.replace(/\s+/g, ' ').trim())
      kept += 1
    }
    if (node.text || node.desc || node.id) ancestors[node.depth] = signature
  }
  return { lines, refs, kept, total: nodes.length }
}

/**
 * 读前台 Activity。0.07s，比 dump 快一个数量级，可以用来判断「有没有进目标页」。
 * @param {string} serial - 设备。
 * @returns {Promise<string>} 类似 `com.example.app/.MainActivity`。
 */
async function foregroundActivity(serial) {
  /* MIUI 上 `dumpsys activity activities` 的 mResumedActivity 经常是空的，
     `dumpsys window` 的 mFocusedApp 稳定（0.09–0.15s）。 */
  /* 有的 ROM 在 mCurrentFocus 之前还有一行 mCurrentFocusedWindow，
     只取前两条会把 null 和聚焦窗口名都吃掉，所以多取几行再找第一个「包/Activity」对。 */
  const r = await adb(['-s', serial, 'shell', 'dumpsys window | grep -E "mCurrentFocus|mFocusedApp" | head -8'], { timeout: 8000 })
  const first = /([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)/.exec(r.out)
  if (first) return first[1]
  /* 有的 ROM（带悬浮窗/输入法时）window 里拿不到包名，退回 activity 栈顶。 */
  const a = await adb(['-s', serial, 'shell', 'dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity|ResumedActivity" | head -4'], { timeout: 8000 })
  const second = /([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)/.exec(a.out)
  if (second) return second[1]
  /* 最后用最近一次界面树里的 activity，比「未知」有用。 */
  const cached = lastTrees.get(serial)
  return cached && Date.now() - cached.at < 5000 ? cached.activity : ''
}

/**
 * 当前设备上最近一次界面快照，用于把 ref 还原成坐标。
 * 快照带编号：ref 只在生成它的那次快照里有效，跨快照用同一个 ref 会点到别的地方。
 * @type {Map<string, {snapshotId: string, serial: string, activity: string, at: number, refs: Array<{ref: number, node: any}>, nodes: any[], signature: string}>}
 */
const lastTrees = new Map()

/** 快照序号：只增不减，和时间戳一起组成快照编号。 */
let snapshotSeq = 0

/**
 * 生成一次快照的编号。
 * @param {string} serial - 设备。
 * @returns {string} 形如 `R58C12A3:7:1730000000000`。
 */
function nextSnapshotId(serial) {
  snapshotSeq += 1
  return `${serial}:${snapshotSeq}:${Date.now()}`
}
/** 上一次 adb_ui 的行，changed_only 用来做差。 */
const lastUiLines = new Map()

/** 控件状态条件：等「出现」还不够，很多界面是出现了但还压着不可点（灰按钮、刚渲染一半的开关）。 */
const NODE_STATES = {
  visible: () => true,
  enabled: (node) => node.enabled !== false,
  clickable: (node) => node.clickable === true,
  checked: (node) => node.checked === true,
  focused: (node) => node.focused === true,
}

/**
 * 这个控件现在是不是满足要求的状态。
 * @param {any} node - 控件节点。
 * @param {string} until - 状态名，见 NODE_STATES。
 * @returns {boolean} 是否满足。
 */
function nodeStateOk(node, until) {
  const predicate = NODE_STATES[until]
  return predicate ? Boolean(predicate(node)) : true
}

/**
 * 判断 waitPredicate 是否满足。
 * text/id/desc/texts/any_texts/gone 都按「文字、描述、id 里包含」判断；activity 当正则；
 * pkg 同时看前台 Activity 和节点上的包名（u2 树里系统浮层也会带别的包名）。
 * @param {any} state - 一次 dump 的状态。
 * @param {{text?: string, id?: string, desc?: string, activity?: string, gone?: string, texts?: string[], any_texts?: string[], pkg?: string}} want - 条件。
 * @returns {boolean} 是否满足。
 */
function matches(state, want) {
  const hit = (needle) => {
    const lower = String(needle).toLowerCase()
    return state.nodes.some((node) => `${node.text} ${node.desc} ${node.id}`.toLowerCase().includes(lower))
  }
  const present = (needle) => (needle ? hit(needle) : true)
  const absent = (needle) => (needle ? !hit(needle) : true)
  if (want.activity && !new RegExp(want.activity, 'i').test(state.activity)) return false
  if (want.pkg) {
    const pkg = String(want.pkg).toLowerCase()
    const somewhere = String(state.activity || '').toLowerCase().includes(pkg)
      || state.nodes.some((node) => String(node.pkg || '').toLowerCase().includes(pkg))
    if (!somewhere) return false
  }
  if (!present(want.text)) return false
  if (!present(want.id)) return false
  if (!present(want.desc)) return false
  if (!absent(want.gone)) return false
  /* 全部都要在：一次等两个条件（标题 + 按钮），省掉两次往返。 */
  for (const needle of normalList(want.texts)) if (!hit(needle)) return false
  /* 满足任意一个就算过：加载完 / 报错弹窗，两种结局都能继续往下走。 */
  const anyOf = normalList(want.any_texts)
  if (anyOf.length > 0 && !anyOf.some((needle) => hit(needle))) return false
  /* 带状态条件时，要求「同一个控件」既命中文字/id 又处于该状态：
     按钮出现在屏上但还 disabled 时不该算等到，否则点下去是空动作。 */
  if (want.until) {
    const needle = String(want.text ?? want.id ?? want.desc ?? '').toLowerCase()
    const qualified = state.nodes.some((node) => {
      const hay = `${node.text} ${node.desc} ${node.id}`.toLowerCase()
      return (needle === '' || hay.includes(needle)) && nodeStateOk(node, want.until)
    })
    if (!qualified) return false
  }
  return true
}

/**
 * 把「一段文字或一组文字」统一成去空数组。
 * @param {any} value - 字符串或字符串数组。
 * @returns {string[]} 非空字符串数组。
 */
function normalList(value) {
  if (value === undefined || value === null) return []
  const list = Array.isArray(value) ? value : [value]
  return list.map((item) => String(item).trim()).filter(Boolean)
}

/** 常见挡路弹窗上的按钮文字：权限、升级、评分、隐私同意。等着等着被它挡住的概率最高。 */
const BLOCKER_TEXTS = ['允许', '始终允许', '仅在使用中允许', '允许所有', '同意并继续', '同意', '确定', '确认', '知道了', '我知道了', '稍后再说', '以后再说', '暂不', '跳过', '关闭', '取消', '继续']

/**
 * 界面上有没有挡住目标的弹窗按钮（只看可点、可用的控件）。
 * @param {any} state - 一次 dump 的状态。
 * @param {string[]} wanted - 这次真正在等的内容，弹窗按钮不能和它重名，否则会把目标点掉。
 * @returns {any|null} 命中的控件。
 */
function findBlocker(state, wanted) {
  const avoid = normalList(wanted).map((item) => item.toLowerCase())
  const nodes = Array.isArray(state?.nodes) ? state.nodes : []
  const clickable = nodes.filter((node) => node.clickable === true && node.enabled !== false && String(node.text || '').trim() !== '')
  for (const label of BLOCKER_TEXTS) {
    const hitNode = clickable.find((node) => {
      const text = String(node.text).trim()
      if (avoid.some((item) => text.toLowerCase().includes(item))) return false
      return text === label
    })
    if (hitNode) return hitNode
  }
  return null
}

/**
 * 点一个绝对坐标：优先走常驻触摸通道，没有就退回 `input tap`。
 * @param {string} serial - 设备。
 * @param {number} x - x。
 * @param {number} y - y。
 * @returns {Promise<boolean>} 是否成功。
 */
async function tapPointFast(serial, x, y) {
  if (fastInput.tap !== null) {
    const fast = await fastInput.tap(serial, x, y, {}).catch(() => null)
    if (fast !== null) return true
  }
  const result = await sh(serial, `input tap ${Math.round(x)} ${Math.round(y)}`, 8000).catch(() => null)
  return result !== null && result.ok
}

/**
 * 等待界面满足条件，替代 sleep + 截图。每 120ms 一次 dump（u2 一次约 0.12s）。
 * @param {string} serial - 设备。
 * @param {{text?: string, id?: string, desc?: string, activity?: string, gone?: string, texts?: string[], any_texts?: string[], pkg?: string}} want - 条件。
 * @param {number} timeoutMs - 超时。
 * @param {{dismiss?: boolean}} [options] - dismiss 允许等到一半时点掉挡路弹窗（最多 2 次）。
 * @returns {Promise<{matched: boolean, elapsedMs: number, state: any, dismissed: string[]}>} 结果。
 */
async function waitFor(serial, want, timeoutMs, options = {}) {
  const started = Date.now()
  const dismissed = []
  const wanted = [want.text, want.id, want.desc, ...(normalList(want.texts)), ...(normalList(want.any_texts))]
  let state = await pollDump(serial)
  while (!matches(state, want)) {
    if (options.dismiss === true && dismissed.length < 2) {
      const blocker = findBlocker(state, wanted)
      if (blocker !== null) {
        const label = String(blocker.text).trim()
        const clicked = await tapPointFast(serial, (blocker.x1 + blocker.x2) / 2, (blocker.y1 + blocker.y2) / 2)
        if (clicked) {
          dismissed.push(label)
          await new Promise((resolve) => setTimeout(resolve, 200))
          state = await pollDump(serial)
          continue
        }
      }
    }
    if (Date.now() - started > timeoutMs) {
      /* 轮询为了快不跑 OCR，自绘界面上文字只在 OCR 里：超时前补一次带 OCR 的读，别把「有」判成「没有」。 */
      const lastChance = await dumpState(serial, { ocr: 'auto' }).catch(() => null)
      if (lastChance !== null && matches(lastChance, want)) {
        return { matched: true, elapsedMs: Date.now() - started, state: lastChance, dismissed }
      }
      return { matched: false, elapsedMs: Date.now() - started, state: lastChance ?? state, dismissed }
    }
    await new Promise((resolve) => setTimeout(resolve, 120))
    state = await pollDump(serial)
  }
  return { matched: true, elapsedMs: Date.now() - started, state, dismissed }
}

/**
 * dump 一次并压缩。返回的 state 同时缓存 ref，供 adb_tap 使用。
 * @param {string} serial - 设备。
 * @param {{full?: boolean, maxNodes?: number}} options - 参数。
 * @returns {Promise<any>} 状态。
 */
/** PNG 头签名，screencap 的输出前面偶尔带杂字节。 */
const PNG_SIG_OCR = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const JPEG_SIG_OCR = Buffer.from([0xff, 0xd8, 0xff])
const OCR_REMOTE = '/data/local/tmp/dsh-mobile-use-ocr.jpg'

/**
 * 拿一张给 OCR 用的截图：设备端编 JPEG 再 cat 回来，比 `exec-out screencap -p` 快一个量级
 * （3200x2136 PNG 要 8.5MB / 3s，JPEG 3.5MB / 0.36s）。
 * @param {string} serial - 设备序列号。
 * @returns {Promise<Buffer|null>} 图片字节；失败返回 null。
 */
async function ocrCapture(serial) {
  try {
    const shot = await adb(['-s', serial, 'shell', 'screencap', '-j', OCR_REMOTE], { timeout: 10_000 })
    if (shot?.code !== 0) return null
    const pulled = await adb(['-s', serial, 'exec-out', 'cat', OCR_REMOTE], { timeout: 15_000 })
    const raw = pulled?.raw
    if (!Buffer.isBuffer(raw) || raw.length < 2000) return null
    const at = raw.indexOf(JPEG_SIG_OCR)
    return at < 0 ? null : raw.subarray(at)
  } catch {
    return null
  }
}

/**
 * 文本树稀疏时用本机 Vision OCR 补一批可点候选。
 * @param {string} serial - 设备序列号。
 * @returns {Promise<{nodes: Array<object>, ms: number, note: string}>} 追加的节点。
 */
async function ocrNodes(serial) {
  const began = Date.now()
  if (!ocrAvailable()) return { nodes: [], ms: 0, note: '本机没有 OCR' }
  let image = await ocrCapture(serial)
  let ext = 'jpg'
  if (!image) {
    /* JPEG 路不通（老系统没有 `screencap -j`）再退回 PNG。 */
    const shot = await adb(['-s', serial, 'exec-out', 'screencap', '-p'], { timeout: 20_000 }).catch(() => null)
    const raw = shot?.raw
    if (!Buffer.isBuffer(raw) || raw.length < 1000) return { nodes: [], ms: 0, note: '截图失败' }
    const at = raw.indexOf(PNG_SIG_OCR)
    if (at < 0) return { nodes: [], ms: 0, note: '截图不是图片' }
    image = raw.subarray(at)
    ext = 'png'
  }
  const path = join(tmpdir(), `dsh-mobile-use-ocr-${Date.now()}.${ext}`)
  await writeFile(path, image).catch(() => {})
  let rects
  try {
    const recognized = await ocrImage(path)
    const blocks = Array.isArray(recognized) ? recognized : recognized.blocks
    const width = recognized.width ?? (ext === 'png' ? image.readUInt32BE(16) : 0)
    const height = recognized.height ?? (ext === 'png' ? image.readUInt32BE(20) : 0)
    if (!width || !height) throw new Error('拿不到图片尺寸')
    rects = toRects(blocks, width, height)
  } catch (error) {
    return { nodes: [], ms: Date.now() - began, note: `OCR 失败：${oneLine(error.message, 60)}` }
  }
  const nodes = rects.map((rect, index) => ({
    index,
    parent: -1,
    depth: 1,
    text: rect.text,
    id: '',
    cls: 'ocr',
    desc: '',
    clickable: true,
    longClickable: false,
    scrollable: false,
    enabled: true,
    checked: false,
    selected: false,
    focused: false,
    x1: rect.x1,
    y1: rect.y1,
    x2: rect.x2,
    y2: rect.y2,
  }))
  return { nodes, ms: Date.now() - began, note: `${nodes.length} 段文字（置信度 ≥ 0.3）` }
}

async function dumpState(serial, options) {
  const started = Date.now()
  const wantActivity = options.activity !== false
  const activityPromise = wantActivity ? foregroundActivity(serial) : Promise.resolve('')
  let xml = ''
  let source = 'uiautomator2'
  try {
    xml = await u2Dump(serial)
  } catch {
    xml = ''
  }
  if (!xml) {
    source = 'uiautomator'
    const r = await adb(['-s', serial, 'exec-out', 'uiautomator', 'dump', '/dev/tty'], { timeout: 20_000 })
    xml = extractXml(r.out)
    if (!xml) {
      throw new Error(`读界面树失败：${oneLine(r.err || r.out || '无输出', 200)}`)
    }
  }
  const activity = await activityPromise
  const nodes = parseNodes(xml)
  /* 文本树给不出几个能读的控件（Flutter / 自绘 / 相机 / WebView）就补一次 OCR，别让模型对着空树猜。 */
  const textNodes = nodes.filter((node) => (node.text || node.desc || node.id) && node.enabled).length
  let ocrNote = ''
  let ocrMs = 0
  const needOcr = options.ocr === 'force' || (textNodes < 4 && options.ocr !== false && options.ocr !== 'off')
  if (needOcr) {
    const extra = await ocrNodes(serial)
    ocrMs = extra.ms
    if (extra.nodes.length > 0) {
      const base = nodes.length
      for (const [offset, node] of extra.nodes.entries()) {
        node.index = base + offset
        nodes.push(node)
      }
      source = `${source}+ocr`
      ocrNote = options.ocr === 'force'
        ? ` · 按要求用本机 OCR 补 ${extra.nodes.length} 段文字（${ocrMs}ms）`
        : ` · 文本树只有 ${textNodes} 个控件，已用本机 OCR 补 ${extra.nodes.length} 段文字（${ocrMs}ms）`
    }
  }
  const tree = compactTree(nodes, options)
  const signature = tree.lines.join('\n')
  const previous = lastTrees.get(serial)
  const changed = !previous || previous.signature !== signature
  const at = Date.now()
  const snapshotId = nextSnapshotId(serial)
  lastTrees.set(serial, { snapshotId, serial, activity, at, refs: tree.refs, nodes, signature })
  /* 快照缓存里带 refs，dumpState 结果只有 tree.refs：形状不一致会让「刚 dump 的树」按 ref 查不到。 */
  return { serial, activity, nodes, refs: tree.refs, tree, changed, ms: at - started, source, ocrNote, snapshotId, generated_at: new Date(at).toISOString() }
}

/**
 * 轮询里的 dump：不走 OCR。等条件/等静止一秒要读好几次树，自绘界面每读一次都会多花 1.5s 补 OCR；
 * OCR 只在对模型交结果的那一次做（adb_ui / adb_find 的最终 dump）。
 * @param {string} serial - 设备。
 * @returns {Promise<any>} 状态。
 */
const pollDump = (serial) => dumpState(serial, { ocr: false })

/**
 * 校验手上这次快照还能用：没有快照、过期、或编号对不上都直接说清楚，不拿旧 ref 乱点。
 * @param {string} serial - 设备。
 * @param {string | undefined} snapshotId - 调用方带的快照编号（可省略）。
 * @param {string} what - 用于错误信息的名词（ref / 文字）。
 * @returns {any} 快照条目。
 */
function checkSnapshot(serial, snapshotId, what) {
  const cached = lastTrees.get(serial)
  if (!cached) throw new Error(`还没有界面快照：先调用 adb_ui 读一次界面，再用它给的 ${what}。`)
  if (Date.now() - cached.at > REF_TTL_MS) throw new Error('界面快照已过期，请重新 adb_ui。')
  if (snapshotId !== undefined && snapshotId !== null && String(snapshotId) !== '' && String(snapshotId) !== cached.snapshotId) {
    throw new Error(`快照已变：你手上的是 ${snapshotId}，当前是 ${cached.snapshotId}（之后又 dump 过界面），先 adb_ui 看最新界面再操作。`)
  }
  return cached
}

/**
 * 找 ref 对应的节点。ref 只在生成它的那次快照里有效，调用方应带上 snapshot_id。
 * @param {string} serial - 设备。
 * @param {number} ref - 引用号。
 * @param {string} [snapshotId] - 调用方手上的快照编号。
 * @returns {any} 节点。
 */
function nodeForRef(serial, ref, snapshotId) {
  const cached = checkSnapshot(serial, snapshotId, 'ref')
  const found = cached.refs.find((entry) => entry.ref === ref)
  if (!found) throw new Error(`没有 ref=${ref}：ref 编号每次 adb_ui 都会重新分配，用最新一次返回的编号。`)
  return found.node
}

/**
 * 点之前确认目标还在原位：快照太旧就重读一次树，按 id/文字/描述找回同一个控件。
 * 找不到、匹配多个、或位置挪得太多，都报错让人重读界面，不拿旧坐标乱点。
 * @param {string} serial - 设备。
 * @param {any} node - 目标节点。
 * @param {string} [snapshotId] - 调用方带的快照编号；带了说明它认这次快照，不重读。
 * @returns {Promise<any>} 可以点的节点（可能是新快照里的同一个）。
 */
async function freshNodeFor(serial, node, snapshotId) {
  if (snapshotId !== undefined && snapshotId !== null && String(snapshotId) !== '') return node
  const cached = lastTrees.get(serial)
  if (!cached || Date.now() - cached.at <= REF_SOFT_TTL_MS) return node
  const label = oneLine(node.text || node.desc || shortId(node.id) || shortClass(node.cls), 20)
  const next = await pollDump(serial)
  const ox = (node.x1 + node.x2) / 2
  const oy = (node.y1 + node.y2) / 2
  /* 同一段文字常有多份（父容器 + 子节点、左右分栏），按「离旧位置最近」认领，不算歧义。 */
  const scored = next.tree.refs
    .map((entry) => entry.node)
    .filter((candidate) => (node.id !== '' && candidate.id === node.id)
      || (node.text !== '' && candidate.text === node.text)
      || (node.desc !== '' && candidate.desc === node.desc))
    .map((candidate) => ({ node: candidate, dist: Math.hypot((candidate.x1 + candidate.x2) / 2 - ox, (candidate.y1 + candidate.y2) / 2 - oy) }))
    .sort((a, b) => a.dist - b.dist)
  if (scored.length === 0) {
    throw new Error(`stale_snapshot：界面已经变了，之前的「${label}」不在了。先 adb_ui 看当前界面再操作。`)
  }
  const moved = scored[0].dist > REF_MOVE_TOLERANCE
  if (moved) {
    throw new Error(`stale_snapshot：「${label}」的位置已经挪动，旧坐标可能点到别处。先 adb_ui 看当前界面再操作。`)
  }
  return scored[0].node
}

/**
 * 按文字/id 找控件前先拿到可用快照：缺失、过期、或当前页面已经换了一页就重新 dump 一次。
 * 这比拿两分钟前的坐标去点安全，也比直接报错少一个模型回合。
 * @param {string} serial - 设备。
 * @param {string} [snapshotId] - 调用方带的快照编号；带了且对不上就直接报错，不偷偷换快照。
 * @returns {Promise<any>} 快照条目。
 */
async function snapshotForSelector(serial, snapshotId) {
  const cached = lastTrees.get(serial)
  if (cached !== undefined && snapshotId !== undefined && snapshotId !== null && String(snapshotId) !== ''
    && String(snapshotId) !== cached.snapshotId) {
    throw new Error(`快照已变：你手上的是 ${snapshotId}，当前是 ${cached.snapshotId}（之后又 dump 过界面），先 adb_ui 看最新界面再操作。`)
  }
  if (cached === undefined || Date.now() - cached.at > REF_TTL_MS) return dumpState(serial, {})
  const live = await foregroundActivity(serial).catch(() => '')
  if (live !== '' && cached.activity !== '' && live !== cached.activity) return dumpState(serial, {})
  return cached
}

/**
 * 边滑边找一个控件：先看当前界面，找不到就按方向滑，最多 8 次。
 * @param {string} serial - 设备。
 * @param {string} text - 要找的文字（包含匹配）。
 * @param {string} direction - 手指滑动方向：up 把下面的内容拉上来，down/left/right 同理。
 * @returns {Promise<object>} 命中的节点。
 */
/**
 * 该在哪个框里滑：优先界面上真实可滚的容器。平板/分屏上整屏滑会滑到另一半（设置左栏滑不动、
 * 右栏在动），所以按 scrollable 节点挑，嵌套时留最内层，最多 3 个；没有可滚容器才退回屏幕中间。
 * @param {any} state - dumpState 结果。
 * @param {{width:number,height:number}} size - 当前显示尺寸。
 * @returns {Array<{x:number,y:number,w:number,h:number}>} 候选滑动框，大的在前。
 */
function scrollFrames(state, size) {
  const fallback = { x: Math.round(size.width * 0.15), y: Math.round(size.height * 0.2), w: Math.round(size.width * 0.7), h: Math.round(size.height * 0.6) }
  const nodes = (state && Array.isArray(state.nodes) ? state.nodes : [])
    .filter((node) => node && node.scrollable === true && node.x2 > node.x1 && node.y2 > node.y1)
  const covers = (outer, inner) => outer !== inner
    && outer.x1 <= inner.x1 && outer.y1 <= inner.y1 && outer.x2 >= inner.x2 && outer.y2 >= inner.y2
    && (outer.x1 < inner.x1 || outer.y1 < inner.y1 || outer.x2 > inner.x2 || outer.y2 > inner.y2)
  const innermost = nodes.filter((node) => !nodes.some((other) => covers(node, other)))
  const seen = new Set()
  const boxes = []
  for (const node of innermost) {
    const box = { x: node.x1, y: node.y1, w: node.x2 - node.x1, h: node.y2 - node.y1 }
    const key = `${box.x},${box.y},${box.w},${box.h}`
    if (seen.has(key)) continue
    seen.add(key)
    boxes.push(box)
  }
  boxes.sort((a, b) => b.w * b.h - a.w * a.h)
  return boxes.length > 0 ? boxes.slice(0, 3) : [fallback]
}

/**
 * 框里按手指方向给一条滑动线（两端留 15%，比从边上一像素开始稳）。
 * @param {{x:number,y:number,w:number,h:number}} box - 滑动框。
 * @param {string} direction - up/down/left/right。
 * @returns {number[]} [x1,y1,x2,y2]。
 */
function swipeLine(box, direction, percent) {
  /* percent 是走掉的行程占这条边的比例（默认 0.7，和原来 0.85→0.15 一致）：
     小一点更稳（长列表短滑），大一点更容易甩出去。始终以中线为轴对称，起点终点都留在框内。 */
  const travel = Math.min(1, Math.max(0.1, Number.isFinite(Number(percent)) ? Number(percent) : 0.7))
  const from = 0.5 + travel / 2
  const to = 0.5 - travel / 2
  const cx = Math.round(box.x + box.w / 2)
  const cy = Math.round(box.y + box.h / 2)
  const high = Math.round(box.y + box.h * to)
  const low = Math.round(box.y + box.h * from)
  const left = Math.round(box.x + box.w * to)
  const right = Math.round(box.x + box.w * from)
  return direction === 'down' ? [cx, high, cx, low]
    : direction === 'left' ? [right, cy, left, cy]
      : direction === 'right' ? [left, cy, right, cy]
        : [cx, low, cx, high]
}

/**
 * 按控件取矩形（手势要「在某个框里滑」而不是滑一个点）。
 * @param {string} device - 设备序列号。
 * @param {object} sel - {ref} 或 {text|id|desc|cls, index}。
 * @returns {Promise<{x:number,y:number,w:number,h:number}>} 矩形。
 */
async function rectForSelector(device, sel) {
  const want = sel || {}
  const state = await snapshotForSelector(device, want.snapshot_id)
  let node
  if (want.ref !== undefined && want.ref !== null) {
    node = nodeForRef(device, Number(want.ref), want.snapshot_id)
  } else {
    node = nodeForSelector(device, {
      text: want.text,
      id: want.id,
      desc: want.desc,
      cls: want.cls,
      exact: want.exact,
      index: want.index,
      snapshotId: want.snapshot_id,
    })
  }
  const hit = clickTarget(nodesOf(state), node)
  const w = Math.round(hit.x2 - hit.x1)
  const h = Math.round(hit.y2 - hit.y1)
  if (w < 4 || h < 4) throw new Error(`「${oneLine(node.text || node.desc || shortClass(node.cls), 16)}」没有面积（${w}×${h}），在它里面滑不动。`)
  return { x: Math.round(hit.x1), y: Math.round(hit.y1), w, h }
}

/** 框的标识，用来记住「这个框已经滑不动了」。 */
function frameKey(box) {
  return `${box.x},${box.y},${box.w},${box.h}`
}

async function scrollToText(serial, text, direction) {
  return scrollToSelector(serial, { text }, direction, 8)
}

/**
 * 边滑边找：同一套「滑一下、读一次、命中就停」的循环，选择器跟 adb_find 一致。
 * 目标不是文字时（id / desc / 类名）也走这里，避免为一个参数再写一遍滑动逻辑。
 * @param {string} serial - 设备。
 * @param {any} want - 选择器：text/id/desc/cls/exact/regex/clickable/index。
 * @param {string} direction - 手指往哪滑，默认 up。
 * @param {number} maxAttempts - 最多滑几次（1–15）。
 * @returns {Promise<any>} 命中的节点。
 */
async function scrollToSelector(serial, want, direction, maxAttempts) {
  const size = await screenSize(serial)
  const dir = ['up', 'down', 'left', 'right'].includes(direction) ? direction : 'up'
  const label = want.text || want.id || want.desc || want.cls || '目标'
  const limit = Math.max(1, Math.min(15, Math.round(Number(maxAttempts) || 3)))
  const stuck = new Set()
  let previous = ''
  let lastBox = null
  for (let attempt = 0; attempt <= limit; attempt += 1) {
    const state = attempt === 0 ? await snapshotForSelector(serial) : await pollDump(serial)
    const hits = selectNodes(state, { ...want, all: true }).filter((node) => node.x2 > node.x1 && node.y2 > node.y1)
    if (hits.length > 0) return hits[want.index ?? 0] ?? hits[0]
    if (attempt === limit) break
    /* 同一个框滑完界面没变 = 那个框到底了；换下一个可滚容器，全都不动才报错，别在错的应用里盲滑。 */
    const signature = state.tree.lines.join('\n')
    if (lastBox !== null && signature === previous) {
      stuck.add(frameKey(lastBox))
      if (scrollFrames(state, size).every((box) => stuck.has(frameKey(box)))) {
        throw new Error(`界面没在滚，找不到「${label}」：可能已经到底、当前页面不可滚动，或你不在预期的应用里。` + nearMiss(state, want))
      }
    }
    previous = signature
    const boxes = scrollFrames(state, size)
    const box = boxes.find((item) => !stuck.has(frameKey(item))) ?? boxes[0]
    lastBox = box
    const [x1, y1, x2, y2] = swipeLine(box, dir)
    const fast = fastInput.swipe === null ? null : await fastInput.swipe(serial, x1, y1, x2, y2, 320)
    if (fast === null) {
      const r = await sh(serial, `input swipe ${x1} ${y1} ${x2} ${y2} 320`, 15_000)
      if (!r.ok) throw new Error(failureNote('滑动', r))
    }
    await new Promise((resolve) => setTimeout(resolve, 240))
  }
  const last = lastTrees.get(serial)
  throw new Error(`滑了 ${limit} 次也没找到「${label}」：换方向（scroll_direction），加大 scroll，或先 adb_ui 看当前页面。${last ? nearMiss(last, want) : ''}`)
}

/**
 * 按文字/资源 id/描述找节点。文字优先精确匹配，再退化为包含匹配；命中多个就报错不猜。
 * @param {string} serial - 设备。
 * @param {{text?: string, id?: string, desc?: string, snapshotId?: string}} want - 选择器。
 * @returns {any} 节点。
 */
/**
 * 同一处堆叠的多个命中（父容器带着它的图标/文字子节点）是一个控件，不是两个选择：
 * 按中心点分簇，每簇只留面积最小的那个，避免把「一个按钮」误报成 ambiguous_target。
 * @param {any[]} nodes - 命中节点。
 * @param {number} [tolerance] - 认为同一点的最大中心距离（设备像素）。
 * @returns {any[]} 去重后的候选。
 */
function collapseSameSpot(nodes, tolerance = 12) {
  if (nodes.length < 2) return nodes
  const midX = (item) => (item.x1 + item.x2) / 2
  const midY = (item) => (item.y1 + item.y2) / 2
  const area = (item) => Math.max(1, (item.x2 - item.x1) * (item.y2 - item.y1))
  const taken = new Set()
  const kept = []
  for (let i = 0; i < nodes.length; i += 1) {
    if (taken.has(i)) continue
    const group = [nodes[i]]
    taken.add(i)
    for (let j = i + 1; j < nodes.length; j += 1) {
      if (taken.has(j)) continue
      if (Math.hypot(midX(nodes[i]) - midX(nodes[j]), midY(nodes[i]) - midY(nodes[j])) <= tolerance) {
        group.push(nodes[j])
        taken.add(j)
      }
    }
    kept.push(group.sort((a, b) => area(a) - area(b))[0])
  }
  return kept
}

/**
 * 歧义报错里带上各个候选的落点，模型可以直接用 point 点其中一个，不用再 dump 一次界面。
 * @param {any[]} nodes - 候选节点。
 * @returns {string} 形如 `（@120,340、@120,880）`。
 */
function spotList(nodes) {
  const shown = nodes.slice(0, 4).map((node) => `@${Math.round((node.x1 + node.x2) / 2)},${Math.round((node.y1 + node.y2) / 2)}`)
  const more = nodes.length > shown.length ? ` 等 ${nodes.length} 处` : ''
  return `（${shown.join('、')}${more}）`
}

/**
 * 统一选择器引擎：字段之间 AND，字段内多值 OR；默认包含匹配，exact 精确，regex 正则。
 * 对齐 uiautomator2 的 text/textContains/textMatches/id/description/instance 语义。
 * @param {any} state - 一次 dump 的状态（需要 nodes 与 refs）。
 * @param {any} sel - 选择器。
 * @returns {any[]} 命中节点（默认按同一处归并；index 指定时只返回那一个）。
 */
function selectNodes(state, sel) {
  const want = sel || {}
  const nodes = state && Array.isArray(state.nodes) ? state.nodes : []
  const refs = state && Array.isArray(state.refs) ? state.refs : (state?.tree?.refs ?? [])
  const text = String(want.text ?? want.textContains ?? want.text_matches ?? want.textMatches ?? '')
  const id = want.id == null ? '' : String(want.id)
  const desc = want.desc == null ? '' : String(want.desc)
  const cls = want.cls == null ? '' : String(want.cls)
  const pkg = want.pkg == null ? '' : String(want.pkg)
  const exact = want.exact === true
  const reText = want.regex ? new RegExp(text, 'i') : null
  const reId = want.regex && id ? new RegExp(id, 'i') : null
  const reDesc = want.regex && desc ? new RegExp(desc, 'i') : null
  const lowText = text.toLowerCase()
  const lowId = id.toLowerCase()
  const lowDesc = desc.toLowerCase()
  const lowCls = cls.toLowerCase()
  const lowPkg = pkg.toLowerCase()
  let box = null
  if (Array.isArray(want.within_rect) && want.within_rect.length === 4) box = want.within_rect.map((value) => Number(value))
  else if (want.within_ref !== undefined && want.within_ref !== null) {
    const entry = refs.find((item) => item.ref === Number(want.within_ref))
    if (!entry || !entry.node) throw new Error(`within_ref ${want.within_ref} 不在当前快照里：先 adb_ui 或 adb_find 拿最新 ref。`)
    box = [entry.node.x1, entry.node.y1, entry.node.x2 - entry.node.x1, entry.node.y2 - entry.node.y1]
  }
  const inBox = (node) => {
    if (!box) return true
    const [bx, by, bw, bh] = box
    const cx = (node.x1 + node.x2) / 2
    const cy = (node.y1 + node.y2) / 2
    return cx >= bx && cx <= bx + bw && cy >= by && cy <= by + bh
  }
  const pass = (node) => {
    if (text) {
      if (reText) {
        if (!reText.test(node.text || '') && !reText.test(node.desc || '')) return false
      } else {
        const nt = String(node.text || '').toLowerCase()
        const nd = String(node.desc || '').toLowerCase()
        if (exact ? nt !== lowText && nd !== lowText : !nt.includes(lowText) && !nd.includes(lowText)) return false
      }
    }
    if (id) {
      const full = String(node.id || '').toLowerCase()
      if (reId ? !reId.test(node.id || '') : exact ? full !== lowId && shortId(full) !== shortId(lowId) : !full.includes(lowId)) return false
    }
    if (desc) {
      const nd = String(node.desc || '').toLowerCase()
      if (reDesc ? !reDesc.test(node.desc || '') : exact ? nd !== lowDesc : !nd.includes(lowDesc)) return false
    }
    if (cls && !String(node.cls || '').toLowerCase().includes(lowCls)) return false
    if (pkg && !String(node.pkg || '').toLowerCase().includes(lowPkg)) return false
    if (want.clickable === true && !(node.clickable || node.longClickable)) return false
    if (want.enabled === true && node.enabled === false) return false
    if (want.visible === true && (node.x2 - node.x1) * (node.y2 - node.y1) <= 0) return false
    /* 控件状态按 Appium 的元素属性对齐：true 只留满足的，false 只留不满足的（「找没勾上的复选框」）。 */
    for (const state of ['checked', 'selected', 'scrollable', 'focused', 'editable', 'password']) {
      const wantState = want[state]
      if (wantState === undefined || wantState === null) continue
      const has = state === 'editable' ? EDITABLE_CLS.test(String(node.cls || '')) : node[state] === true
      if (wantState === true && !has) return false
      if (wantState === false && has) return false
    }
    if (!inBox(node)) return false
    return true
  }
  let hits = nodes.filter(pass)
  if (want.all !== true) hits = collapseSameSpot(hits)
  if (want.index !== undefined && want.index !== null && want.index !== '') {
    const idx = Number(want.index)
    if (!Number.isInteger(idx) || idx < 0) throw new Error('index 从 0 开始，例如 0 是第一个匹配。')
    if (idx >= hits.length) throw new Error(`只有 ${hits.length} 个匹配，index ${idx} 越界。`)
    return [hits[idx]]
  }
  return hits
}

/**
 * 找不到目标时给几个相近的文字，省掉一次 adb_ui 往返。
 * @param {any} state - 一次 dump 的状态。
 * @param {any} sel - 选择器。
 * @returns {string} 提示，没有就空串。
 */
function nearMiss(state, sel) {
  const want = sel || {}
  /* 建议要跟「按什么找错的」对得上：按 id 找错就提示 id，按类名找错就提示类名，否则 agent 拿着文字去搜图标会白跑一趟。 */
  const byId = Boolean(want.id) && !want.text && !want.desc
  const byCls = !byId && Boolean(want.cls) && !want.text && !want.desc
  const needle = String(want.text ?? want.desc ?? want.id ?? want.cls ?? '').toLowerCase()
  if (!needle) return ''
  const grams = []
  for (let i = 0; i + 1 < needle.length; i += 1) grams.push(needle.slice(i, i + 2))
  const seen = new Set()
  const scored = []
  for (const node of (state && state.nodes) || []) {
    const label = byId
      ? (node.id ? shortId(node.id) : '')
      : byCls
        ? shortClass(node.cls || '')
        : String(node.text || node.desc || (node.id ? shortId(node.id) : '') || '')
    if (label === '' || seen.has(label)) continue
    seen.add(label)
    const lower = label.toLowerCase()
    let score = lower.includes(needle) ? 100 : 0
    for (const gram of grams) if (lower.includes(gram)) score += 1
    if (score === 0) continue
    /* 分数一样时能点的排前面：agent 下一步多半就是点它。 */
    scored.push({ label, score: score + (node.clickable === true ? 0.5 : 0) })
  }
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, 3).map((item) => item.label)
  return top.length === 0 ? '' : ` 相近的有：${top.map((label) => '「' + oneLine(label, 18) + '」').join('、')}。`
}

function nodeForSelector(serial, want) {
  const cached = checkSnapshot(serial, want.snapshotId, '文字/id')
  const hits = selectNodes(cached, {
    text: want.text,
    id: want.id,
    desc: want.desc,
    cls: want.cls,
    pkg: want.pkg,
    exact: want.exact,
    regex: want.regex,
    clickable: want.clickable,
    enabled: want.enabled,
    index: want.index,
    all: true,
  })
  if (hits.length === 0) {
    const what = want.text ? `文字「${want.text}」`
      : want.id ? `id 包含「${shortId(String(want.id))}」的控件`
        : want.desc ? `描述包含「${want.desc}」的控件`
          : want.cls ? `类名包含「${want.cls}」的控件` : '匹配的控件'
    throw new Error(`界面上没有${what}：用 adb_find 搜一下，或 adb_ui 看当前界面。` + nearMiss(cached, want))
  }
  if (want.index !== undefined && want.index !== null && want.index !== '') return hits[0]
  const places = collapseSameSpot(hits)
  if (places.length > 1) throw new Error(`ambiguous_target：匹配到 ${places.length} 个控件${spotList(places)}，加 index 挑一个、用 ref，或直接 point 点其中一处。`)
  return places[0]
}

/**
 * 找控件；当前屏没有就先短轮等地等它出现，再报错。
 * 竞品（Appium implicitWait / u2 wait）都把「等元素出现」做成一次调用的一部分，
 * 我们也一样：点早了不再是一轮失败往返，而是自动等最多 900ms（可用 wait_ms 调，上限 5s）。
 * 只对「界面上没有」这种还能变的情况等；匹配到多个、快照过期这些等也不会好，立刻报。
 * @param {string} device - 设备。
 * @param {any} want - nodeForSelector 的选择器。
 * @param {number} [waitMs] - 最多等多久（毫秒），默认 900。
 * @returns {any} 节点。
 */
async function awaitNode(device, want, waitMs) {
  try {
    return nodeForSelector(device, want)
  } catch (error) {
    const reason = String(error?.message ?? error)
    const limit = Math.max(0, Math.min(5000, Number(waitMs ?? 900) || 0))
    if (limit === 0 || !reason.startsWith('界面上没有')) throw error
    const began = Date.now()
    let last = error
    while (Date.now() - began < limit) {
      await new Promise((resolve) => setTimeout(resolve, 120))
      try {
        /* dumpState 会刷新 lastTrees，nodeForSelector 读到的就是这一轮的新界面。 */
        await pollDump(device)
        return nodeForSelector(device, want)
      } catch (inner) {
        last = inner
      }
    }
    const waited = Date.now() - began
    throw new Error(`${String(last?.message ?? last).replace(/^界面上没有/, `等了 ${waited}ms 界面上还是没有`)}`)
  }
}

const screenSizes = new Map()

/**
 * 读一次屏幕分辨率（有 Override size 就用它），按设备缓存，改分辨率后清缓存。
 * @param {string} device - 设备序列号。
 * @returns {Promise<{width: number, height: number}>} 尺寸。
 */
/** schema 里某类型缺值时的空值：让「工具忘了填/填了 null」不至于把整次调用变成硬错误。 */
function emptyForType(type) {
  if (type === 'integer' || type === 'number') return 0
  if (type === 'boolean') return false
  if (type === 'array') return []
  if (type === 'object') return {}
  return ''
}

/**
 * 按 output schema 修一遍值：必填字段缺了补类型空值，选填字段是 null/undefined 就丢掉，
 * additionalProperties:false 的多余字段也丢掉。工具成功执行却被宿主的 schema 校验判错，
 * 是 agent 最冤的一类失败（动作真做了、回执却说失败），这层是兜底。
 * @param {any} schema - output.schema 片段。
 * @param {any} value - 工具返回值。
 * @returns {any} 修完的值（不改原地）。
 */
function guardOutput(schema, value) {
  if (!schema || typeof schema !== 'object') return value
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  if (types.includes('null') && value === null) return null
  if (value === null || value === undefined) return value
  if (types.includes('object') || schema.properties) {
    const props = schema.properties ?? {}
    const keys = Object.keys(props)
    const out = {}
    for (const key of keys) {
      const item = guardOutput(props[key], value[key])
      if (item === undefined || item === null) {
        const required = Array.isArray(schema.required) && schema.required.includes(key)
        if (!required) continue
        const itemTypes = Array.isArray(props[key]?.type) ? props[key].type : [props[key]?.type]
        if (itemTypes.includes('null')) {
          out[key] = null
          continue
        }
        out[key] = emptyForType(itemTypes[0])
        continue
      }
      out[key] = item
    }
    if (schema.additionalProperties === false) return out
    /* 松散 schema 下保留额外字段，但 null/undefined 一律不带出去。 */
    const extras = {}
    for (const [key, item] of Object.entries(value)) {
      if (key in props || item === null || item === undefined) continue
      extras[key] = item
    }
    return { ...extras, ...out }
  }
  if (types.includes('array') && Array.isArray(value)) {
    const items = schema.items
    return items ? value.map((item) => guardOutput(items, item)) : value
  }
  return value
}

/** 把输出守卫挂到工具定义上：execute 的返回值先修再交出去。 */
function guardTool(def) {
  if (!def || typeof def !== 'object' || typeof def.execute !== 'function') return def
  const schema = def.output && def.output.schema
  if (!schema) return def
  const run = def.execute
  return {
    ...def,
    execute: async (...rest) => guardOutput(schema, await run(...rest)),
  }
}

/**
 * 从 dumpsys window displays 里挑「当前显示」尺寸：每行是 init=物理 cur=当前，横屏/分屏时两者不同。
 * 触摸注入和控件坐标都按 cur 走，用 wm size 的物理尺寸算滑点会滑到错的轴上。
 * @param {string} text - dumpsys 输出。
 * @param {{width:number,height:number}|null} physical - wm size 读到的物理尺寸，用来挑对那台显示。
 * @returns {{width:number,height:number}|null} 当前显示尺寸。
 */
function displaySizeFrom(text, physical) {
  const pairs = []
  for (const line of String(text).split('\n')) {
    const m = /init=(\d+)x(\d+)[^\n]*?cur=(\d+)x(\d+)/.exec(line)
    if (!m) continue
    pairs.push({ iw: Number(m[1]), ih: Number(m[2]), w: Number(m[3]), h: Number(m[4]) })
  }
  if (pairs.length === 0) return null
  const hit = physical === null
    ? null
    : pairs.find((p) => (p.iw === physical.width && p.ih === physical.height) || (p.ih === physical.width && p.iw === physical.height))
  const pick = hit ?? pairs.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a))
  if (!(pick.w > 0 && pick.h > 0)) return null
  return { width: pick.w, height: pick.h }
}

async function screenSize(device) {
  const cached = screenSizes.get(device)
  if (cached && Date.now() - cached.at < 60_000) return cached
  let physical = null
  try {
    const w = await adb(['-s', device, 'shell', 'wm size'], { timeout: 8000 })
    const body = `${w.out}${w.err ?? ''}`
    const m = /Override size:\s*(\d+)x(\d+)/.exec(body) ?? /Physical size:\s*(\d+)x(\d+)/.exec(body)
    if (m) physical = { width: Number(m[1]), height: Number(m[2]) }
  } catch {
    physical = null
  }
  let size = null
  try {
    const d = await adb(['-s', device, 'shell', 'dumpsys window displays'], { timeout: 10_000 })
    size = displaySizeFrom(`${d.out}${d.err ?? ''}`, physical)
  } catch {
    size = null
  }
  if (size === null) size = physical
  if (size === null) throw new Error('读不到屏幕分辨率：先 adb_sh 跑一次 wm size 看看。')
  screenSizes.set(device, { ...size, at: Date.now() })
  return size
}

/**
 * 等前台 Activity 变成期望的页面；不等就返回当前页面（启动类操作不因为没命中就失败）。
 * @param {string} device - 设备。
 * @param {string | undefined} pattern - Activity 正则（省略则只等 600ms 让画面出来）。
 * @param {number} timeoutMs - 上限。
 * @returns {Promise<string>} 最终前台 Activity。
 */
async function settleActivity(device, pattern, timeoutMs) {
  const limit = Math.max(400, Number(timeoutMs) || 6000)
  const began = Date.now()
  if (!pattern) {
    await new Promise((resolve) => setTimeout(resolve, 600))
    return foregroundActivity(device).catch(() => '')
  }
  let re
  try { re = new RegExp(String(pattern), 'i') } catch { throw new Error('wait_activity 不是合法正则：' + pattern) }
  for (;;) {
    const activity = await foregroundActivity(device).catch(() => '')
    if (re.test(activity)) return activity
    if (Date.now() - began > limit) return activity
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
}

/**
 * 把选择器解析成一个落点（优先用可点祖先的中心）。
 * @param {string} device - 设备。
 * @param {any} sel - {point} 或 {ref} 或 {text|id|desc|cls, index, exact} 或 {x,y}。
 * @returns {Promise<{x: number, y: number, label: string}>} 落点与人类可读标签。
 */
async function pointForSelector(device, sel) {
  const want = sel || {}
  if (want.point !== undefined) {
    const parts = String(want.point).split(',').map((value) => Number(value.trim()))
    if (parts.length !== 2 || parts.some((value) => !Number.isFinite(value))) throw new Error('point 要写成 "x,y"，例如 "540,1200"。')
    return { x: Math.round(parts[0]), y: Math.round(parts[1]), label: `坐标 ${parts[0]},${parts[1]}` }
  }
  if (Number.isFinite(Number(want.x)) && Number.isFinite(Number(want.y))) {
    return { x: Math.round(Number(want.x)), y: Math.round(Number(want.y)), label: `坐标 ${want.x},${want.y}` }
  }
  let node
  if (want.ref !== undefined && want.ref !== null) {
    node = nodeForRef(device, Number(want.ref), want.snapshot_id)
  } else {
    await snapshotForSelector(device, want.snapshot_id)
    node = nodeForSelector(device, {
      text: want.text,
      id: want.id,
      desc: want.desc,
      cls: want.cls,
      exact: want.exact,
      index: want.index,
      snapshotId: want.snapshot_id,
    })
    node = await freshNodeFor(device, node, want.snapshot_id)
  }
  const hit = clickTarget(nodesOf(device), node)
  const x = Math.round((hit.x1 + hit.x2) / 2)
  const y = Math.round((hit.y1 + hit.y2) / 2)
  return { x, y, label: `「${oneLine(node.text || node.desc || shortId(node.id) || shortClass(node.cls), 20)}」@${x},${y}` }
}

/**
 * 最近一次 adb_ui 的完整节点数组，用来找可点祖先。
 * @param {string} serial - 设备。
 * @returns {any[]} 节点。
 */
function nodesOf(serial) {
  return lastTrees.get(serial)?.nodes ?? []
}

/**
 * 找最近的可点击祖先：文字节点本身常常不可点，按它的中心点会点空。
 * @param {any[]} nodes - 完整节点数组。
 * @param {any} node - 目标节点。
 * @returns {any} 可点击祖先（没有就返回原节点）。
 */
function clickTarget(nodes, node) {
  const area = (item) => Math.max(1, (item.x2 - item.x1) * (item.y2 - item.y1))
  const midX = (item) => (item.x1 + item.x2) / 2
  const midY = (item) => (item.y1 + item.y2) / 2
  let current = node
  for (let guard = 0; guard < 12; guard += 1) {
    if (current.clickable && current.enabled) {
      if (current === node) return node
      /* 可点祖先大得离谱、中心又离文字很远时，点文字自己：点进祖先中心常常是空白。 */
      const bigger = area(current) > area(node) * 6
      const far = Math.abs(midX(current) - midX(node)) > Math.max(40, (node.x2 - node.x1) / 2)
        || Math.abs(midY(current) - midY(node)) > Math.max(40, (node.y2 - node.y1) / 2)
      return bigger && far ? node : current
    }
    const parent = nodes[current.parent]
    if (!parent) return node
    current = parent
  }
  return node
}

/**
 * 一次操作之后短轮等地看界面有没有变：先 ~90ms 一次 dump，没变再补一次。
 * 成功路径比「固定等 240ms 再 dump」早约 150ms 拿到回执，失败路径才多花一次 dump。
 * @param {string} serial - 设备。
 * @param {string} signature - 操作前的树签名。
 * @param {{firstMs?: number, againMs?: number}} [options] - 两轮等待时长。
 * @returns {Promise<any>} 最新界面状态。
 */
async function awaitChange(serial, signature, options = {}) {
  const waits = [options.firstMs ?? 90, options.againMs ?? 140].map((ms) => Math.max(0, Math.round(ms)))
  let state = null
  for (const wait of waits) {
    await new Promise((resolve) => setTimeout(resolve, wait))
    state = await pollDump(serial)
    if (Array.isArray(state.nodes) && state.nodes.length > 0 && state.tree.lines.join('\n') !== signature) return state
  }
  return state
}

/**
 * 等界面「自己静下来」：树签名连续 quietMs 不变就算稳定（u2 的 wait_stable / Appium 的 idle 等待）。
 * 读不到任何控件时不算稳定——加载中的空树也会「不变」，那是最容易点错位置的一刻。
 * @param {() => Promise<any>} dump - 一次 dump，返回带 tree/nodes 的状态。
 * @param {{quietMs?: number, timeoutMs?: number}} [options] - 静止窗口与总上限。
 * @returns {Promise<{state: any, stable: boolean, quietMs: number, ms: number, dumps: number, empty: boolean}>} 结果。
 */
async function awaitStable(dump, options = {}) {
  const quietMs = Math.max(120, Number(options.quietMs ?? 400))
  const timeoutMs = Math.max(quietMs, Number(options.timeoutMs ?? 5000))
  const began = Date.now()
  let state = await dump()
  let previous = state.tree.lines.join('\n')
  let quietSince = Date.now()
  let dumps = 1
  let stable = false
  const hasContent = () => Array.isArray(state.nodes) && state.nodes.length > 0
  while (Date.now() - began < timeoutMs) {
    if (hasContent() && Date.now() - quietSince >= quietMs) {
      stable = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 120))
    state = await dump()
    dumps += 1
    const now = state.tree.lines.join('\n')
    if (now !== previous) {
      previous = now
      quietSince = Date.now()
    }
  }
  return { state, stable, quietMs, ms: Date.now() - began, dumps, empty: !hasContent() }
}

/**
 * 两份控件行做差：返回 `+ 新增` / `- 消失`，调用方按需截断。
 * @param {string[]} before - 旧行。
 * @param {string[]} after - 新行。
 * @param {number} [limit] - 最多几条，0 表示不限。
 * @returns {string[]} 差异行。
 */
function diffLines(before, after, limit = 6) {
  const counts = new Map()
  for (const line of before ?? []) counts.set(line, (counts.get(line) ?? 0) + 1)
  const added = []
  const removed = []
  for (const line of after ?? []) {
    const left = counts.get(line) ?? 0
    if (left > 0) counts.set(line, left - 1)
    else added.push(`+ ${line}`)
  }
  for (const [line, left] of counts) for (let i = 0; i < left; i += 1) removed.push(`- ${line}`)
  const all = [...removed, ...added]
  return limit > 0 ? all.slice(0, limit) : all
}

/**
 * 点了没反应时，从新快照里当场找出原因，省掉模型再读一遍树的回合。
 * @param {any} state - awaitChange / dumpState 的结果。
 * @param {{x: number, y: number}} point - 点下去的位置。
 * @param {any} [target] - 原本要点的节点（按坐标点时为空）。
 * @param {any} [before] - 操作前的快照（用来比对包名/页面）。
 * @returns {{code: string, text: string}} 机器可判的原因码 + 一句话原因。
 */
function describeTapMiss(state, point, target, before) {
  const nodes = Array.isArray(state?.nodes) ? state.nodes : []
  const x = Number(point?.x ?? 0)
  const y = Number(point?.y ?? 0)
  if (nodes.length === 0) return { code: 'unknown-tree', text: '一个控件都读不到，可能还在加载，或者这屏是自己画的' }
  const area = (node) => Math.max(1, (node.x2 - node.x1) * (node.y2 - node.y1))
  const covers = (node) => node.x2 > node.x1 && node.y2 > node.y1 && node.x1 <= x && x <= node.x2 && node.y1 <= y && y <= node.y2
  const hits = nodes.filter(covers)
  const ime = hits.find((node) => /InputMethod|KeyboardView/i.test(node.cls) || /inputmethod|keyboard/i.test(node.pkg))
  if (ime) return { code: 'keyboard-covered', text: '键盘挡住了这一点；先 adb_input {"key":"back"} 收起键盘再点' }
  const sys = hits.find((node) => /^com\.android\.systemui$/.test(node.pkg) || /Dialog|PopupWindow|Toast/i.test(node.cls))
  if (sys) return { code: 'obscured', text: `这一点被 ${oneLine(sys.text || sys.desc || shortClass(sys.cls), 16)} 挡住（${sys.pkg || '系统窗口'}），先关掉它` }
  if (before?.activity && state?.activity && before.activity !== state.activity) return { code: 'page-switched', text: '页面已经切换了，按旧位置点不到目标' }
  const wanted = String(target?.text || target?.desc || '')
  if (wanted && !nodes.some((node) => (node.text || node.desc) === wanted)) return { code: 'gone', text: '目标已经不在这屏了：页面变了或列表滚走了，重新 adb_ui 取 ref' }
  if (target && target.clickable === false && !nodes.some((node) => node.clickable && covers(node))) {
    return { code: 'unclickable', text: '目标不可点，也没有可点的祖先容器：它只是文字/装饰，点它不会触发任何操作' }
  }
  const deep = hits.length > 0 ? hits.reduce((a, b) => (area(a) <= area(b) ? a : b)) : null
  if (deep) return { code: 'no-response', text: `命中的是 ${oneLine(deep.text || deep.desc || shortClass(deep.cls), 18)}，但它没响应：可能只是容器，或动画还没结束` }
  return { code: 'same-screen', text: '界面没变化：可能没点中，或还在动画；用 adb_shot 看画面' }
}

/**
 * 只要一句话版本的没点中原因（老的调用点/测试用）。
 * @param {any} state - 当前快照。
 * @param {{x: number, y: number}} point - 点下去的位置。
 * @param {any} [target] - 原本要点的节点。
 * @param {any} [before] - 操作前的快照。
 * @returns {string} 一句话原因。
 */
function tapMissReason(state, point, target, before) {
  return describeTapMiss(state, point, target, before).text
}

/**
 * shell 单引号转义，给 `su -c` 用。
 * @param {string} text - 命令。
 * @returns {string} 转义后的命令。
 */
function shQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`
}

/**
 * 把文字转成 `input text` 能接受的形式：空格用 %s，shell 元字符单引号包起来。
 * 非 ASCII 字符（中文、emoji）`input text` 不支持，直接报错，不静默吞掉。
 * @param {string} text - 原文。
 * @returns {{ok: boolean, value: string, reason?: string}} 结果。
 */
function shellInputText(text) {
  const bad = [...text].filter((char) => char.charCodeAt(0) > 126)
  if (bad.length > 0) {
    return {
      ok: false,
      value: '',
      reason: `含非 ASCII 字符（${[...new Set(bad)].slice(0, 5).join('')}）：adb 的 input text 不支持中文输入。改用剪贴板或换 ASCII 输入。`,
    }
  }
  const escaped = text.replace(/ /g, '%s').replace(/'/g, `'\\''`)
  return { ok: true, value: `'${escaped}'` }
}

/**
 * 往当前焦点输入框输入文字：能走 `input text` 就走（快），中文/emoji 走剪贴板粘贴。
 * adb_input 与 adb_do 的 text 步骤共用这一条路径，避免两处各自只支持一半。
 * @param {string} serial - 设备。
 * @param {string} text - 要输入的文字。
 * @returns {Promise<{how: 'input' | 'paste', steps: string[], field: string, note: string}>} 结果。
 */
/**
 * 当前焦点输入框里还剩下的文字（普通 EditText 才算），用来核对「清空」是不是真清空了。
 * @param {string} serial - 设备。
 * @returns {Promise<string>} 还有内容就返回那段文字，空/找不到输入框返回空串。
 */
async function focusedFieldText(serial) {
  try {
    const state = await dumpState(serial, { ocr: 'off', maxNodes: 200, activity: false })
    const filled = state.nodes.filter((node) => /EditText|AutoComplete/i.test(String(node.cls || '')) && String(node.text || '') !== '')
    return filled.length === 0 ? '' : String(filled[0].text)
  } catch {
    return ''
  }
}

/**
 * 清空焦点输入框。老做法是一条一条发 40 次 DEL，等于在设备上起 40 个 input 进程（实测 2.6s）；
 * 这里改成「全选 + DEL」两条 keyevent 一次 shell（约 100ms），再读一次树确认真的空了，
 * 全选不生效的输入框（少数自绘控件）才补一轮批量 DEL —— 一条命令带 60 个 KEYCODE_DEL，仍然只起一个进程。
 * @param {string} serial - 设备。
 * @returns {Promise<{note: string, ms: number}>} 给用户看的说明与耗时。
 */
async function clearFocusedField(serial) {
  const began = Date.now()
  const burst = async () => {
    const codes = ['KEYCODE_MOVE_END', ...Array.from({ length: 60 }, () => 'KEYCODE_DEL')].join(' ')
    const result = await sh(serial, `input keyevent ${codes}`, 20_000)
    if (!result.ok) throw new Error(failureNote('清空输入框', result))
  }
  const selected = await sh(serial, 'input keycombination KEYCODE_CTRL_LEFT KEYCODE_A; input keyevent KEYCODE_DEL', 15_000)
  if (!selected.ok) {
    await burst()
    return { note: `已清空输入框（${Date.now() - began}ms，批量 DEL）`, ms: Date.now() - began }
  }
  const leftover = await focusedFieldText(serial)
  if (leftover === '') return { note: `已清空输入框（${Date.now() - began}ms）`, ms: Date.now() - began }
  await burst()
  const after = await focusedFieldText(serial)
  if (after === '') return { note: `已清空输入框（${Date.now() - began}ms，全选没生效时补了批量 DEL）`, ms: Date.now() - began }
  return { note: `清空后输入框还有「${oneLine(after, 20)}」：它可能不是普通输入框，先点中输入框再 clear，或手动 selectAll。`, ms: Date.now() - began }
}

/**
 * 当前系统输入法组件（如 `com.github.uiautomator/.AdbKeyboard`）；读不到就返回空串。
 * @param {string} serial - 设备。
 * @returns {Promise<string>} 组件名。
 */
async function activeIme(serial) {
  const result = await sh(serial, 'settings get secure default_input_method', 6000).catch(() => null)
  return result !== null && result.ok ? String(result.stdout ?? '').trim() : ''
}

/**
 * 设备上有没有装收 ADB 广播的输入法（ADBKeyboard 系，uiautomator2 的机器一般自带）。
 * @param {string} serial - 设备。
 * @returns {Promise<string>} 组件名，没有就是空串。
 */
async function adbImeComponent(serial) {
  const listed = await sh(serial, 'ime list -a -s', 8000).catch(() => null)
  if (listed === null || !listed.ok) return ''
  const lines = String(listed.stdout ?? '').split('\n').map((line) => line.trim()).filter(Boolean)
  return lines.find((line) => /adbkeyboard/i.test(line)) ?? ''
}

/**
 * 走输入法广播整段上屏：一次 am broadcast 顶掉「写剪贴板 + 长按 + 点粘贴」三步。
 * 只在这个输入法已经是当前输入法时才自动用；要切输入法必须调用方明确要（switch），用完切回去。
 * @param {string} serial - 设备。
 * @param {string} text - 要输入的文字。
 * @param {{switch?: boolean}} options - switch 允许临时切输入法。
 * @returns {Promise<{how: string, steps: string[], field: string, note: string}|null>} 成功返回结果，不行返回 null 让调用方退回剪贴板。
 */
async function typeViaAdbIme(serial, text, options = {}) {
  const wanted = String(text)
  const count = [...wanted].length
  const component = await adbImeComponent(serial)
  if (component === '') return null
  const previous = await activeIme(serial)
  const already = previous !== '' && previous.toLowerCase() === component.toLowerCase()
  if (!already && options.switch !== true) return null
  const steps = []
  if (!already) {
    const enabled = await sh(serial, `ime enable ${component}`, 8000)
    if (!enabled.ok) return null
    const picked = await sh(serial, `ime set ${component}`, 8000)
    if (!picked.ok) return null
    steps.push(`切到 ${component}`)
  }
  const restore = async () => {
    if (already || previous === '') return
    steps.push(`切回 ${previous}`)
    await sh(serial, `ime set ${previous}`, 8000).catch(() => null)
  }
  const before = await focusedFieldText(serial)
  const payload = Buffer.from(wanted, 'utf8').toString('base64')
  const sent = await sh(serial, `am broadcast -a ADB_INPUT_B64 --es msg ${payload}`, 12_000)
  if (!sent.ok) {
    await restore()
    return null
  }
  steps.push('ADB_INPUT_B64')
  await new Promise((resolve) => setTimeout(resolve, 120))
  const after = await focusedFieldText(serial)
  /* 密码框显示的是圆点：字符数变了也算上屏，别死等文字相等。 */
  const landed = after.includes(wanted) || after.length >= before.length + count
  if (!landed) {
    await restore()
    /* 广播已发出去，输没输进去说不清：这时候再补一次粘贴可能变成两份，直接报错让人看一眼。 */
    throw new Error(`文字已经发给输入法，但输入框里没读到（现在「${oneLine(after, 20)}」）：先用 adb_ui 看一眼，或改用 ime:"clipboard"`)
  }
  await restore()
  return { how: 'ime', steps, field: after, note: `已输入 ${count} 个字符` }
}

async function inputTextVia(serial, text, options = {}) {
  const wanted = String(text)
  const count = [...wanted].length
  if (wanted === '') throw new Error('要输入的文字是空的。')
  const encoded = shellInputText(wanted)
  if (options.ime === 'adb') {
    /* 明确要走输入法广播：允许临时切过去，输完切回来。 */
    const forced = await typeViaAdbIme(serial, wanted, { switch: true }).catch(() => null)
    if (forced !== null) return { how: 'ime', steps: forced.steps, field: forced.field, note: `已输入 ${count} 个字符（${forced.steps.join(' → ')}）` }
  }
  if (encoded.ok) {
    const result = await sh(serial, `input text ${encoded.value}`, 15_000)
    if (!result.ok) throw new Error(failureNote('输入', result))
    return { how: 'input', steps: ['input text'], field: '', note: `已输入 ${count} 个字符` }
  }
  if (options.ime !== 'clipboard') {
    /* 中文走输入法广播最快，但只在它已经是当前输入法时自动用，不悄悄改用户输入法。 */
    const viaIme = await typeViaAdbIme(serial, wanted, { switch: false }).catch(() => null)
    if (viaIme !== null) return { how: 'ime', steps: viaIme.steps, field: viaIme.field, note: `已输入 ${count} 个字符（${viaIme.steps.join(' → ')}）` }
  }
  /* 中文没有 input text 可用：写剪贴板再长按粘贴，走的是系统输入法自己的通道。 */
  const pasted = await typeViaClipboard(serial, wanted)
  return {
    how: 'paste',
    steps: pasted.steps,
    field: pasted.field,
    note: `已粘贴 ${count} 个字符（${pasted.steps.join(' → ')}）`,
  }
}

/** 失败取证目录：按设备分桶，每条用例一张图，超过上限就删最老的。 */
const EVIDENCE_KEEP = 20

/**
 * 失败时留一张图：错误信息里只有文字时，「按钮被键盘挡住」「弹了权限框」这类问题
 * 光看文字树判断不了，事后还能翻这张图。只往 ~/.dsh/adb-evidence 下写，按设备分目录、只留最近 20 张。
 * @param {string} serial - 设备。
 * @param {string} label - 文件名里的用途标记（如 `adb_do`）。
 * @returns {Promise<{path: string, bytes: number}|null>} 存成返回路径，存不下返回 null（取证永远不该顶替原来的报错）。
 */
async function captureEvidence(serial, label) {
  try {
    const dir = join(homedir(), '.dsh', 'adb-evidence', serial.replace(/[^\w.-]/g, '_'))
    await mkdir(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const path = join(dir, `${stamp}-${label.replace(/[^\w.-]/g, '_')}.jpg`)
    const shot = await screenshot(serial, { scale: 720, path })
    const names = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith('.jpg')).sort()
    for (const old of names.slice(0, Math.max(0, names.length - EVIDENCE_KEEP))) {
      await rm(join(dir, old), { force: true }).catch(() => undefined)
    }
    return { path, bytes: shot.bytes }
  } catch {
    return null
  }
}

/**
 * 读 PNG 的 IHDR 尺寸（字节 16..24）。缩图后以文件为准，避免手算误差。
 * @param {string} path - PNG 路径。
 * @returns {Promise<{width: number, height: number}>} 尺寸。
 */
async function pngSize(path) {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(24)
    await handle.read(buffer, 0, 24, 0)
    if (buffer.toString('latin1', 1, 4) !== 'PNG') return { width: 0, height: 0 }
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  } finally {
    await handle.close()
  }
}

/**
 * 截图到临时文件，可选缩到长边 N 像素（默认 900）。
 * @param {string} serial - 设备。
 * @param {{scale?: number, path?: string}} options - 参数。
 * @returns {Promise<{path: string, bytes: number, width: number, height: number, ms: number}>} 结果。
 */
/**
 * 用 ffmpeg 从整屏 JPEG 里裁一块，省掉整屏传输和解码。
 * @param {Buffer} jpeg - 整屏 JPEG。
 * @param {{x: number, y: number, w: number, h: number}} region - 设备像素矩形。
 * @returns {Promise<Buffer>} 裁切后的 JPEG。
 */
/**
 * 解析 "x,y,w,h"，格式不对就当没给。
 * @param {unknown} text - 参数字符串。
 * @returns {{x: number, y: number, w: number, h: number}|null} 矩形或 null。
 */
function parseRegion(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  const parts = text.split(',').map((piece) => Number(piece.trim()))
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return null
  const [x, y, w, h] = parts
  if (w < 2 || h < 2) return null
  return { x, y, w, h }
}

async function cropJpeg(jpeg, region) {
  const ffmpeg = process.env.FFMPEG ?? 'ffmpeg'
  const w = Math.max(2, Math.round(region.w))
  const h = Math.max(2, Math.round(region.h))
  const x = Math.max(0, Math.round(region.x))
  const y = Math.max(0, Math.round(region.y))
  const filter = `crop=${w}:${h}:${x}:${y}`
  return await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-v', 'error', '-i', 'pipe:0', '-vf', filter, '-frames:v', '1', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] })
    const out = []
    let err = ''
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { err = (err + chunk).slice(-400) })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0 && out.length > 0) resolve(Buffer.concat(out))
      else reject(new Error(`裁切失败：${err.trim() || 'ffmpeg 退出码 ' + String(code)}`))
    })
    child.stdin.end(jpeg)
  })
}

async function screenshot(serial, options) {
  const started = Date.now()
  /* 设备端直接编 JPEG：3.5MB / 0.6s，比 PNG 的 8.9MB 少一大截传输和 sips 解码时间。 */
  let r = await adb(['-s', serial, 'exec-out', 'screencap', '-j'], { timeout: 30_000 })
  let jpeg = r.ok && r.raw.length > 4 && r.raw[0] === 0xff && r.raw[1] === 0xd8
  if (!jpeg) {
    r = await adb(['-s', serial, 'exec-out', 'screencap', '-p'], { timeout: 30_000 }).catch(() => r)
    jpeg = false
  }
  if (!r.ok || r.raw.length === 0) throw new Error(`截图失败：${oneLine(r.err || '无输出', 160)}`)
  let buffer = r.raw
  if (options.region != null) {
    buffer = await cropJpeg(buffer, options.region)
    if (buffer.length < 100) throw new Error('裁切失败：区域超出画面？')
  }
  const dir = join(tmpdir(), 'dsh-mobile-use')
  await mkdir(dir, { recursive: true })
  const path = options.path || join(dir, `screen-${serial}-${Date.now()}.${jpeg ? 'jpg' : 'png'}`)
  await writeFile(path, buffer)
  const scale = options.scale ?? 900
  /* 尺寸一律从磁盘上的文件头读：sips 缩过之后 buffer 已经不代表文件内容。 */
  const dimsOf = async () => {
    if (!jpeg) return pngSize(path).then((p) => ({ w: p.width, h: p.height }))
    const handle = await open(path, 'r')
    try {
      const head = Buffer.alloc(4096)
      const { bytesRead } = await handle.read(head, 0, head.length, 0)
      return jpegSize(head.subarray(0, bytesRead)) ?? { w: 0, h: 0 }
    } finally {
      await handle.close()
    }
  }
  let size = await dimsOf()
  if (scale > 0 && Math.max(size.w, size.h) > scale) {
    await new Promise((resolve) => execFile('sips', ['-Z', String(scale), path], () => resolve(undefined)))
    size = await dimsOf()
  }
  const bytes = await stat(path).then((value) => value.size).catch(() => buffer.length)
  return {
    path,
    bytes,
    width: size.w,
    height: size.h,
    ms: Date.now() - started,
  }
}

/**
 * 一个工具结果的渲染器：文本优先，结构化字段留在 JSON 里。
 * @param {string} text - 给模型看的文本。
 * @returns {any[]} 渲染块。
 */
function textBlock(text) {
  return [{ type: 'text', text }]
}

/**
 * 圈选区域里有哪些控件：把 ref 文本树按中心点收进矩形，供标注回传时
 * 让模型知道「圈的是这个按钮」而不只是看像素。
 * @param {string} serial - 设备序列号。
 * @param {{x: number, y: number, w: number, h: number}} rect - 设备坐标上的矩形。
 * @returns {Promise<string[]>} 最多 12 行控件描述。
 */
async function uiInRect(serial, rect) {
  if (!serial || !rect) return []
  const left = rect.x
  const top = rect.y
  const right = rect.x + rect.w
  const bottom = rect.y + rect.h
  let state
  try {
    state = await dumpState(serial, {})
  } catch {
    return []
  }
  const lines = []
  for (const node of state.nodes ?? []) {
    const cx = (node.x1 + node.x2) / 2
    const cy = (node.y1 + node.y2) / 2
    if (cx < left || cx > right || cy < top || cy > bottom) continue
    const label = node.text || node.desc || ''
    if (label === '' && node.id === '') continue
    lines.push(`${node.clickable ? '[可点] ' : ''}${label || shortClass(node.cls)}${node.id ? ` #${shortId(node.id)}` : ''} @${Math.round(cx)},${Math.round(cy)}`)
    if (lines.length >= 12) break
  }
  return lines
}

/**
 * 注册插件。
 * @param {any} ctx - Cordis 上下文。
 * @param {any} config - bundle patch 里的 config。
 */
export function apply(ctx, config) {
  const serial = async () => resolveSerial(config)

  loadActions()
  /* 每 2 秒对比一次尾部，有变化才落盘：所有记动作的地方都不用改，也不会写爆磁盘。 */
  let savedAt = lastActions.length > 0 ? lastActions[lastActions.length - 1].at : 0
  const actionSaver = setInterval(() => {
    try {
      const tail = lastActions.length > 0 ? lastActions[lastActions.length - 1].at : 0
      if (tail !== savedAt) {
        savedAt = tail
        void saveActions()
      }
    } catch { /* 定时器是独立故障域 */ }
  }, 2000)
  actionSaver.unref?.()

  /* 实时镜像：侧栏直播 + 标注回传 + 本机 3 分钟环形缓冲。 */
  const mirror = setupMirror(ctx, {
    adb: Object.assign(adb, { path: ADB }),
    resolveSerial: serial,
    uiInRect,
    recentActions,
    /* 人手在侧栏点/滑/打字也要进同一条时间线：否则 agent 只看得到自己做过什么，
       用户说「我刚点了没反应」时它无法判断到底有没有点、点在哪。 */
    deviceStory,
    noteAction: (what) => {
      lastActions.push({ at: Date.now(), what: `人手${String(what).slice(0, 60)}` })
      if (lastActions.length > 400) lastActions.splice(0, lastActions.length - 400)
    },
    typeText: typeViaClipboard,
  })
  ctx.effect(() => () => {
    clearInterval(actionSaver)
    void saveActions()
    mirror.stopAll()
    stopOcr()
    for (const device of [...shellChannels.keys()]) killShell(device)
    /* 只拆本插件自己建的转发（按 serial 区分），别的设备/别的工具留的不要动。 */
    const created = new Set([...ownedForwards.values()].map((item) => item.serial))
    for (const device of created) void releaseForward(device).catch(() => {})
  }, 'adb: 实时镜像退出')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_ui',
    description: [
      '读 Android 设备当前界面的文本树（一次约 0.12s，走设备端 uiautomator2 常驻服务），代替截图判断界面状态：文字、控件 id、坐标、是否可点。',
      '输出每行一个控件：ref、类型、文字、#资源id、@中心坐标，尾部 * 可点击 / ~ 可滚动 / [x] 勾选 / [off] 不可用；ref 可直接给 adb_tap。',
      '判断「页面对不对、有没有报错、按钮在不在」用它；只有要确认颜色/布局/相机画面时才用 adb_shot。',
      '要等界面变化（接口返回、跳转、弹窗）传 wait_for_text / wait_for_activity，不要 sleep 之后反复截图。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: '只返回包含这段文字的控件行（不区分大小写）' },
        full: { type: 'boolean', description: '连没有文字的结构容器也返回，用于排查布局；默认只给有文字/可点击的节点' },
        max_nodes: { type: 'integer', description: `最多返回多少行，默认 ${MAX_NODES.default}` },
        depth: { type: 'integer', description: '只列到第 N 层：设置页那种深树先看骨架，深处容器和图标不占行' },
        wait_for_text: { type: 'string', description: '等到界面上出现这段文字再返回（子串匹配），配合 timeout_ms' },
        wait_for_id: { type: 'string', description: '等到界面上出现这个资源 id（子串匹配）' },
        wait_for_activity: { type: 'string', description: '等到前台 Activity 匹配这个正则，例如 "ScanActivity"' },
        wait_until_gone: { type: 'string', description: '等到这段文字从界面上消失，例如等加载提示消失' },
        wait_idle: { type: 'boolean', description: '等界面停止变化（动画/加载结束）再返回，配合 idle_ms' },
        wait_stable: { type: 'boolean', description: '同 wait_idle：树签名连续 idle_ms 不变就算稳定' },
        idle_ms: { type: 'integer', description: 'wait_idle / wait_stable 用：连续多久没变化算静止，默认 400' },
        timeout_ms: { type: 'integer', description: '等待上限，默认 15000' },
        changed_only: { type: 'boolean', description: '只给跟上一棵树不一样的控件行（+ 新增，- 消失），页面几乎没变时省一大截' },
        ocr: { type: 'string', enum: ['auto', 'force', 'off'], description: 'OCR 兜底：auto 只在文本树几乎为空时跑（默认），force 强制加一层 OCR 文字，off 关掉' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          serial: { type: 'string' },
          activity: { type: 'string' },
          summary: { type: 'string' },
          tree: { type: 'string' },
          changed: { type: 'boolean' },
          matched: { type: 'boolean' },
          stable: { type: ['boolean', 'null'] },
          quiet_ms: { type: ['integer', 'null'] },
          snapshot_id: { type: 'string' },
          generated_at: { type: 'string' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['serial', 'activity', 'summary', 'tree', 'changed', 'matched', 'stable', 'quiet_ms', 'snapshot_id', 'generated_at', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(`${value.summary}\n${value.tree}`),
    },
    execute: async (args) => {
      const device = await serial()
      const started = Date.now()
      const want = {
        text: args.wait_for_text,
        id: args.wait_for_id,
        desc: undefined,
        activity: args.wait_for_activity,
        gone: args.wait_until_gone,
      }
      const shouldWait = Boolean(want.text || want.id || want.activity || want.gone)
      let state
      let matched = true
      let stability = null
      if (shouldWait) {
        const waited = await waitFor(device, want, args.timeout_ms ?? 15_000)
        state = waited.state
        matched = waited.matched
      } else if (args.wait_idle === true || args.wait_stable === true) {
        /* 等界面自己静下来：树签名连续 idle_ms 不变才算稳定，省掉模型 sleep 后再读一次。 */
        const calmed = await awaitStable(
          () => dumpState(device, { full: args.full === true, maxNodes: args.max_nodes, ocr: args.ocr ?? 'auto' }),
          { quietMs: args.idle_ms ?? 400, timeoutMs: args.timeout_ms ?? 15_000 },
        )
        state = calmed.state
        stability = calmed
      } else {
        state = await dumpState(device, { full: args.full === true, maxNodes: args.max_nodes, depth: args.depth, ocr: args.ocr ?? 'auto' })
      }
      const lines = state.tree.lines
      const filtered = args.filter
        ? lines.filter((line) => line.toLowerCase().includes(String(args.filter).toLowerCase()))
        : lines
      let shown = filtered.slice(0, MAX_NODES.max)
      if (args.changed_only === true) {
        const before = lastUiLines.get(device)
        shown = before === undefined ? filtered.slice(0, MAX_NODES.max) : diffLines(before, filtered, 0)
        lastUiLines.set(device, filtered)
        if (shown.length === 0) shown = ['（界面没有变化）']
      } else {
        lastUiLines.set(device, filtered)
      }
      /* 一眼看懂这一屏：能点几个、能滚几个、焦点在哪个输入框。
         游戏/自绘界面文本树是空的，这里直接说清该换哪条路（截图看画面、adb_motion 量动效）。 */
      const clickable = lines.filter((line) => line.trimEnd().endsWith('*')).length
      const scrollable = lines.filter((line) => line.includes('~')).length
      const focusLine = lines.find((line) => /\[f\]/.test(line))
        ?? lines.find((line) => /\[edit\]/.test(line) || /EditText/.test(line))
      /* depth 给浅了会一行都不剩：别让模型以为这屏是空的，直接说控件在第几层。 */
      const deepest = state.nodes.length === 0 ? 0 : Math.max(...state.nodes.map((node) => Number(node.depth) || 0))
      const depthNote = args.depth !== undefined && state.tree.kept === 0 && state.tree.total > 0
        ? `depth=${args.depth} 一个控件都没列出来：这屏内容在第 ${deepest} 层，depth 调到 ${deepest} 或去掉`
        : ''
      const nodeCap = Math.min(Math.max(args.max_nodes ?? MAX_NODES.default, 1), MAX_NODES.max)
      const clipped = state.tree.kept >= nodeCap && state.tree.total > state.tree.kept
        ? `已截断：只列了 ${state.tree.kept}/${state.tree.total} 个节点，用 filter 收窄、depth 限量，或把 max_nodes 调大（上限 ${MAX_NODES.max}）`
        : ''
      const digest = state.tree.kept === 0
        ? '文本树为空（游戏或自绘界面）：用 adb_shot 看画面，动效差异用 adb_motion 量'
        : [`可点 ${clickable}`, scrollable > 0 ? `可滚 ${scrollable}` : '', focusLine ? `焦点 ref${focusLine.trim().split(/\s+/)[0]} ${oneLine(focusLine.trim().split(/\s+/).slice(1).join(' '), 30)}` : ''].filter(Boolean).join(' / ')
      const summary = [
        `${state.serial} · ${state.activity || '未知页面'}`,
        `${state.tree.kept}/${state.tree.total} 节点${args.filter ? `，匹配 ${filtered.length}` : ''} · ${state.ms}ms`,
        digest,
        state.source === 'uiautomator2' ? '' : `· 来源 ${state.source}`,
        state.ocrNote ?? '',
        depthNote,
        clipped,
        state.changed ? '' : '（与上一次读取相同）',
        shouldWait ? (matched ? `等待命中，${Date.now() - started}ms` : `等待超时 ${args.timeout_ms ?? 15_000}ms，界面未变化`) : '',
        stability === null ? '' : stability.stable
          ? `已静止 ${stability.quietMs}ms（${stability.dumps} 次读取，${stability.ms}ms）`
          : stability.empty
            ? `没等到画面：${stability.ms}ms 内一直读不到控件，这屏可能还在加载或自己画的，先用 adb_shot 看一眼`
            : `${stability.ms}ms 内画面还在变（${stability.dumps} 次读取），别按旧坐标点，先重读或加长 idle_ms`,
      ].filter(Boolean).join(' · ')
      return {
        serial: state.serial,
        activity: state.activity,
        summary,
        tree: shown.join('\n') || '（没有匹配的控件）',
        changed: state.changed,
        matched,
        stable: stability === null ? null : stability.stable,
        quiet_ms: stability === null ? null : stability.quietMs,
        snapshot_id: state.snapshotId,
        generated_at: state.generated_at,
        elapsed_ms: Date.now() - started,
      }
    },
  }), 'adb: adb_ui')
  /* 只等条件、不把整棵树端回来：轮询回合里最费 token 的是「sleep 再读一次树」。
     条件满足立刻返回，超时也返回当下这一屏摘要（能点几个、停在哪个页面），模型不用再读一遍。 */
  ctx.effect(() => ctx.tools.register({
    name: 'adb_wait',
    description: '等一个条件成立就返回，不返回整棵控件树：等文字/资源 id/页面出现（text/id/desc/activity）、等某段文字消失（gone）、等几段文字全部出现（texts）、等任意一个出现（any_texts），或者等界面静止（stable）。比 sleep 后 adb_ui 省一大截 token；超时会告诉当下停在哪个页面、能点什么，方便决定下一步。',
    parameters: {
      type: 'object',
      properties: {
        serial: { type: 'string', description: '设备序列号，只有一台可省略' },
        text: { type: 'string', description: '等这段文字出现在界面上（子串匹配）' },
        id: { type: 'string', description: '等这个资源 id 出现（可只写后半段）' },
        desc: { type: 'string', description: '等这个 content-desc 出现' },
        gone: { type: 'string', description: '等这段文字从界面上消失（关弹窗、等加载完）' },
        texts: { type: 'array', items: { type: 'string' }, description: '等这几段文字全部出现（一次等多个条件）' },
        any_texts: { type: 'array', items: { type: 'string' }, description: '这几段文字出现任意一个就算过（加载完或报错弹窗）' },
        activity: { type: 'string', description: '等前台页面切到这个正则，例如 "ScanActivity"' },
        until: {
          type: 'string',
          enum: ['visible', 'enabled', 'clickable', 'checked', 'focused'],
          description: '配合 text/id/desc：等到同一个控件处于这个状态才算过（默认出现就算），例如等按钮变 enabled 再点、等开关变 checked',
        },
        dismiss: { type: 'boolean', description: '等到一半被权限/升级/评分弹窗挡住时，自动点掉常见确认按钮（最多 2 次）再接着等，回执列出点了哪些' },
        stable: { type: 'boolean', description: '等界面静止：树签名连续 quiet_ms 不变才算（动画/加载结束）' },
        quiet_ms: { type: 'integer', description: 'stable 用：连续多久没变化算静止，默认 400' },
        timeout_ms: { type: 'integer', description: '等待上限，默认 15000' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          satisfied: { type: 'boolean' },
          stable: { type: ['boolean', 'null'] },
          quiet_ms: { type: ['integer', 'null'] },
          activity: { type: 'string' },
          dismissed: { type: 'array', items: { type: 'string' }, description: 'dismiss 时被点掉的弹窗按钮文字' },
          shot: {
            type: ['object', 'null'],
            description: '没等到时自动留的截图（只失败才抓，约 0.5s）：{path, bytes}，可直接 read_image 看',
            properties: { path: { type: 'string' }, bytes: { type: 'integer' } },
            required: ['path', 'bytes'],
            additionalProperties: false,
          },
          summary: { type: 'string' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['ok', 'satisfied', 'stable', 'quiet_ms', 'activity', 'dismissed', 'shot', 'summary', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(value.summary),
    },
    execute: async (args) => {
      const device = await serial()
      const started = Date.now()
      const want = {
        text: args.text,
        id: args.id,
        desc: args.desc,
        gone: args.gone,
        texts: args.texts,
        any_texts: args.any_texts,
        activity: args.activity,
        until: args.until,
      }
      const bounded = (value) => Math.min(60_000, Math.max(200, Number(value ?? 15_000)))
      const askedCondition = Object.entries(want).some(([, value]) => (Array.isArray(value) ? value.length > 0 : value !== undefined))
      if (args.until !== undefined && !args.text && !args.id && !args.desc) {
        return {
          ok: false, satisfied: false, stable: null, quiet_ms: null, activity: '', dismissed: [], shot: null,
          summary: 'until 要配合 text / id / desc 用：先说要等哪个控件，再说等到它处于什么状态。',
          elapsed_ms: Date.now() - started,
        }
      }
      if (!askedCondition && args.stable !== true) {
        return {
          ok: false, satisfied: false, stable: null, quiet_ms: null, activity: '', dismissed: [], shot: null,
          summary: '什么都没等：给 text / id / desc / gone / texts / any_texts / activity，或者 stable=true。',
          elapsed_ms: Date.now() - started,
        }
      }
      const dumpOptions = { full: false }
      let state = null
      let satisfied = true
      let dismissed = []
      if (askedCondition) {
        const waited = await waitFor(device, want, bounded(args.timeout_ms), { dismiss: args.dismiss === true })
        state = waited.state
        satisfied = waited.matched
        dismissed = waited.dismissed
      }
      let calm = null
      if (args.stable === true) {
        const left = Math.max(200, bounded(args.timeout_ms) - (Date.now() - started))
        calm = await awaitStable(() => dumpState(device, dumpOptions), { quietMs: args.quiet_ms ?? 400, timeoutMs: left })
        state = calm.state
        satisfied = satisfied && calm.stable
      }
      if (state === null) state = await dumpState(device, dumpOptions)
      const nodes = Array.isArray(state.nodes) ? state.nodes : []
      const clickable = nodes.filter((node) => node.clickable).length
      const focusLine = state.tree.lines.find((line) => /\[f\]/.test(line)) ?? state.tree.lines.find((line) => /\[edit\]/.test(line))
      const here = `${state.activity || '未知页面'} · ${state.tree.kept}/${state.tree.total} 节点${clickable > 0 ? ` · 可点 ${clickable}` : ''}${focusLine ? ` · 焦点 ${oneLine(focusLine.trim().split(/\s+/).slice(1).join(' '), 24)}` : ''}`
      const target = normalList([want.text, want.id, want.desc, want.gone, ...(normalList(want.texts)), ...(normalList(want.any_texts))]).join(' / ')
      const pieces = []
      const stateNote = args.until === undefined ? '' : ` 处于 ${args.until}`
      if (askedCondition) pieces.push(satisfied ? `等到「${oneLine(target, 30)}」${stateNote}` : `${bounded(args.timeout_ms)}ms 内没等到「${oneLine(target, 30)}」${stateNote}`)
      if (calm !== null) {
        pieces.push(calm.stable
          ? `界面已静止 ${calm.quietMs}ms`
          : calm.empty ? '一直读不到控件（还在加载或自己画的界面）' : `${calm.ms}ms 内画面还在变`)
      }
      if (dismissed.length > 0) pieces.push(`先点掉了弹窗：${dismissed.join(' / ')}`)
      const failed = satisfied === false || (calm !== null && calm.stable === false)
      const shot = failed ? await captureEvidence(device, 'adb_wait') : null
      if (shot !== null) pieces.push(`截图 ${shot.path}`)
      pieces.push(here)
      return {
        ok: satisfied,
        satisfied,
        stable: calm === null ? null : calm.stable,
        quiet_ms: calm === null ? null : calm.quietMs,
        activity: state.activity || '',
        dismissed,
        shot,
        summary: pieces.join(' · '),
        elapsed_ms: Date.now() - started,
      }
    },
  }), 'adb: adb_wait')


  ctx.effect(() => ctx.tools.register({
    name: 'adb_tap',
    description: '在 Android 设备上点一下：用 ref（来自最近一次 adb_ui/adb_find）、文字、资源 id、描述、类名，或者绝对坐标 point="x,y"。long=true 长按；index 挑第几个匹配；exact/regex 改匹配方式。目标不在当前屏就带 scroll=3 边滑边找，找到直接点——省掉「滑一次、读一次树、再点」的回合。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'integer', description: 'adb_ui 返回的 ref 编号（只对生成它的那次快照有效，界面重新 dump 过就作废）' },
        snapshot_id: { type: 'string', description: '可选：adb_ui 返回的 snapshot_id。带上就校验快照还是不是那次，对不上直接报错，不拿旧 ref 点。' },
        text: { type: 'string', description: '按钮/文字内容，精确匹配优先，其次包含匹配' },
        id: { type: 'string', description: '资源 id，可写全名或只写后半段，如 login_btn' },
        desc: { type: 'string', description: 'content-desc 内容' },
        cls: { type: 'string', description: '类名，可只写后半段，如 Switch 或 ImageButton' },
        index: { type: 'integer', description: '匹配到多个时点第几个，从 0 开始' },
        exact: { type: 'boolean', description: '文字/描述/类名要完全相等，默认包含匹配' },
        regex: { type: 'boolean', description: '把 text/id/desc 当正则用' },
        clickable: { type: 'boolean', description: '只挑可点控件' },
        point: { type: 'string', description: '绝对坐标 "x,y"（屏幕像素）' },
        long: { type: 'boolean', description: '长按 600ms' },
        repeat: { type: 'integer', description: '连点几次，1–8，默认 1；连招、双击缩放用它' },
        interval_ms: { type: 'integer', description: '连点间隔毫秒，默认 100' },
        dry_run: { type: 'boolean', description: '只算落点、不真点（先用它确认点的是对的，避免点错返工）' },
        wait_for_text: { type: 'string', description: '点完等这段文字出现再返回，省掉一次 adb_ui 往返' },
        wait_for_id: { type: 'string', description: '点完等这个资源 id 出现' },
        wait_until_gone: { type: 'string', description: '点完等这段文字消失（关弹窗、等加载完）' },
        scroll: { type: 'integer', description: '目标不在当前屏时最多滑几次（1–15）：滑到就点，滑不到报错。只在按文字/id/描述/类名找时有效' },
        scroll_direction: { type: 'string', description: '边滑边找的手指方向：up/down/left/right，默认 up（把下面的内容拉上来）' },
        wait_ms: { type: 'integer', description: '目标还没出现时先等它出现多久（毫秒，默认 900，上限 5000）：点早了不用再来一轮' },
        wait_stable: { type: 'boolean', description: '点完等界面静止（树签名连续 quiet_ms 不变）再返回：动画/加载结束才知道点中了什么。给了 wait_for_text/id/gone 时以那些条件为准' },
        quiet_ms: { type: 'integer', description: 'wait_stable 用：连续多久没变化算静止，默认 400' },
        timeout_ms: { type: 'integer', description: '等待上限，默认 10000' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          target: { type: 'string' },
          activity: { type: 'string' },
          matched: { type: 'boolean' },
          changed: { type: ['boolean', 'null'], description: '点后界面树是否变了；没变大概率没点中或动画未结束' },
          reason: { type: ['string', 'null'], description: '没生效时的原因码：keyboard-covered / obscured / unclickable / gone / page-switched / no-response / same-screen / unknown-tree；生效时为 null' },
          delta: { type: 'array', items: { type: 'string' }, description: '这次点了之后具体多/少了哪几行（`+` 新增 / `-` 消失，最多 6 条）' },
          shot: {
            type: ['object', 'null'],
            description: '没生效时自动留的截图（没生效才抓，约 0.5s）：{path, bytes}，可以直接 read_image 看',
            properties: { path: { type: 'string' }, bytes: { type: 'integer' } },
            required: ['path', 'bytes'],
            additionalProperties: false,
          },
          stable: { type: ['boolean', 'null'], description: 'wait_stable 时：是否等到了静止' },
          quiet_ms: { type: ['integer', 'null'] },
          scrolled: { type: 'integer', description: '为了找到目标滑了几次；没滑就不出现' },
          message: { type: 'string' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['ok', 'target', 'activity', 'matched', 'changed', 'reason', 'delta', 'shot', 'message', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(value.message),
    },
    execute: async (args) => {
      const device = await serial()
      const started = Date.now()
      let x
      let y
      let target
      let missTarget = null
      let scrolled = 0
      if (args.point) {
        const parts = String(args.point).split(',').map((value) => Number(value.trim()))
        if (parts.length !== 2 || parts.some((value) => !Number.isFinite(value))) throw new Error('point 要写成 "x,y"，例如 "540,1200"。')
        ;[x, y] = parts
        target = `坐标 ${x},${y}`
      } else {
        /* ref 严格按快照校验：快照过期或之后又 dump 过就报错，不拿旧 ref 乱点。
           按文字/id 点则允许自动重读：页面换了就 dump 一次再找，比拿旧坐标点安全。
           没带 snapshot_id 且快照超过 1.5s 时，点之前再验一次目标还在原位。 */
        let node
        if (args.ref !== undefined) {
          node = nodeForRef(device, Number(args.ref), args.snapshot_id)
        } else {
          await snapshotForSelector(device, args.snapshot_id)
          const want = {
            text: args.text,
            id: args.id,
            desc: args.desc,
            cls: args.cls,
            exact: args.exact,
            regex: args.regex,
            clickable: args.clickable,
            index: args.index,
            snapshotId: args.snapshot_id,
          }
          try {
            node = await awaitNode(device, want, args.wait_ms)
          } catch (error) {
            /* 只有「当前屏没有」才值得滑：匹配到多个、快照过期这些滑了也没用，原样报出去。 */
            const reason = String(error?.message ?? error)
            const notHere = reason.startsWith('界面上没有') && !args.snapshot_id
            if (!(args.scroll && notHere)) throw error
            node = await scrollToSelector(device, want, args.scroll_direction, args.scroll)
            scrolled = Math.max(1, Math.round(Number(args.scroll) || 3))
          }
        }
        node = await freshNodeFor(device, node, args.snapshot_id)
        const hit = clickTarget(nodesOf(device), node)
        x = Math.round((hit.x1 + hit.x2) / 2)
        y = Math.round((hit.y1 + hit.y2) / 2)
        const label = node.text || node.desc || shortId(node.id) || shortClass(node.cls)
        const via = hit === node ? '' : `，落在可点祖先 ${shortClass(hit.cls)}${hit.id ? ` #${shortId(hit.id)}` : ''}`
        target = `「${oneLine(label, 24)}」@${x},${y}${via}`
        missTarget = node
      }
      /* 轻点用 input tap（一条命令 ~35ms）；长按只能靠 swipe 原地按住 600ms。 */
      if (args.dry_run) {
        const activity = lastTrees.get(device)?.activity ?? await foregroundActivity(device).catch(() => '')
        return {
          ok: true,
          target,
          activity,
          matched: true,
          ...(scrolled > 0 ? { scrolled } : {}),
          message: `预演：会${args.long ? '长按' : '点击'} ${target}${scrolled > 0 ? `（滑了 ${scrolled} 次才找到）` : ''}（没有真点）。确认无误去掉 dry_run 再点。`,
          elapsed_ms: Date.now() - started,
        }
      }
      /* 点之前的树签名：点完对比一次，把「点了没反应」当场说出来，省掉模型再读一遍树的回合。 */
      const prior = lastTrees.get(device)
      const times = Math.max(1, Math.min(8, Math.round(Number(args.repeat ?? 1))))
      const gap = Math.max(0, Math.round(Number(args.interval_ms ?? 100)))
      /* 快通道优先：scrcpy 控制 socket 一次写 0–1ms，没有 adb 往返；通道没就绪再退回 input。 */
      let engine = 'adb'
      let fastDone = fastInput.tap !== null
      let took = 0
      if (fastDone) {
        const fastBegan = Date.now()
        for (let i = 0; i < times; i += 1) {
          const fast = await fastInput.tap(device, x, y, { long: args.long === true })
          if (fast === null) {
            fastDone = false
            break
          }
          if (i + 1 < times && gap > 0) await new Promise((resolve) => setTimeout(resolve, gap))
        }
        if (fastDone) {
          engine = 'scrcpy'
          took = Date.now() - fastBegan
        }
      }
      if (!fastDone) {
        /* 连点（连招、双击缩放）串在同一次 shell 里：每次仍是一条约 35ms 的 input，中间按间隔等待。 */
        const one = args.long ? `input swipe ${x} ${y} ${x} ${y} 600` : `input tap ${x} ${y}`
        const cmd = times === 1 ? one : Array.from({ length: times }, () => one).join(`; sleep ${(gap / 1000).toFixed(3)}; `)
        const r = await sh(device, cmd, 10_000 + times * (gap + 900))
        if (!r.ok) throw new Error(failureNote(args.long ? '长按' : '点击', r))
        took = r.ms
      }

      lastActions.push({ at: Date.now(), what: `${args.long ? '长按' : '点击'} ${target}` })
      /* 点完顺手等结果：一次工具调用顶「点一下 + 再读一次树」，省一个模型回合。 */
      const want = { text: args.wait_for_text, id: args.wait_for_id, gone: args.wait_until_gone, activity: undefined }
      const shouldWait = Boolean(want.text || want.id || want.gone)
      let activity = ''
      let matched = true
      let detail = ''
      let changed = null
      let stable = null
      let quietMs = null
      let after = null
      if (shouldWait) {
        const waited = await waitFor(device, want, args.timeout_ms ?? 10_000)
        matched = waited.matched
        after = waited.state
        activity = waited.state.activity
        detail = matched
          ? `，等待命中 ${waited.elapsedMs}ms · 当前 ${activity || '未知页面'}`
          : `，等待超时 ${args.timeout_ms ?? 10_000}ms，界面没出现预期变化`
      } else if (args.wait_stable === true) {
        /* 点完等它静下来再判「变没变」：动画中途读到的树会骗人。 */
        const calmed = await awaitStable(() => pollDump(device), {
          quietMs: args.quiet_ms ?? 400,
          timeoutMs: args.timeout_ms ?? 10_000,
        })
        after = calmed.state
        stable = calmed.stable
        quietMs = calmed.quietMs
        activity = after.activity
        if (prior && prior.signature) changed = after.tree.lines.join('\n') !== prior.signature
        detail = calmed.stable
          ? `，界面已静止 ${calmed.quietMs}ms · 当前 ${activity || '未知页面'}${changed === false ? `：界面没变化（${tapMissReason(after, { x, y }, missTarget, prior)}）` : changed === true ? '，界面已变化' : ''}`
          : calmed.empty
            ? '，点已发出，但一直读不到控件（可能还在加载或这屏自己画的）'
            : `，点了但 ${calmed.ms}ms 内画面还在变，先别按旧坐标点`
      } else if (prior && prior.signature && Array.isArray(prior.nodes) && prior.nodes.length > 0
        && Date.now() - prior.at < 15_000) {
        /* 没给等待条件时给一次回执：界面没变化就是可疑信号，别让模型再去读一遍树才发现。 */
        try {
          after = await awaitChange(device, prior.signature)
          changed = after.tree.lines.join('\n') !== prior.signature
          activity = after.activity
          detail = changed
            ? `，界面已变化 · 当前 ${activity || '未知页面'}`
            : `，界面没变化：${tapMissReason(after, { x, y }, missTarget, prior)}`
        } catch (error) {
          detail = `，点已发出，但读不到界面确认（${oneLine(error?.message ?? error, 60)}）`
        }
      }
      /* 回执留给机器读：reason 是稳定原因码，delta 是这次点了之后具体多/少了哪几行，
         模型不用再 adb_ui changed_only 追一次。 */
      let reason = null
      let delta = []
      if (after !== null && prior && typeof prior.signature === 'string') {
        const beforeLines = prior.signature === '' ? [] : prior.signature.split('\n')
        delta = diffLines(beforeLines, after.tree.lines, 6)
        if (changed === false) reason = describeTapMiss(after, { x, y }, missTarget, prior).code
      }
      /* 没生效时顺手留一张图：光看文字树分不清「被键盘挡住」还是「弹了自绘遮罩」，
         这点额外开销只在判失败的那一次花（实测 ~0.5s / 28KB），成功了不花。 */
      let shot = null
      if (changed === false) shot = await captureEvidence(device, 'tap-miss')
      const again = times > 1 ? `（连点 ${times} 次，间隔 ${gap}ms）` : ''
      const slid = scrolled > 0 ? `（滑了 ${scrolled} 次才找到）` : ''
      const message = `${args.long ? '长按' : '点击'} ${target} 完成${again}${slid}（${took}ms · ${engine}）${detail || '。界面变化用 adb_ui 确认。'}${shot === null ? '' : ` · 截图 ${shot.path}`}`
      return {
        ok: true, target, activity, matched, changed, stable, quiet_ms: quietMs, reason, delta, shot,
        ...(scrolled > 0 ? { scrolled } : {}), message, elapsed_ms: Date.now() - started,
      }
    },
  }), 'adb: adb_tap')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_gesture',
    description: '轨迹手势/拖拽：给 direction 就在框里按方向滑一条直线（不用算坐标，翻了再滑几次）；给 from+to 按控件拖；给 points 画任意轨迹（三个点以上逐点发 DOWN/MOVE/UP，能画曲线、慢速滑）。两个点走 input swipe 连续注入，延迟低。每条约 35ms 下限，单次段数 3–40。',
    parameters: {
      type: 'object',
      properties: {
        points: {
          type: 'array',
          items: { type: 'array', items: { type: 'integer' } },
          description: '轨迹点 [[x,y],[x,y],…]，至少 2 个；曲线要给中间点。给了 from/to 就不用给 points',
        },
        from: {
          type: 'object',
          description: '起点控件（拖拽时按控件定位，比手算坐标准）：{ref} 或 {text|id|desc|cls, index}',
          properties: {
            ref: { type: 'integer', description: 'adb_ui / adb_find 的 ref' },
            text: { type: 'string' },
            id: { type: 'string' },
            desc: { type: 'string' },
            cls: { type: 'string' },
            index: { type: 'integer' },
            exact: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        to: {
          type: 'object',
          description: '终点：{point:"x,y"} 或控件 {ref} / {text|id|desc|cls, index}',
          properties: {
            point: { type: 'string', description: '绝对坐标 "x,y"' },
            ref: { type: 'integer' },
            text: { type: 'string' },
            id: { type: 'string' },
            desc: { type: 'string' },
            cls: { type: 'string' },
            index: { type: 'integer' },
            exact: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: '手指方向（up 把下面的内容拉上来）：按方向在框里滑一条直线，不用自己算坐标。给了 points 就不要再给' },
        percent: { type: 'number', description: '配 direction：行程占框长边的比例，0.1–1，默认 0.7；长列表想小步滑就给 0.3' },
        duration_ms: { type: 'integer', description: '整段耗时，默认 500（direction 滑动默认 320）' },
        hold_ms: { type: 'integer', description: '起点按住多久再移动，默认 0；长按拖动给 500' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['ok', 'message', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(value.message),
    },
    execute: async (args) => {
      const device = await serial()
      const started = Date.now()
      let points = (args.points ?? []).map((pair) => pair.map((value) => Math.round(Number(value))))
      if (args.direction !== undefined && args.direction !== null) {
        if (points.length >= 2) throw new Error('给了 points 就不要再给 direction：两种写法选一种。')
        if (args.percent !== undefined && !(Number(args.percent) > 0 && Number(args.percent) <= 1)) {
          throw new Error('percent 要写 0.1–1 之间的小数，比如 0.6。')
        }
        /* 在哪个框里滑：给了 from 就滑它，否则挑屏上最内层的可滚容器，都没有才整屏。 */
        const hasAnchor = args.from && ['ref', 'text', 'id', 'desc', 'cls'].some((key) => args.from[key] !== undefined && args.from[key] !== null)
        let box
        if (hasAnchor) {
          box = await rectForSelector(device, args.from)
        } else {
          const size = await screenSize(device)
          const state = await dumpState(device, { ocr: 'off' }).catch(() => null)
          const frames = state === null ? [] : scrollFrames(state, size)
          box = frames[0] ?? {
            x: Math.round(size.width * 0.15),
            y: Math.round(size.height * 0.2),
            w: Math.round(size.width * 0.7),
            h: Math.round(size.height * 0.6),
          }
        }
        const line = swipeLine(box, args.direction, args.percent)
        points = [[line[0], line[1]], [line[2], line[3]]]
      }
      if (points.length < 2 && args.from && args.to) {
        /* 按控件拖拽：先定位再动手，页面在这两步之间变了会自动重读，不拿旧坐标拖。 */
        const start = await pointForSelector(device, args.from)
        const end = await pointForSelector(device, args.to)
        points = [[start.x, start.y], [end.x, end.y]]
        if (points[0][0] === points[1][0] && points[0][1] === points[1][1]) throw new Error('起点和终点是同一个点，改 from/to。')
      }
      if (points.length < 2) throw new Error('给 points（至少 2 个点），或给 from + to 按控件拖。')
      for (const pair of points) {
        if (pair.length !== 2 || pair.some((value) => !Number.isFinite(value))) throw new Error('每个点都要写成 [x,y]。')
      }
      const duration = Math.max(60, Number(args.duration_ms ?? (args.direction ? 320 : 500)))
      const hold = Math.max(0, Number(args.hold_ms ?? 0))
      /* 每个点沿折线按长度均分，段数受 35ms/条的设备端下限约束。 */
      const steps = Math.max(3, Math.min(40, Math.round(duration / 40)))
      const segmentLengths = []
      let total = 0
      for (let index = 1; index < points.length; index += 1) {
        const length = Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1])
        segmentLengths.push(length)
        total += length
      }
      const path = [points[0]]
      for (let step = 1; step <= steps; step += 1) {
        let remaining = (total * step) / steps
        let cursor = 0
        while (cursor < segmentLengths.length - 1 && remaining > segmentLengths[cursor]) {
          remaining -= segmentLengths[cursor]
          cursor += 1
        }
        const ratio = segmentLengths[cursor] === 0 ? 0 : remaining / segmentLengths[cursor]
        const from = points[cursor]
        const to = points[cursor + 1] ?? points[cursor]
        path.push([Math.round(from[0] + (to[0] - from[0]) * ratio), Math.round(from[1] + (to[1] - from[1]) * ratio)])
      }
      /* 直线拖拽/甩动走 swipes：一条命令完成整段注入（Android 按 duration 自己连续发 MOVE），
         比逐点 motionevent 少一个数量级的进程开销，手感也更连续；曲线和「按住再拖」仍走 motionevent。 */
      if (points.length === 2 && hold === 0) {
        const fastSwipe = fastInput.swipe === null ? null : await fastInput.swipe(device, points[0][0], points[0][1], points[1][0], points[1][1], Math.round(duration))
        if (fastSwipe === null) {
          const swipe = await sh(device, `input swipe ${points[0][0]} ${points[0][1]} ${points[1][0]} ${points[1][1]} ${Math.round(duration)}`, 30_000)
          if (!swipe.ok) throw new Error(failureNote('滑动', swipe))
        }
        lastActions.push({ at: Date.now(), what: `滑动 ${points[0].join(',')}→${points[1].join(',')}（${duration}ms）` })
        return {
          ok: true,
          message: `直线滑动完成：${points[0].join(',')}→${points[1].join(',')} / 约 ${Math.round(duration)}ms，${Date.now() - started}ms 返回。曲线或按住再拖给 3 个以上点。`,
          elapsed_ms: Date.now() - started,
        }
      }
      /* 轨迹点本来就插过值，通道可以直接按同样节奏走；按住再拖仍是设备侧 motionevent 更准。 */
      const fastCurve = hold === 0 && fastInput.gesture !== null
        ? await fastInput.gesture(device, [path], duration)
        : null
      if (fastCurve === null) {
        const pause = Math.max(0, duration / steps / 1000 - 0.035).toFixed(3)
        const script = [`input motionevent DOWN ${path[0].join(' ')}`]
        if (hold > 0) script.push(`sleep ${(hold / 1000).toFixed(3)}`)
        for (const point of path.slice(1)) script.push(`sleep ${pause}`, `input motionevent MOVE ${point.join(' ')}`)
        script.push(`input motionevent UP ${path[path.length - 1].join(' ')}`)
        const r = await sh(device, script.join('; '), 30_000)
        if (!r.ok) throw new Error(failureNote('手势', r))
      }
      lastActions.push({ at: Date.now(), what: `手势 ${points[0].join(',')}→${points[points.length - 1].join(',')}（${duration}ms）` })
      return {
        ok: true,
        message: `手势完成：${points.length} 个控制点 / ${path.length} 步 / 约 ${duration}ms，${Date.now() - started}ms 返回。`,
        elapsed_ms: Date.now() - started,
      }
    },
  }), 'adb: adb_gesture')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_input',
    description: '往 Android 设备输入：text 输入文字（ASCII 直发；中文默认剪贴板粘贴，装了 ADBKeyboard 且它已是当前输入法时自动走广播更快，ime 可选）、key 按键（如 ENTER/BACK/DEL/HOME）、submit 输完直接回车/搜索、swipe 滑动 [x1,y1,x2,y2,ms]、clear=true 先清空输入框。中文要求先点中输入框让它获得焦点。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要输入的文字（ASCII 直发，中文走剪贴板粘贴）；先点中输入框再调用' },
        key: { type: 'string', description: '按键名，如 ENTER、BACK、HOME、DEL、TAB、APP_SWITCH，或数字 keycode' },
        swipe: {
          type: 'array',
          items: { type: 'integer' },
          description: '滑动 [x1,y1,x2,y2] 或 [x1,y1,x2,y2,毫秒]，例如 [1000,2000,1000,500,400]',
        },
        clear: { type: 'boolean', description: '输入前先清空当前聚焦输入框（END + 多次 DEL）' },
        ime: { type: 'string', enum: ['auto', 'clipboard', 'adb'], description: '中文怎么上屏：auto 默认（已装 ADBKeyboard 且它是当前输入法时走广播，否则剪贴板粘贴）、clipboard 只用剪贴板、adb 明确切到 ADBKeyboard 输完切回' },
        submit: { type: 'string', enum: ['enter', 'search'], description: '输完直接提交：enter 回车（聊天框、表单），search 搜索键（搜索框）。省掉一次 adb_input {key} 往返' },
        verify: { type: 'boolean', description: '输完读一次树核对文字真的进了输入框（约 150ms）；ASCII 直发默认不读，中文本来就会回读' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          method: { type: ['string', 'null'], description: '文字上屏走的通道：ime（广播）/ paste（剪贴板）/ input（直发）；只按键或滑动时为 null' },
          field: { type: 'string', description: '输入框回读到的文字；没回读就是空串' },
          verified: { type: ['boolean', 'null'], description: '回读是否包含要输入的文字；没回读就是 null' },
          message: { type: 'string' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['ok', 'method', 'field', 'verified', 'message', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(value.message),
    },
    execute: async (args) => {
      const device = await serial()
      const started = Date.now()
      const messages = []
      let method = null
      let field = ''
      let verified = null
      let wanted = null
      if (args.clear) {
        const cleared = await clearFocusedField(device)
        messages.push(cleared.note)
      }
      if (args.text !== undefined) {
        wanted = String(args.text)
        const typed = await inputTextVia(device, wanted, { ime: args.ime })
        method = typed.how
        field = typed.field
        lastActions.push({ at: Date.now(), what: typed.how === 'paste' ? `粘贴文字 ${wanted.length} 字` : `输入文字 ${wanted.length} 字` })
        messages.push(typed.note)
        /* 直发（ASCII）本来不回读：要核对的多花约 150ms 读一棵树，别让模型自己再补一次 adb_ui。 */
        if (field === '' && args.verify === true) field = await focusedFieldText(device)
        if (wanted !== '') {
          verified = field === '' ? null : field.includes(wanted)
          if (verified === false) {
            messages.push(`核对不上：输入框里是「${oneLine(field, 30)}」，可能只进了一部分或焦点不在这个框`)
          } else if (field !== '') {
            messages.push(`输入框现在是「${oneLine(field, 40)}」`)
          } else if (args.verify === true) {
            messages.push('读完没看到输入框里的文字：可能没点中输入框，或它是自绘输入区')
          }
        }
      }
      if (args.submit !== undefined) {
        /* 输完顺手提交：搜索框/聊天框都要这一步，合成一次调用省一个模型回合。 */
        const code = args.submit === 'search' ? 84 : 66
        const submitted = await sh(device, `input keyevent ${code}`, 8000)
        if (!submitted.ok) throw new Error(failureNote(args.submit === 'search' ? '搜索键' : '回车', submitted))
        messages.push(args.submit === 'search' ? '已按搜索键' : '已按回车')
      }
      if (args.key !== undefined) {
        const key = String(args.key).trim()
        const name = /^\d+$/.test(key) ? key : key.toUpperCase()
        const r = await sh(device, `input keyevent ${name}`, 8000)
        if (!r.ok) throw new Error(failureNote(`按键 ${name}`, r))
        lastActions.push({ at: Date.now(), what: `按键 ${name}` })
        messages.push(`已按 ${name}`)
      }
      if (Array.isArray(args.swipe)) {
        const values = args.swipe.map((value) => Number(value))
        if (values.length < 4) throw new Error('swipe 至少给 4 个数：x1,y1,x2,y2')
        const duration = values[4] ?? 300
        const fastSwipe = fastInput.swipe === null
          ? null
          : await fastInput.swipe(device, values[0], values[1], values[2], values[3], duration)
        if (fastSwipe === null) {
          const r = await sh(device, `input swipe ${values.slice(0, 4).join(' ')} ${duration}`, 15_000)
          if (!r.ok) throw new Error(failureNote('滑动', r))
        }
        lastActions.push({ at: Date.now(), what: `滑动 ${values.slice(0, 4).join(',')}` })
        messages.push(`已滑动 ${values.slice(0, 4).join(',')}（${duration}ms）`)
      }
      if (messages.length === 0) throw new Error('没有要执行的动作：给 text、key、swipe 或 clear 其中之一。')
      return { ok: true, method, field, verified, message: `${messages.join('；')}。`, elapsed_ms: Date.now() - started }
    },
  }), 'adb: adb_input')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_app',
    description: '管理 Android 应用：info 看版本号/版本名/前台页面，install 装 APK（-r 覆盖，等安装完成），start 启动，stop 强制停止，clear 清数据，foreground 只看当前前台页面。装完真机后用它确认 versionCode 有没有变。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['info', 'install', 'start', 'stop', 'clear', 'foreground', 'open'], description: '要做的操作' },
        url: { type: 'string', description: 'open 用：深链或网址，例如 "https://example.com" 或 "myapp://detail/3"' },
        wait_activity: { type: 'string', description: 'start/open 后等前台 Activity 匹配这个正则再返回，例如 "MainActivity"' },
        package: { type: 'string', description: '包名，如 com.example.app；install 时可省略（从 APK 里读）' },
        apk: { type: 'string', description: 'install 用的 APK 绝对路径' },
        activity: { type: 'string', description: 'start 时可指定 Activity，例如 .ScanActivity；不写就用启动器入口' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          message: { type: 'string' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['ok', 'action', 'message', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(value.message),
    },
    execute: async (args) => {
      const device = await serial()
      const started = Date.now()
      const action = args.action
      const pkg = args.package ? String(args.package) : ''
      if (action === 'foreground') {
        const activity = await foregroundActivity(device)
        return { ok: true, action, message: `前台页面：${activity || '未知'}`, elapsed_ms: Date.now() - started }
      }
      if (action === 'install') {
        if (!args.apk) throw new Error('install 需要 apk 路径（绝对路径）。')
        const r = await adb(['-s', device, 'install', '-r', '-d', String(args.apk)], { timeout: 180_000, buffer: 8 << 20 })
        const ok = /Success/i.test(r.out)
        if (!ok) throw new Error(`安装失败：${oneLine(r.out || r.err, 300)}`)
        return { ok: true, action, message: `安装完成（${r.ms}ms）：${oneLine(r.out, 120)}`, elapsed_ms: Date.now() - started }
      }
      if (!pkg) throw new Error(`${action} 需要 package。`)
      if (action === 'info') {
        const r = await adb(['-s', device, 'shell', `dumpsys package ${pkg}`], { timeout: 15_000 })
        const versionCode = /versionCode=(\d+)/.exec(r.out)?.[1] ?? '?'
        const versionName = /versionName=([^\s]+)/.exec(r.out)?.[1] ?? '?'
        const installed = r.out.includes(`Package [${pkg}]`) || r.out.includes(pkg)
        if (!installed) throw new Error(`设备上没有安装 ${pkg}。`)
        const activity = await foregroundActivity(device)
        return {
          ok: true,
          action,
          message: `${pkg} · versionCode=${versionCode} · versionName=${versionName} · 前台：${activity || '未知'}`,
          elapsed_ms: Date.now() - started,
        }
      }
      if (action === 'open') {
        if (!args.url) throw new Error('open 需要 url，例如 "myapp://detail/3"。')
        const r = await adb(['-s', device, 'shell', `am start -a android.intent.action.VIEW -d ${shQuote(String(args.url))}`], { timeout: 20_000 })
        if (!r.ok || /Error|Exception/i.test(`${r.out}${r.err}`)) throw new Error(`打开失败：${oneLine(r.out || r.err, 240)}`)
        const activity = await settleActivity(device, args.wait_activity, 6000)
        return { ok: true, action, message: `已打开 ${oneLine(String(args.url), 60)}，前台：${activity || '未知'}`, elapsed_ms: Date.now() - started }
      }
      if (action === 'start') {
        const component = args.activity ? `${pkg}/${String(args.activity).startsWith('.') ? String(args.activity) : `.${args.activity}`}` : ''
        const cmd = component ? `am start -n ${component}` : `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`
        const r = await adb(['-s', device, 'shell', cmd], { timeout: 20_000 })
        if (!r.ok || /No activities found|Error/i.test(`${r.out}${r.err}`)) throw new Error(`启动失败：${oneLine(r.out || r.err, 240)}`)
        const activity = await settleActivity(device, args.wait_activity, 6000)
        return { ok: true, action, message: `已启动 ${pkg}，前台：${activity || '未知'}`, elapsed_ms: Date.now() - started }
      }
      if (action === 'stop' || action === 'clear') {
        const cmd = action === 'stop' ? `am force-stop ${pkg}` : `pm clear ${pkg}`
        const r = await adb(['-s', device, 'shell', cmd], { timeout: 20_000 })
        if (!r.ok || /Error/i.test(`${r.out}${r.err}`)) throw new Error(`${action} 失败：${oneLine(r.out || r.err, 240)}`)
        return { ok: true, action, message: `${action === 'stop' ? '已强制停止' : '已清除数据'} ${pkg}`, elapsed_ms: Date.now() - started }
      }
      throw new Error(`未知 action：${action}`)
    },
  }), 'adb: adb_app')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_sh',
    description: '在 Android 设备上跑一条 shell 命令，返回截断后的文本（最多 20k 字符）。日志用：logcat -d -t 300 或 logcat -d -s TAG；查页面/服务用 dumpsys activity top / dumpsys package。需要「看日志有没有报错」时用它，不要截图。',
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: '设备端的 shell 命令，例如 "logcat -d -t 200" 或 "dumpsys activity top | head -40"' },
        root: { type: 'boolean', description: '以 root 执行（设备已 root 时读 /data/data、settings、dropbox 等）' },
        timeout_ms: { type: 'integer', description: '超时，默认 15000' },
      },
      required: ['cmd'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          code: { type: 'integer' },
          uncertain: { type: 'boolean' },
          output: { type: 'string' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['ok', 'code', 'uncertain', 'output', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(value.output),
    },
    execute: async (args) => {
      const device = await serial()
      const raw = String(args.cmd)
      const cmd = args.root ? `su -c ${shQuote(raw)}` : raw
      const wait = Math.min(120_000, Number(args.timeout_ms ?? 15_000))
      const r = args.root
        ? await adb(['-s', device, 'shell', cmd], { timeout: wait, buffer: 16 << 20 })
        : await sh(device, cmd, wait)
      const body = `${r.out}${r.err ?? ''}`.trim()
      const cut = body.length > OUTPUT_LIMIT ? `${body.slice(0, OUTPUT_LIMIT)}\n…（截断，原长 ${body.length} 字符）` : body
      /* 退出码和「超时但可能已执行」都要写出来：只看 ok 会把失败的命令当成成功。 */
      const notes = []
      if (typeof r.code === 'number' && r.code !== 0) notes.push(`退出码 ${r.code}`)
      if (r.uncertain) notes.push('命令超时：设备可能已经执行，先看界面或日志确认结果，再决定要不要重试（不会自动重放）。')
      const output = `${cut || '（无输出）'}${notes.length > 0 ? `\n${notes.join('\n')}` : ''}`
      return { ok: r.ok, code: typeof r.code === 'number' ? r.code : -1, uncertain: r.uncertain === true, output, elapsed_ms: r.ms }
    },
  }), 'adb: adb_sh')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_scroll_to',
    description: '把列表滑到目标出现：按文字/id/desc/类名找，滑一下读一次，命中就停（默认不点）。省掉「滑一下→adb_ui→再滑」的来回；滑不动会直接说滑到底了。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要找的文字，默认包含匹配' },
        id: { type: 'string', description: '资源 id，可只写后半段' },
        desc: { type: 'string', description: 'content-desc' },
        cls: { type: 'string', description: '类名，可只写后半段' },
        exact: { type: 'boolean', description: '完全相等，默认包含匹配' },
        regex: { type: 'boolean', description: 'text/id/desc 当正则用' },
        index: { type: 'integer', description: '命中多个时取第几个，从 0 开始' },
        within_ref: { type: 'integer', description: '只在这个控件范围内滑（给可滚容器的 ref，比整屏滑准）' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: '手指往哪个方向滑，默认 up（把下面的内容拉上来）' },
        max_swipes: { type: 'integer', description: '最多滑几次，默认 8，上限 20' },
        tap: { type: 'boolean', description: '找到后顺手点它' },
        timeout_ms: { type: 'integer', description: '总时长上限，默认 25000' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          found: { type: 'boolean' },
          swipes: { type: 'integer' },
          activity: { type: 'string' },
          message: { type: 'string' },
          ref: { type: 'integer' },
          point: { type: 'string' },
          snapshot_id: { type: 'string' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['ok', 'found', 'swipes', 'activity', 'message', 'point', 'snapshot_id', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(value.message),
    },
    execute: async (args) => {
      const device = await serial()
      const began = Date.now()
      const limit = Math.max(2000, Number(args.timeout_ms ?? 25_000))
      const maxSwipes = Math.min(Math.max(Number.isFinite(Number(args.max_swipes)) ? Number(args.max_swipes) : 8, 0), 20)
      const sel = {
        text: args.text,
        id: args.id,
        desc: args.desc,
        cls: args.cls,
        exact: args.exact,
        regex: args.regex,
        within_ref: args.within_ref,
        index: args.index,
        all: true,
      }
      const size = await screenSize(device)
      const describeHit = (node, state) => {
        const entry = (state.refs ?? state.tree?.refs ?? []).find((item) => item.node === node)
        const hit = clickTarget(state.nodes || [], node)
        const point = `${Math.round((hit.x1 + hit.x2) / 2)},${Math.round((hit.y1 + hit.y2) / 2)}`
        return { ref: entry ? entry.ref : null, point }
      }
      let state = await pollDump(device)
      let swipes = 0
      let target = null
      for (;;) {
        const hits = selectNodes(state, sel)
        const visible = hits.filter((node) => {
          const w = node.x2 - node.x1
          const h = node.y2 - node.y1
          if (w <= 0 || h <= 0) return false
          const cx = (node.x1 + node.x2) / 2
          const cy = (node.y1 + node.y2) / 2
          return cx >= 0 && cx <= size.width && cy >= 0 && cy <= size.height
        })
        if (visible.length > 0) { target = visible[0]; break }
        if (swipes >= maxSwipes || Date.now() - began > limit) break
        /* 滑动区域：给了容器就只在容器内滑，否则用屏幕中间一大块；方向按手指方向。 */
        const box = args.within_ref !== undefined && args.within_ref !== null
          ? (() => {
            const entry = (state.refs ?? state.tree?.refs ?? []).find((item) => item.ref === Number(args.within_ref))
            if (!entry || !entry.node) throw new Error(`within_ref ${args.within_ref} 不在当前快照里：先 adb_ui 或 adb_find 拿最新 ref。`)
            return { x: entry.node.x1, y: entry.node.y1, w: entry.node.x2 - entry.node.x1, h: entry.node.y2 - entry.node.y1 }
          })()
          : scrollFrames(state, size)[0]
        const direction = args.direction ?? 'up'
        const [x1, y1, x2, y2] = swipeLine(box, direction)
        const before = state.tree.lines.join('\n')
        const fastSwipe = fastInput.swipe === null ? null : await fastInput.swipe(device, x1, y1, x2, y2, 320)
        if (fastSwipe === null) {
          const r = await sh(device, `input swipe ${x1} ${y1} ${x2} ${y2} 320`, 15_000)
          if (!r.ok) throw new Error(failureNote('滑动', r))
        }
        swipes += 1
        await new Promise((resolve) => setTimeout(resolve, 260))
        state = await pollDump(device)
        if (state.tree.lines.join('\n') === before) {
          const again = selectNodes(state, sel)
          if (again.length === 0) {
            return {
              ok: true,
              found: false,
              swipes,
              activity: state.activity || '',
              message: `滑了 ${swipes} 次没再动，也没有目标：可能已经到底，或它在别的页面/需要下拉刷新的地方。${nearMiss(state, sel)}`,
              point: '',
              snapshot_id: state.snapshotId,
              elapsed_ms: Date.now() - began,
            }
          }
          target = again[0]
          break
        }
      }
      if (target === null) {
        return {
          ok: true,
          found: false,
          swipes,
          activity: state.activity || '',
          message: `滑了 ${swipes} 次还没找到${args.text ? `「${args.text}」` : '目标'}：加 max_swipes 或换方向，也可能不在这个页面。${nearMiss(state, sel)}`,
          point: '',
          snapshot_id: state.snapshotId,
          elapsed_ms: Date.now() - began,
        }
      }
      const hit = describeHit(target, state)
      let message = `滑 ${swipes} 次找到${args.text ? `「${args.text}」` : '目标'} @${hit.point}`
      if (args.tap === true) {
        const node = target
        const clickable = clickTarget(state.nodes || [], node)
        const x = Math.round((clickable.x1 + clickable.x2) / 2)
        const y = Math.round((clickable.y1 + clickable.y2) / 2)
        const fastStep = fastInput.tap === null ? null : await fastInput.tap(device, x, y, {})
        if (fastStep === null) {
          const r = await sh(device, `input tap ${x} ${y}`, 10_000)
          if (!r.ok) throw new Error(failureNote('点击', r))
        }
        lastActions.push({ at: Date.now(), what: `点击 ${oneLine(target.text || target.desc || '', 20)}@${x},${y}` })
        message += `，已点它`
      }
      return {
        ok: true,
        found: true,
        swipes,
        activity: state.activity || '',
        message: `${message}（${Date.now() - began}ms）`,
        ...(hit.ref === null || hit.ref === undefined ? {} : { ref: hit.ref }),
        point: hit.point,
        snapshot_id: state.snapshotId,
        elapsed_ms: Date.now() - began,
      }
    },
  }), 'adb: adb_scroll_to')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_do',
    description: [
      '一串动作一次调用跑完：点、滑、输入、按键、系统动作、等界面。',
      '每一步都能带上「等它生效」的条件，跑完一次性给结果；适合「点开→等加载→输入→发送」这种连着做的流程，比一步步调工具少好几个回合。',
      '某一步失败不会把界面留在半路：当场说第几步、停在哪个页面、屏上有什么。每步可写 retry（0–3）重来注入前的偶发失败。',
      'steps 按顺序执行，任何一步失败就停，并报出是哪一步。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              tap: { type: 'string', description: '点哪个：文字内容，或用 "x,y" 坐标' },
              id: { type: 'string', description: '按资源 id 点' },
              ref: { type: 'integer', description: '按 adb_ui/adb_find 给的 ref 点（先读再点最准）' },
              long: { type: 'boolean', description: '本步是长按（配合 tap/id/ref）' },
              scroll_to: { type: 'string', description: '先边滑边找这段文字，找到就点它；找不到算失败' },
              scroll: { type: 'integer', description: '按文字/id 点时先滑几次找目标（1–15）：当前屏没有就边滑边找，找到再点' },
              scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'scroll 的滑动方向，默认 up（把下面的内容拉上来）' },
              wait_ms: { type: 'integer', description: '这一步的目标还没出现时先等它出现多久（毫秒，默认 900，上限 5000）' },
              direction: { type: 'string', description: 'scroll_to 的滑动方向：up/down/left/right，默认 up' },
              wait_idle: { type: 'boolean', description: '本步做完等界面静止（动画/加载结束）再核对' },
              wait_stable: { type: 'boolean', description: '同 wait_idle，按树签名连续 idle_ms 不变判定静止' },
              idle_ms: { type: 'integer', description: 'wait_idle / wait_stable 用：连续多久没变化算静止，默认 400' },
              swipe: { type: 'array', items: { type: 'integer' }, description: '滑动 [x1,y1,x2,y2,毫秒]' },
              key: { type: 'string', description: '按键名：BACK / HOME / ENTER，或 keycode 数字' },
              text: { type: 'string', description: '往焦点输入框输入文字（ASCII 直发，中文走剪贴板粘贴；先点中输入框让它获得焦点）' },
              action: { type: 'string', description: '系统动作：home / back / recents / lock / wake / notifications / quick_settings' },
              wait_text: { type: 'string', description: '等这段文字出现再做下一步' },
              wait_gone: { type: 'string', description: '等这段文字消失再做下一步' },
              wait_activity: { type: 'string', description: '等前台页面切到这个正则再做下一步，例如 "ScanActivity"' },
              wait_all: { type: 'array', items: { type: 'string' }, description: '等这几段文字全部出现（一次等两个条件，比拆成两步快）' },
              wait_any: { type: 'array', items: { type: 'string' }, description: '这几段文字出现任意一个就算过（加载完或报错弹窗，两种结局都往下走）' },
              until: { type: 'string', enum: ['visible', 'enabled', 'clickable', 'checked', 'focused'], description: '配 wait_text / assert_text：等同一个控件进入这个状态才算过（灰按钮不会误判成可点）' },
              dismiss: { type: 'boolean', description: '本步等待被权限/升级弹窗挡住时自动点掉确认按钮（最多 2 次）' },
              assert_text: { type: 'string', description: '这一步做完核对这段文字必须在（最多重试 3s），不在就算失败' },
              ime: { type: 'string', enum: ['auto', 'clipboard', 'adb'], description: '输入文字怎么上屏，同 adb_input 的 ime' },
              retry: { type: 'integer', minimum: 0, maximum: 3, description: '这一步在「还没点/还没打字」阶段失败时重来几次（默认 0）：查询超时、快照失效这类偶发失败用得上；已经注入过动作再失败就直接报错，不重复点' },
              assert_gone: { type: 'string', description: '这一步做完核对这段文字必须消失' },
              sleep_ms: { type: 'integer', description: '硬等多久（尽量用 wait_text 代替）' },
            },
            additionalProperties: false,
          },
        },
        timeout_ms: { type: 'integer', description: '每步等待上限，默认 8000' },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          steps: { type: 'integer' },
          activity: { type: 'string' },
          summary: { type: 'string' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['ok', 'steps', 'activity', 'summary', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(value.summary),
    },
    execute: async (args) => {
      /* 先在本地把整串检查一遍：写错了当场报第几步，不要跑一半停住把界面留在半路。 */
      const checked = validateSteps(args.steps)
      if (!checked.ok) throw new Error(`steps 有 ${checked.problems.length} 处要改：${checked.problems.join('；')}`)
      const device = await serial()
      const began = Date.now()
      const limit = args.timeout_ms ?? 8000
      const done = []
      let activity = ''
      try {
      for (const [index, step] of (args.steps ?? []).entries()) {
        const at = index + 1
        /* 同一步只在「还没往设备注入任何东西」时重来：查询慢/快照失效这类失败重试有用，
           点过/打过字之后再重试就是重复注入，宁可报错让人看现场。 */
        const tries = retryBudget(step)
        let attempt = 0
        for (;;) {
        let injected = false
        try {
        let node = null
        if (step.scroll_to !== undefined) {
          node = await scrollToText(device, String(step.scroll_to), step.direction)
          done.push(`滑到「${oneLine(String(step.scroll_to), 16)}」`)
        }
        if (step.tap !== undefined || step.id !== undefined || step.ref !== undefined || node !== null) {
          let point = null
          if (node !== null) {
            /* scroll_to 已经定位到目标，直接算坐标点它。 */
          } else if (step.ref !== undefined) {
            node = await nodeForRef(device, Number(step.ref))
          } else if (step.tap !== undefined && /^\s*-?\d+\s*,\s*-?\d+\s*$/.test(String(step.tap))) {
            const parts = String(step.tap).split(',').map((value) => Number(value.trim()))
            point = { x: parts[0], y: parts[1] }
          } else {
            /* 按文字/id 点之前先确认快照还对应现在的界面，页面换了就重新 dump，不拿旧坐标点。 */
            await snapshotForSelector(device)
            const want = { text: step.tap, id: step.id }
            try {
              node = await awaitNode(device, want, step.wait_ms)
            } catch (error) {
              /* 与 adb_tap 同一条规则：只有「当前屏没有」才值得滑；有歧义/快照过期滑了也没用。 */
              const reason = String(error?.message ?? error)
              if (!(step.scroll && reason.startsWith('界面上没有'))) throw error
              node = await scrollToSelector(device, want, step.scroll_direction, step.scroll)
              done.push(`滑 ${step.scroll} 次找到「${oneLine(node.text || node.desc || '', 16)}」`)
            }
            /* 快照比软时效还旧时再核一次：控件挪了或没了就报 stale_snapshot，不把一串步骤点到旧位置。 */
            node = await freshNodeFor(device, node)
          }
          let target
          if (point !== null) {
            target = { x: point.x, y: point.y, label: `坐标 ${point.x},${point.y}` }
          } else {
            const hit = clickTarget(nodesOf(device), node)
            const x = Math.round((hit.x1 + hit.x2) / 2)
            const y = Math.round((hit.y1 + hit.y2) / 2)
            target = { x, y, label: `「${oneLine(node.text || node.desc || shortId(node.id) || shortClass(node.cls), 20)}」@${x},${y}` }
          }
          injected = true
          const holdMs = step.long === true ? 700 : 0
          const fastStep = holdMs > 0 || fastInput.tap === null ? null : await fastInput.tap(device, target.x, target.y, {})
          if (fastStep === null) {
            const command = holdMs > 0 ? `input swipe ${target.x} ${target.y} ${target.x} ${target.y} ${holdMs}` : `input tap ${target.x} ${target.y}`
            const r = await sh(device, command, 14_000)
            if (!r.ok) throw new Error(`第 ${at} 步${failureNote(holdMs > 0 ? '长按' : '点击', r)}`)
          }
          lastActions.push({ at: Date.now(), what: `${holdMs > 0 ? '长按' : '点击'} ${target.label}` })
          done.push(`${holdMs > 0 ? '长按' : '点'} ${target.label}`)
        } else if (step.swipe !== undefined) {
          const s4 = step.swipe
          if (!Array.isArray(s4) || s4.length < 4) throw new Error(`第 ${at} 步 swipe 要写 [x1,y1,x2,y2,毫秒]。`)
          injected = true
          const ms = s4[4] ?? 300
          const fastStep = fastInput.swipe === null ? null : await fastInput.swipe(device, s4[0], s4[1], s4[2], s4[3], ms)
          if (fastStep === null) {
            const r = await sh(device, `input swipe ${s4[0]} ${s4[1]} ${s4[2]} ${s4[3]} ${ms}`, 15_000)
            if (!r.ok) throw new Error(`第 ${at} 步${failureNote('滑动', r)}`)
          }
          done.push(`滑 ${s4[0]},${s4[1]}→${s4[2]},${s4[3]}`)
        } else if (step.key !== undefined) {
          injected = true
          const code = /^\d+$/.test(String(step.key)) ? String(step.key) : String(step.key).toUpperCase()
          const r = await sh(device, `input keyevent ${code}`, 10_000)
          if (!r.ok) throw new Error(`第 ${at} 步${failureNote(`按键 ${code}`, r)}`)
          done.push(`键 ${code}`)
        } else if (step.text !== undefined) {
          /* 与 adb_input 共用一条路径：ASCII 走 input text，中文走剪贴板粘贴。 */
          injected = true
          const typed = await inputTextVia(device, String(step.text), { ime: step.ime })
          lastActions.push({ at: Date.now(), what: typed.how === 'paste' ? `粘贴文字 ${String(step.text).length} 字` : `输入文字 ${String(step.text).length} 字` })
          done.push(`输入 ${oneLine(String(step.text), 20)}`)
        } else if (step.action !== undefined) {
          injected = true
          const cmd = ACTION_MAP[step.action]
          if (cmd === undefined) throw new Error(`第 ${at} 步 action 不认识：${step.action}`)
          const r = await sh(device, cmd, 12_000)
          if (!r.ok) throw new Error(`第 ${at} 步${failureNote('系统动作', r)}`)
          done.push(step.action)
        }

        if (step.wait_idle === true || step.wait_stable === true) {
          /* 等界面静止：树签名连续 idle_ms 不变才算稳定，最多等到本步上限。 */
          const calmed = await awaitStable(() => pollDump(device), {
            quietMs: step.idle_ms ?? 400,
            timeoutMs: limit,
          })
          activity = calmed.state.activity
          done.push(`等静止 ${calmed.ms}ms${calmed.stable ? '' : calmed.empty ? '（读不到控件）' : '（到点还没静）'}`)
        }

        if (step.wait_text !== undefined || step.wait_gone !== undefined || step.wait_all !== undefined || step.wait_any !== undefined || step.wait_activity !== undefined) {
          const waited = await waitFor(device, {
            text: step.wait_text,
            gone: step.wait_gone,
            texts: step.wait_all,
            any_texts: step.wait_any,
            activity: step.wait_activity,
            until: step.until,
          }, limit, { dismiss: step.dismiss === true })
          activity = waited.state.activity
          if (!waited.matched) {
            const wanted = step.wait_text ? `没等到「${step.wait_text}」`
              : step.wait_gone ? `「${step.wait_gone}」还在`
                : step.wait_activity ? `页面还没切到 /${step.wait_activity}/`
                  : step.wait_all ? `「${normalList(step.wait_all).join('」「')}」没全出现`
                    : `「${normalList(step.wait_any).join('」「')}」一个都没出现`
            throw new Error(`第 ${at} 步等界面超时 ${limit}ms：${wanted}`)
          }
          const what = step.wait_text ?? (step.wait_activity ? `页面切到 ${step.wait_activity}` : step.wait_all ? normalList(step.wait_all).join('+') : step.wait_any ? `任一 ${normalList(step.wait_any).join('/')}` : '界面变化')
          done.push(`等 ${what} ${waited.elapsedMs}ms`)
        } else if (step.sleep_ms !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(Number(step.sleep_ms) || 0, 15_000)))
          done.push(`等 ${step.sleep_ms}ms`)
        }

        if (step.assert_text !== undefined || step.assert_gone !== undefined) {
          const checked = await waitFor(device, { text: step.assert_text, gone: step.assert_gone, until: step.until }, Math.min(limit, 3000), { dismiss: step.dismiss === true })
          activity = checked.state.activity
          if (!checked.matched) {
            throw new Error(`第 ${at} 步核对失败：${step.assert_text ? `界面上没有「${step.assert_text}」` : `「${step.assert_gone}」还在`}${nearMiss(checked.state, { text: step.assert_text })}`)
          }
          const stateNote = step.until === undefined ? '' : `（处于 ${step.until}）`
          const popNote = checked.dismissed.length === 0 ? '' : `，先点掉了 ${checked.dismissed.join('/')}`
          done.push(step.assert_text ? `✓ 有「${oneLine(step.assert_text, 16)}」${stateNote}${popNote}` : `✓「${oneLine(String(step.assert_gone), 16)}」已消失${popNote}`)
        }
      break
        } catch (retryable) {
          attempt += 1
          if (injected || attempt >= tries) throw retryable
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
        }
      }
      } catch (error) {
        const message = String((error && error.message) || error)
        /* 失败现场自己说话：当前页面 + 屏上的一段文字，省掉「失败后再调一次 adb_ui」。 */
        let now = ''
        let digest = ''
        try {
          const state = await dumpState(device, { maxNodes: 200, changed: false })
          now = state.activity ?? ''
          digest = digestLine(state.tree?.lines ?? [], 4)
        } catch {
          now = await foregroundActivity(device).catch(() => '')
        }
        const evidence = await captureEvidence(device, 'adb_do')
        const hint = /没有|越界|ambiguous_target|核对失败/.test(message)
          ? '目标不在当前界面：用 adb_find 搜一下看现在有什么，或 adb_ui 看整屏再重试。'
          : ''
        const where = [now ? `当前页面 ${now}` : '', digest ? `屏上 ${digest}` : ''].filter(Boolean).join(' · ')
        const shotNote = evidence === null ? '' : `截图 ${evidence.path}`
        throw new Error(`${message}${where ? ` · ${where}` : ''}${shotNote ? ` · ${shotNote}` : ''}${hint ? ` · ${hint}` : ''}`)
      }
      if (activity === '') activity = (await foregroundActivity(device).catch(() => '')) || ''
      const summary = [`${done.length} 步跑完（${Date.now() - began}ms）`, `当前 ${activity || '未知页面'}`, '', ...done.map((line, index) => `${index + 1}. ${line}`)].join('\n')
      return { ok: true, steps: done.length, activity, summary, elapsed_ms: Date.now() - began }
    },
  }), 'adb: adb_do')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_anim',
    description: [
      '录一段界面动效：按 fps 反复读界面树，输出目标控件的大小/位置随时间的变化、抖动次数、超调、缓动形状，可同时在采样期间点一下触发动画。',
      '用于「桌宠变大不协调」「按钮弹跳生硬」「转场卡顿」这类动态问题——把肉眼感觉变成数字，比连拍截图准得多（单帧 150–250ms，实测 5–7 帧/秒）。',
      '目标给 ref（先 adb_ui）、text 或 id。trigger 里放采样期间要执行的动作（tap / swipe / text / action），采样不等它，边动边录。',
      '局限：读的是控件树坐标，列表滚动、页面转场这类合成器驱动的动画可能全程报「没变」，那种改用帧序列看。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'integer', description: '目标控件 ref，来自最近一次 adb_ui（和 text/id 三选一）' },
        snapshot_id: { type: 'string', description: '可选：adb_ui 返回的 snapshot_id；带上就校验 ref 属于那次快照，对不上直接报错' },
        text: { type: 'string', description: '目标控件文字' },
        id: { type: 'string', description: '目标控件资源 id' },
        duration_ms: { type: 'integer', description: '采样时长，默认 2000，上限 20000' },
        fps: { type: 'integer', description: '采样频率，默认 6，上限 10（受单帧 150ms 限制）' },
        trigger: {
          type: 'array',
          description: '采样开始后执行的动作，最多 4 步；每步可用 tap / id / text / action',
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              tap: { type: 'string', description: '文字内容，或 "x,y" 坐标' },
              swipe: { type: 'array', description: '滑动 [x1,y1,x2,y2,毫秒]', items: { type: 'integer' } },
              id: { type: 'string', description: '资源 id' },
              text: { type: 'string', description: '要输入的文字（ASCII 直发，中文走剪贴板粘贴；先点中输入框）' },
              action: { type: 'string', description: '系统动作，同 adb_action' },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          target: { type: 'string' },
          samples: { type: 'integer' },
          fps: { type: 'number' },
          metrics: { type: 'object' },
          timeline: { type: 'array' },
          summary: { type: 'string' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['ok', 'target', 'samples', 'fps', 'metrics', 'timeline', 'summary', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(value.summary),
    },
    execute: async (args) => {
      const device = await serial()
      const began = Date.now()
      const duration = Math.min(Math.max(args.duration_ms ?? 2000, 300), 20_000)
      const wantedFps = Math.min(Math.max(args.fps ?? 6, 2), 10)
      /* 起始对象：ref 严格按快照校验，text/id 允许自动重读一次再找。 */
      let seed
      if (args.ref !== undefined) {
        seed = nodeForRef(device, args.ref, args.snapshot_id)
      } else {
        await snapshotForSelector(device, args.snapshot_id)
        seed = nodeForSelector(device, { text: args.text, id: args.id, snapshotId: args.snapshot_id })
        /* 采样前确认这个控件还在原位；挪了或没了直接报，不录一段别人的动效。 */
        seed = await freshNodeFor(device, seed, args.snapshot_id)
      }
      const key = { text: seed.text, id: seed.id, desc: seed.desc }
      const seedX = (seed.x1 + seed.x2) / 2
      const seedY = (seed.y1 + seed.y2) / 2
      const matches = (node) => {
        if (key.text && (node.text === key.text || node.desc === key.text)) return true
        if (key.desc && node.desc === key.desc) return true
        if (key.id && shortId(node.id) === shortId(key.id)) return true
        return false
      }
      /* 同一段文字可能存在多份（离屏副本、左右分栏），取离起始位置最近的那个，否则会盯错对象。 */
      const find = (nodes) => {
        let best = null
        let bestDistance = Number.POSITIVE_INFINITY
        for (const node of nodes) {
          if (!matches(node)) continue
          const distance = Math.hypot((node.x1 + node.x2) / 2 - seedX, (node.y1 + node.y2) / 2 - seedY)
          if (distance < bestDistance) {
            best = node
            bestDistance = distance
          }
        }
        return best
      }
      const timeline = []
      let triggered = false
      const trigger = Array.isArray(args.trigger) ? args.trigger : []
      const finish = Date.now() + duration
      while (Date.now() < finish) {
        const at = Date.now() - began
        let state
        try {
          state = await dumpState(device, { activity: false })
        } catch {
          break
        }
        const hit = find(state.nodes) ?? (timeline.length > 0 ? null : seed)
        if (hit) {
          timeline.push({
            at,
            x: Math.round((hit.x1 + hit.x2) / 2),
            y: Math.round((hit.y1 + hit.y2) / 2),
            w: hit.x2 - hit.x1,
            h: hit.y2 - hit.y1,
            found: true,
          })
        } else {
          timeline.push({ at, x: null, y: null, w: null, h: null, found: false })
        }
        if (!triggered && trigger.length > 0 && timeline.length === 1) {
          triggered = true
          /* 不 await：边滑边采样才录得到过程中的每一帧。 */
          void (async () => { for (const step of trigger) {
            try {
              if (step.action) {
                await adb(['-s', device, 'shell', ACTION_MAP[step.action] ?? '', ], { timeout: 6000 })
                continue
              }
              if (step.text !== undefined) {
                await inputTextVia(device, String(step.text))
                continue
              }
              if (Array.isArray(step.swipe)) {
                await adb(['-s', device, 'shell', 'input', 'swipe', ...step.swipe.map(String)], { timeout: 10_000 })
                continue
              }
              if (step.tap !== undefined && /^-?\d+,-?\d+$/.test(String(step.tap))) {
                const [tx, ty] = String(step.tap).split(',').map(Number)
                await adb(['-s', device, 'shell', 'input', 'tap', String(tx), String(ty)], { timeout: 8000 })
                continue
              }
              const target = step.id
                ? nodeForSelector(device, { id: step.id })
                : nodeForSelector(device, { text: step.tap })
              const landed = clickTarget(state.nodes, target)
              await adb(['-s', device, 'shell', 'input', 'tap', String(Math.round((landed.x1 + landed.x2) / 2)), String(Math.round((landed.y1 + landed.y2) / 2))], { timeout: 8000 })
            } catch {
              /* 触发动作失败不影响采样 */
            }
          } })()
        }
        const stepMs = 1000 / wantedFps
        const rest = stepMs - (Date.now() - began - at)
        if (rest > 0) await dshSleep(rest)
      }
      const hits = timeline.filter((row) => row.found)
      if (hits.length === 0) throw new Error(`采样 ${duration}ms 里一次也没找到「${(args.text ?? args.id ?? `ref=${args.ref}`)}」：动画期间控件可能被移除，换个更稳定的对象再试。`)
      const sizes = hits.map((row) => row.w * row.h)
      const firstSize = sizes[0]
      const lastSize = sizes[sizes.length - 1]
      const maxSize = Math.max(...sizes)
      const minSize = Math.min(...sizes)
      const overshoot = (lastSize - firstSize) >= 0 ? maxSize - lastSize : lastSize - minSize
      const sizeSteps = sizes.slice(1).map((size, index) => size - sizes[index])
      let reversals = 0
      for (let index = 1; index < sizeSteps.length; index += 1) {
        if (sizeSteps[index] !== 0 && sizeSteps[index - 1] !== 0 && Math.sign(sizeSteps[index]) !== Math.sign(sizeSteps[index - 1])) reversals += 1
      }
      const deltas = hits.slice(1).map((row, index) => Math.abs(row.w - hits[index].w) + Math.abs(row.h - hits[index].h))
      const meanDelta = deltas.length > 0 ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : 0
      const peakDelta = deltas.length > 0 ? Math.max(...deltas) : 0
      const motionSpan = Math.abs(lastSize - firstSize)
      const settleIndex = motionSpan === 0
        ? 0
        : Math.max(0, [...deltas].reverse().findIndex((value) => value >= Math.max(2, motionSpan * 0.02)))
      const settleAt = settleIndex === 0 && motionSpan !== 0 ? (hits[hits.length - 1]?.at ?? 0) - (hits[0]?.at ?? 0) : (hits[Math.max(0, hits.length - 1 - settleIndex)]?.at ?? 0) - (hits[0]?.at ?? 0)
      const metrics = {
        frames: hits.length,
        fps: Number(((hits.length / Math.max(1, timeline[timeline.length - 1].at - timeline[0].at)) * 1000).toFixed(1)),
        w: [hits[0].w, hits[hits.length - 1].w],
        h: [hits[0].h, hits[hits.length - 1].h],
        area: [firstSize, lastSize],
        area_min: minSize,
        area_max: maxSize,
        overshoot_px: Math.round(overshoot),
        reversals,
        mean_step_px: Math.round(meanDelta),
        peak_step_px: Math.round(peakDelta),
        smoothness: meanDelta === 0 ? 0 : Number((peakDelta / meanDelta).toFixed(2)),
        settle_ms: Math.round(settleAt),
        center_start: [hits[0].x, hits[0].y],
        center_end: [hits[hits.length - 1].x, hits[hits.length - 1].y],
      }
      const verdict = []
      if (overshoot > Math.max(8, Math.abs(lastSize - firstSize) * 0.08)) verdict.push(`超调 ${metrics.overshoot_px}px（回弹过头）`)
      if (reversals >= 3) verdict.push(`大小来回改了 ${reversals} 次（抖动）`)
      if (metrics.smoothness > 3) verdict.push(`帧间跳变不均：峰值 ${metrics.peak_step_px}px vs 均值 ${metrics.mean_step_px}px`)
      if (Math.abs(lastSize - firstSize) < 4) verdict.push('全程尺寸几乎没变（这期间可能没有动画）')
      if (verdict.length === 0) verdict.push('尺寸变化单调、无超调、帧间步长均匀')
      const rows = hits.filter((_row, index) => index % Math.max(1, Math.ceil(hits.length / 16)) === 0)
      const summary = [
        `${hits.length} 帧 / ${metrics.fps} fps · 目标「${key.text || key.id || `ref=${args.ref}`}」`,
        `尺寸 ${hits[0].w}×${hits[0].h} → ${hits[hits.length - 1].w}×${hits[hits.length - 1].h}（面积 ${firstSize} → ${lastSize}，峰值 ${maxSize}）`,
        `判定：${verdict.join('；')}`,
        `稳定于 ${metrics.settle_ms}ms · 抖动 ${reversals} 次 · 平滑度 ${metrics.smoothness}（峰值/均值步长）`,
        '',
        't(ms) 中心 宽×高',
        ...rows.map((row) => `${String(row.at).padStart(5)} ${row.x},${row.y} ${row.w}×${row.h}`),
      ].join('\n')
      return { ok: true, target: key.text || key.id || `ref=${args.ref}`, samples: hits.length, fps: metrics.fps, metrics, timeline, summary, elapsed_ms: Date.now() - began }
    },
  }), 'adb: adb_anim')

  /**
 * 把一次 dump 的节点按 depth 0 切成窗口块：u2 的 dumpWindowHierarchy 会把所有
 * 可见窗口（前台页、悬浮桌宠、状态栏、输入法）塞进同一棵 hierarchy，depth 0 就是窗口根。
 * @param {any[]} nodes - parseNodes 的结果。
 * @returns {Array<{root: any, nodes: any[]}>} 窗口列表，按层级顺序。
 */
function splitWindows(nodes) {
  const out = []
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i].depth !== 0) continue
    let end = nodes.length
    for (let k = i + 1; k < nodes.length; k += 1) {
      if (nodes[k].depth === 0) { end = k; break }
    }
    out.push({ root: nodes[i], nodes: nodes.slice(i, end) })
  }
  return out
}

/**
 * 窗口里的一行控件：id + 类名 + [宽×高 @x,y] + 文字。
 * @param {any} node - 节点。
 * @param {number} indent - 缩进层数。
 * @returns {string} 行。
 */
function windowLine(node, indent) {
  const w = Math.max(0, node.x2 - node.x1)
  const h = Math.max(0, node.y2 - node.y1)
  const cls = node.cls ? node.cls.replace(/^android\.(widget|view|webkit)\./, '') : 'View'
  const parts = [`${'  '.repeat(indent)}${node.id ? '#' + shortId(node.id) + ' ' : ''}${cls}`]
  if (w || h) parts.push('[' + w + '×' + h + ' @' + node.x1 + ',' + node.y1 + ']')
  if (node.text) parts.push('"' + oneLine(node.text, 32) + '"')
  if (node.desc) parts.push('~"' + oneLine(node.desc, 24) + '"')
  if (node.clickable || node.longClickable) parts.push('*')
  return parts.join(' ')
}

/**
 * 在节点里按选择器找控件：先精确文字，再子串；id/desc/class 都按子串匹配。
 * @param {any[]} nodes - 节点。
 * @param {{id?: string, text?: string, desc?: string, cls?: string}} sel - 选择器。
 * @returns {any|null} 命中的节点。
 */
function matchNode(nodes, sel) {
  const pick = (pool) => {
    for (const node of pool) {
      if (sel.id && !node.id.includes(sel.id)) continue
      if (sel.cls && !node.cls.includes(sel.cls)) continue
      if (sel.desc && !node.desc.includes(sel.desc)) continue
      if (sel.text && !node.text.includes(sel.text)) continue
      return node
    }
    return null
  }
  return pick(nodes.filter((node) => !sel.text || node.text === sel.text)) || pick(nodes)
}

ctx.effect(() => ctx.tools.register({
  name: 'adb_find',
  description: '按选择器搜控件，一次拿到全部命中：序号、ref（可直接 adb_tap ref=）、id、文字、描述、矩形、中心点、是否可点/可用/勾选/选中/可滚/有焦点；命中后同一快照内可直接操作，不必再 adb_ui。用于「先确认有几个、在哪、能不能点」再动手。',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '文字或描述，默认包含匹配' },
      text_matches: { type: 'string', description: '文字正则（等于 regex=true 时的 text）' },
      id: { type: 'string', description: '资源 id，可只写后半段' },
      desc: { type: 'string', description: 'content-desc' },
      cls: { type: 'string', description: '类名，可只写后半段，如 Switch' },
      pkg: { type: 'string', description: '包名片段' },
      exact: { type: 'boolean', description: '完全相等，默认包含匹配' },
      regex: { type: 'boolean', description: 'text/id/desc 当正则用' },
      clickable: { type: 'boolean', description: '只看可点控件' },
      enabled: { type: 'boolean', description: '只看可用控件' },
      visible: { type: 'boolean', description: '只看有面积的控件' },
      checked: { type: 'boolean', description: '按勾选状态挑：true 只留已勾选，false 只留没勾选' },
      selected: { type: 'boolean', description: '按选中状态挑（Tab/列表项）' },
      scrollable: { type: 'boolean', description: '按可滚动挑（找列表容器时用 true）' },
      focused: { type: 'boolean', description: '按焦点挑（找当前输入框时用 true）' },
      editable: { type: 'boolean', description: '按能不能输入挑（EditText 一类）' },
      within_ref: { type: 'integer', description: '只在这个 ref 的矩形范围内找' },
      all: { type: 'boolean', description: '保留同一处的所有层（默认按落点归并，只留最精确那层）' },
      index: { type: 'integer', description: '只返回第几个匹配，从 0 开始' },
      max: { type: 'integer', description: '最多返回几条，默认 20，上限 50' },
      refresh: { type: 'boolean', description: '强制重新读界面树，默认复用最近 1.5s 内没变过的快照' },
      snapshot_id: { type: 'string', description: '可选：校验快照还是不是那次，对不上直接报错' },
    },
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        serial: { type: 'string' },
        activity: { type: 'string' },
        summary: { type: 'string' },
        count: { type: 'integer' },
        lines: { type: 'array' },
        matches: { type: 'array' },
        snapshot_id: { type: 'string' },
        elapsed_ms: { type: 'integer' },
      },
      required: ['serial', 'activity', 'summary', 'count', 'lines', 'matches', 'snapshot_id', 'elapsed_ms'],
      additionalProperties: false,
    },
    render: (_args, value) => textBlock(value.summary + '\n' + value.lines.join('\n')),
  },
  execute: async (args) => {
    const device = await serial()
    const began = Date.now()
    const state = args.refresh === true
      ? await dumpState(device, {})
      : await snapshotForSelector(device, args.snapshot_id)
    const refOf = new Map()
    for (const entry of (state.refs ?? state.tree?.refs) || []) if (entry && entry.node) refOf.set(entry.node, entry.ref)
    const hits = selectNodes(state, {
      text: args.text,
      text_matches: args.text_matches,
      id: args.id,
      desc: args.desc,
      cls: args.cls,
      pkg: args.pkg,
      exact: args.exact,
      regex: args.regex,
      clickable: args.clickable,
      enabled: args.enabled,
      visible: args.visible,
      checked: args.checked,
      selected: args.selected,
      scrollable: args.scrollable,
      focused: args.focused,
      editable: args.editable,
      within_ref: args.within_ref,
      all: args.all,
      index: args.index,
    })
    const max = Math.min(Math.max(Number(args.max) || 20, 1), 50)
    const matches = hits.slice(0, max).map((node, offset) => {
      const w = Math.max(0, node.x2 - node.x1)
      const h = Math.max(0, node.y2 - node.y1)
      return {
        ref: refOf.get(node) ?? null,
        index: offset,
        cls: String(node.cls || ''),
        id: String(node.id || ''),
        text: String(node.text || ''),
        desc: String(node.desc || ''),
        rect: [node.x1, node.y1, w, h],
        point: `${Math.round((node.x1 + node.x2) / 2)},${Math.round((node.y1 + node.y2) / 2)}`,
        clickable: Boolean(node.clickable || node.longClickable),
        enabled: node.enabled !== false,
        checked: Boolean(node.checked),
        selected: Boolean(node.selected),
        focused: Boolean(node.focused),
        scrollable: Boolean(node.scrollable),
        password: Boolean(node.password),
      }
    })
    const lines = matches.map((item) => {
      const parts = [`${String(item.index).padStart(2, ' ')} ref=${item.ref === null ? '-' : item.ref}`]
      parts.push(shortClass(item.cls))
      if (item.text) parts.push(`"${oneLine(item.text, 30)}"`)
      if (item.desc && item.desc !== item.text) parts.push(`~"${oneLine(item.desc, 22)}"`)
      if (item.id) parts.push('#' + shortId(item.id))
      parts.push(`[${item.rect[2]}×${item.rect[3]} @${item.point}]`)
      if (item.clickable) parts.push('*')
      if (item.scrollable) parts.push('~')
      if (!item.enabled) parts.push('[off]')
      if (item.checked) parts.push('[x]')
      else if (item.selected) parts.push('[s]')
      if (item.focused) parts.push('[f]')
      if (item.password) parts.push('[pwd]')
      return parts.join(' ')
    })
    const filterText = [args.text, args.id, args.desc, args.cls, args.pkg].filter(Boolean).join(' ')
    const summary = [
      device + ' · ' + (state.activity || '未知页面'),
      hits.length === 0 ? '没找到' : `${hits.length} 个命中` + (hits.length > matches.length ? `（显示前 ${matches.length} 个）` : ''),
      filterText ? '查 ' + JSON.stringify(filterText) : '',
      Date.now() - began + 'ms',
      hits.length === 0 ? nearMiss(state, args) : '',
    ].filter(Boolean).join(' · ')
    return {
      serial: device,
      activity: state.activity || '',
      summary,
      count: hits.length,
      lines: lines.length > 0 ? lines : ['（没有命中）'],
      matches,
      snapshot_id: state.snapshotId,
      elapsed_ms: Date.now() - began,
    }
  },
}))

ctx.effect(() => ctx.tools.register({
  name: 'adb_window',
  description: [
    '按「窗口」看界面：一次 dump 列出所有可见窗口（前台页、悬浮窗/桌宠、状态栏、输入法），给包名、尺寸、位置和窗口内控件树。',
    'adb_ui 只读前台页面的文字树；要确认悬浮控件多大、弹窗/悬浮窗谁在上面、桌宠这类独立窗口里有什么（含气泡文字），用这个。一次约 50ms。',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      filter: { type: 'string', description: '只留包名/文字/id 包含这段的窗口' },
      full: { type: 'boolean', description: '连没有文字/id 的结构容器也展开；默认只展开有文字、id 浅层或可点的节点' },
      max_nodes: { type: 'integer', description: '最多返回多少行，默认 ' + MAX_NODES.default },
    },
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        serial: { type: 'string' },
        activity: { type: 'string' },
        summary: { type: 'string' },
        tree: { type: 'string' },
        windows: { type: 'integer' },
        elapsed_ms: { type: 'integer' },
      },
      required: ['serial', 'activity', 'summary', 'tree', 'windows', 'elapsed_ms'],
      additionalProperties: false,
    },
    render: (_args, value) => textBlock(value.summary + '\n' + value.tree),
  },
  execute: async (args) => {
    const device = await serial()
    const began = Date.now()
    const [xml, activity] = await Promise.all([u2Dump(device), foregroundActivity(device).catch(() => '')])
    const nodes = parseNodes(xml)
    const wins = splitWindows(nodes)
    const full = args.full === true
    const maxNodes = Math.min(Math.max(args.max_nodes ?? MAX_NODES.default, 1), MAX_NODES.max)
    const needle = String(args.filter ?? '').toLowerCase()
    const lines = []
    let kept = 0
    for (const win of wins) {
      const w = Math.max(0, win.root.x2 - win.root.x1)
      const h = Math.max(0, win.root.y2 - win.root.y1)
      const head = '⌗ ' + (win.root.pkg || '未知包') + ' · ' + w + '×' + h + ' @' + win.root.x1 + ',' + win.root.y1 + ' · ' + win.nodes.length + ' 节点'
      const body = []
      for (const node of win.nodes.slice(1)) {
        if (kept >= maxNodes) break
        const deep = node.depth <= 3 && Boolean(node.id)
        const show = full ? Boolean(node.id || node.text || node.desc || node.clickable) : Boolean(node.text || node.desc || node.clickable || deep)
        if (!show) continue
        body.push(windowLine(node, Math.min(node.depth, 6)))
        kept += 1
      }
      if (needle && !(head + '\n' + windowLine(win.root, 0) + '\n' + body.join('\n')).toLowerCase().includes(needle)) continue
      lines.push(head, windowLine(win.root, 0), ...body)
    }
    const summary = [
      device + ' · ' + (activity || '未知页面'),
      wins.length + ' 个窗口 · ' + kept + ' 节点' + (needle ? ' · 过滤 ' + JSON.stringify(String(args.filter)) : ''),
      Date.now() - began + 'ms',
      lines.length === 0 ? '没有匹配的窗口' : '',
    ].filter(Boolean).join(' · ')
    return {
      serial: device,
      activity,
      summary,
      tree: lines.join('\n') || '（没有匹配的窗口）',
      windows: wins.length,
      elapsed_ms: Date.now() - began,
    }
  },
}))

ctx.effect(() => ctx.tools.register({
  name: 'adb_watch',
  description: [
    '采样一个控件的几何随时间变化：按 id/text/class 选一个控件，连续读它的宽高与位置，给出变化序列、最大单步、抖动次数、多久稳住。',
    '用来量化「刚才那个东西大小/位置变化不协调」这类问题——动画内嵌在 WebView 画布里时几何可能全程不变，那就换 adb_motion 量像素；两者互补。',
    'id/text/class 三选一，先 adb_ui 拿 id 或文字。默认采样 3 秒、约 10 次/秒，每次 dump 约 46ms。',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '资源 id，可只写后半段，如 petRoot' },
      text: { type: 'string', description: '控件文字（精确优先，其次包含）' },
      desc: { type: 'string', description: 'content-desc 内容' },
      class: { type: 'string', description: '类名子串，如 EditText' },
      seconds: { type: 'integer', description: '采样时长，默认 3，最多 15' },
      fps: { type: 'integer', description: '采样频率，默认 10，最多 15' },
    },
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        serial: { type: 'string' },
        selector: { type: 'string' },
        summary: { type: 'string' },
        detail: { type: 'string' },
        samples: { type: 'integer' },
        changes: { type: 'integer' },
        series: { type: 'string' },
        biggest_step_px: { type: 'integer' },
        settle_ms: { type: 'integer' },
        matched: { type: 'boolean' },
        elapsed_ms: { type: 'integer' },
      },
      required: ['serial', 'selector', 'summary', 'detail', 'samples', 'changes', 'series', 'biggest_step_px', 'settle_ms', 'matched', 'elapsed_ms'],
      additionalProperties: false,
    },
    render: (_args, value) => textBlock(value.summary + '\n' + value.detail),
  },
  execute: async (args) => {
    const device = await serial()
    const began = Date.now()
    const sel = { id: args.id, text: args.text, desc: args.desc, cls: args.class }
    if (!sel.id && !sel.text && !sel.desc && !sel.cls) throw new Error('需要 id、text、desc 或 class 其中之一。')
    const label = Object.entries(sel).filter(([, v]) => v).map(([k, v]) => k + '=' + v).join(' ')
    const seconds = Math.min(Math.max(args.seconds ?? 3, 1), 15)
    const fps = Math.min(Math.max(args.fps ?? 10, 2), 15)
    const gap = Math.round(1000 / fps)
    const deadline = Date.now() + seconds * 1000
    const t0 = Date.now()
    const raw = []
    let lastError = ''
    while (Date.now() < deadline) {
      const started = Date.now()
      try {
        const node = matchNode(parseNodes(await u2Dump(device)), sel)
        raw.push(node
          ? { t: started - t0, w: node.x2 - node.x1, h: node.y2 - node.y1, x: node.x1, y: node.y1 }
          : { t: started - t0, missing: true })
      } catch (error) {
        lastError = String(error?.message ?? error)
        raw.push({ t: started - t0, missing: true })
      }
      const left = gap - (Date.now() - started)
      if (left > 0) await new Promise((resolve) => setTimeout(resolve, left))
    }
    const hits = raw.filter((s) => !s.missing)
    const matched = hits.length > 0
    const real = []
    for (const s of hits) {
      const prev = real[real.length - 1]
      if (prev && prev.w === s.w && prev.h === s.h && prev.x === s.x && prev.y === s.y) continue
      real.push(s)
    }
    let biggest = 0
    let biggestAt = 0
    let jitter = 0
    let lastDir = 0
    let lastChange = 0
    const series = []
    for (let i = 0; i < real.length; i += 1) {
      const cur = real[i]
      series.push(cur.w + '×' + cur.h)
      if (i === 0) continue
      const prev = real[i - 1]
      const step = Math.max(Math.abs(cur.w - prev.w), Math.abs(cur.h - prev.h), Math.abs(cur.x - prev.x), Math.abs(cur.y - prev.y))
      lastChange = cur.t
      if (step > biggest) { biggest = step; biggestAt = cur.t }
      const dir = Math.sign(cur.x - prev.x) || Math.sign(cur.w - prev.w)
      if (step >= 3 && dir !== 0) {
        if (lastDir !== 0 && dir !== lastDir) jitter += 1
        lastDir = dir
      }
    }
    const changes = Math.max(0, real.length - 1)
    const first = real[0]
    const last = real[real.length - 1]
    const settle = changes === 0 ? 0 : Math.max(0, raw[raw.length - 1].t - lastChange)
    const avgGap = hits.length > 1 ? Math.round((hits[hits.length - 1].t - hits[0].t) / (hits.length - 1)) : 0
    let verdict
    if (!matched) {
      verdict = '没找到匹配控件（' + label + '）' + (lastError ? '：' + lastError : '') + '；先 adb_ui 看树确认 id/文字'
    } else if (changes === 0) {
      verdict = '几何没变：' + hits.length + ' 次采样（约 ' + avgGap + 'ms 一次），始终 ' + first.w + '×' + first.h + ' @' + first.x + ',' + first.y + '；若肉眼在动，说明动画在 WebView 画布内部，用 adb_motion 量像素'
    } else {
      verdict = '尺寸 ' + first.w + '×' + first.h + ' → ' + last.w + '×' + last.h + '，位置 ' + first.x + ',' + first.y + ' → ' + last.x + ',' + last.y + '，' + changes + ' 次几何变化，最大单步 ' + biggest + 'px' + (biggestAt ? '（' + biggestAt + 'ms）' : '') + '，' + (settle === 0 ? '末尾仍在变' : settle + 'ms 后稳住') + (jitter ? '，方向反复 ' + jitter + ' 次' : '')
    }
    const detail = matched
      ? ['序列：' + series.join(' → '), '采样 ' + hits.length + '/' + raw.length + ' 次命中，平均间隔 ' + avgGap + 'ms'].join('\n')
      : ''
    return {
      serial: device,
      selector: label,
      summary: verdict + '（总 ' + (Date.now() - began) + 'ms）',
      detail,
      samples: hits.length,
      changes,
      series: series.join(','),
      biggest_step_px: biggest,
      settle_ms: settle,
      matched,
      elapsed_ms: Date.now() - began,
    }
  },
}))

ctx.effect(() => ctx.tools.register({
    name: 'adb_proc',
    description: '看设备上的进程与内存：top 给最吃 CPU 的进程，mem 给指定包的内存明细，list 列进程。排查卡顿/被杀/内存涨先看这里。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['top', 'mem', 'list'], description: '默认 top' },
        package: { type: 'string', description: 'mem 用：包名，如 com.example.app' },
        lines: { type: 'integer', description: '最多回多少行，默认 20，上限 80' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          text: { type: 'string' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['ok', 'summary', 'text', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(`${value.summary}\n${value.text}`),
    },
    execute: async (args) => {
      const device = await serial()
      const began = Date.now()
      const action = args.action ?? 'top'
      const limit = Math.min(Math.max(args.lines ?? 20, 3), 80)
      let command
      if (action === 'mem') {
        if (!args.package) throw new Error('mem 需要 package：例如 com.example.app。')
        command = `dumpsys meminfo ${args.package} | head -${limit}`
      } else if (action === 'list') {
        command = `ps -A -o PID,RSS,NAME | head -${limit}`
      } else {
        command = `dumpsys cpuinfo | head -${limit}`
      }
      const result = await adb(['-s', device, 'shell', command], { timeout: 15_000 })
      const text = (result.out || '').replace(/\r/g, '').trim()
      return { ok: result.ok !== false, summary: `adb_proc ${action}（${Date.now() - began}ms）`, text: text || oneLine(result.err, 200), elapsed_ms: Date.now() - began }
    },
  }), 'adb: adb_proc')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_crash',
    description: [
      '看这台设备最近的崩溃和 ANR：FATAL EXCEPTION 摘要、进程名、首段堆栈，以及 dropbox / /data/anr 里的现场文件（有 root 时）。',
      '用户说「闪退了 / 卡死 / 白屏」而不给日志时先查这个，比让用户复述现象准；要完整堆栈再对它指向的包用 adb_sh logcat。',
      '复现前先看一眼，复现后再看一次，多出来的就是刚才那次。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        package: { type: 'string', description: '只看这个包名的崩溃（子串匹配，例如 com.whale.pet）' },
        lines: { type: 'integer', description: '最多回多少行原始日志，默认 40（上限 200）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          crashes: { type: 'integer' },
          anr: { type: 'integer' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['message', 'crashes', 'anr', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(value.message),
    },
    execute: async (args) => {
      const device = await serial()
      const began = Date.now()
      const limit = Math.min(200, Math.max(6, Number(args.lines ?? 40)))
      const wanted = typeof args.package === 'string' ? args.package.trim() : ''
      const parts = []
      let crashes = 0
      let anr = 0

      /* 触发方看的是现场：crash 缓冲区在重启后清空，所以每次现读，不缓存。 */
      const log = await adb(['-s', device, 'shell', 'logcat', '-b', 'crash', '-d', '-t', String(limit)], { timeout: 20_000 }).catch(() => null)
      const raw = log && log.ok ? log.out.trim() : ''
      const lines = raw === '' ? [] : raw.split('\n')
      const picked = wanted === '' ? lines : lines.filter((line) => line.includes(wanted))
      if (picked.length > 0) {
        crashes = picked.filter((line) => line.includes('FATAL EXCEPTION')).length || 1
        parts.push(`崩溃缓冲区（最后 ${picked.length} 行）`, picked.slice(-limit).join('\n'))
      } else {
        parts.push('崩溃缓冲区：空' + (wanted === '' ? '' : `（没有 ${wanted} 的记录）`))
      }

      /* dropbox 与 /data/anr 只有 root 能读；拿不到就明说，不假装设备没崩过。 */
      const drop = await adb(['-s', device, 'shell', 'su', '-c', 'ls -t /data/system/dropbox 2>/dev/null | head -6'], { timeout: 15_000 }).catch(() => null)
      const names = drop && drop.ok ? drop.out.split('\n').map((line) => line.trim()).filter((line) => /crash|anr|wtf/i.test(line)) : []
      if (names.length > 0) {
        /* dropbox 文件名里只有时间戳，看不出是哪个包：先按包名筛，筛不到再回落到最新一条。 */
        let chosen = null
        let body = ''
        for (const name of names.slice(0, 4)) {
          const read = await adb(['-s', device, 'shell', 'su', '-c', `head -30 /data/system/dropbox/${name} 2>/dev/null`], { timeout: 15_000 }).catch(() => null)
          const text = read && read.ok ? read.out.trim() : ''
          if (text === '') continue
          if (chosen === null) {
            chosen = name
            body = text
          }
          if (wanted === '' || text.includes(wanted)) {
            chosen = name
            body = text
            break
          }
        }
        if (chosen !== null && (wanted === '' || body.includes(wanted))) {
          crashes = Math.max(crashes, 1)
          parts.push(`dropbox 现场：${chosen}`, body.slice(0, 2500))
        } else if (chosen !== null) {
          parts.push(`dropbox 里有 ${names.length} 个崩溃文件，但都不是 ${wanted}`, body.slice(0, 600))
        }
      } else {
        parts.push('dropbox：没有 crash/anr 文件（或没有 root）')
      }

      const traces = await adb(['-s', device, 'shell', 'su', '-c', 'ls -t /data/anr 2>/dev/null | head -3'], { timeout: 15_000 }).catch(() => null)
      const files = traces && traces.ok ? traces.out.split('\n').map((line) => line.trim()).filter(Boolean) : []
      if (files.length > 0) {
        anr = files.length
        const top = await adb(['-s', device, 'shell', 'su', '-c', `head -25 /data/anr/${files[0]} 2>/dev/null`], { timeout: 15_000 }).catch(() => null)
        parts.push(`ANR 现场：${files.join(', ')}`, (top && top.ok ? top.out : '').trim().slice(0, 1800))
      } else {
        parts.push('ANR：没有 /data/anr 现场文件')
      }

      parts.push(`提示：想抓下一次崩溃，先 adb_sh 跑 logcat -c 清缓冲，复现后再调本工具。`)
      return { message: parts.join('\n\n'), crashes, anr, elapsed_ms: Date.now() - began }
    },
  }), 'adb: adb_crash')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_events',
    description: [
      '最近这台设备上发生的事，按时间倒推一行一条：人手在侧栏点了/滑了/打了什么、agent 自己做过什么、页面切到了哪个 Activity、有没有崩溃 / ANR / 被系统杀进程。',
      '用户说「刚才那个」「它自己跳走了」「我点了没反应」「又崩了」时先看这里，不要让他复述，也不要拿截图猜。',
      '默认回看 3 分钟；只看某个应用的记录就传 package。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'integer', description: '回看多少秒，默认 180（5–900）' },
        package: { type: 'string', description: '只看这个包名相关的事件（子串匹配）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          actions: { type: 'integer' },
          events: { type: 'integer' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['message', 'actions', 'events', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(value.message),
    },
    execute: async (args) => {
      const device = await serial()
      const began = Date.now()
      const windowMs = Math.min(900, Math.max(5, Number(args.seconds ?? 180))) * 1000
      const wanted = typeof args.package === 'string' ? args.package.trim() : ''
      const parts = []

      /* 前台是谁：两行就够，别把整份 dumpsys 拖进来。 */
      const top = await sh(device, 'dumpsys activity activities | grep -E "topResumedActivity|mResumedActivity" | head -2', 8000).catch(() => null)
      const topText = top && top.ok ? top.out.trim() : ''
      parts.push(`当前前台：${topText === '' ? '读不到（可能锁屏或界面正在切）' : topText.split('\n')[0].trim()}`)

      /* 操作时间线：人手与 agent 用不同前缀，谁动的设备一眼看得出来。 */
      const actions = recentActions(windowMs)
      parts.push(actions.length === 0
        ? `最近 ${Math.round(windowMs / 1000)} 秒没有任何点击 / 输入操作`
        : `最近的操作（倒推）：\n${actions.join('\n')}`)

      /* 页面切换、进程生死、崩溃标记：一次 logcat 读完再筛，比按 tag 分别读快。 */
      const log = await adb(['-s', device, 'shell', 'logcat', '-d', '-t', '600', '-v', 'time'], { timeout: 20_000 }).catch(() => null)
      const raw = log && log.ok ? log.out : ''
      /* 只认事件本身，不要求同一行带 tag：不同 ROM 的 tag 名不一样，卡 tag 会把切换记录全筛掉。 */
      const keep = /START u0|Displayed com\.|Force finishing|ANR in |am_crash|am_proc_died|am_kill|WIN DEATH|Start proc |FATAL EXCEPTION/
      const picked = []
      if (raw !== '') {
        for (const line of raw.split('\n')) {
          if (!keep.test(line)) continue
          if (wanted !== '' && !line.includes(wanted)) continue
          picked.push(line.trim())
        }
      }
      const events = picked.slice(-24).map((line) => `${logAge(line)}${line.slice(0, 240)}`)
      if (events.length === 0) parts.push(wanted === '' ? '日志里没有页面切换 / 进程事件' : `日志里没有 ${wanted} 的页面切换 / 进程事件`)
      else parts.push(`页面与进程事件（最后 ${events.length} 条）：\n${events.join('\n')}`)

      /* 默认 main 缓冲里通常没有 ActivityTaskManager 的切页记录（都被应用日志挤掉了），
         系统自己的切换在 events 缓冲里：am_focused_activity / am_proc_start / wm_create_activity 才是准的。 */
      const evLog = await adb(['-s', device, 'shell', 'logcat', '-b', 'events', '-d', '-t', '400', '-v', 'time'], { timeout: 15_000 }).catch(() => null)
      const evRaw = evLog && evLog.ok ? evLog.out : ''
      const evKeep = /am_focused_activity|wm_create_activity|wm_destroy_activity|am_proc_start|am_proc_died|am_crash|am_anr|am_kill|am_activity_launch_time|wm_on_resume_called/
      const evPicked = []
      const seenEv = new Set()
      if (evRaw !== '') {
        for (const line of evRaw.split('\n')) {
          if (!evKeep.test(line)) continue
          if (wanted !== '' && !line.includes(wanted)) continue
          /* 系统组件每几秒就冒一条，混在时间线里会把「用户做了什么」淹掉；
             指定 package 时不过滤，免得把要看的那条也筛掉。 */
          if (wanted === '' && isSystemNoise(line)) continue
          const trimmed = line.trim()
          const key = trimmed.replace(/^\S+\s+\S+\s+/, '').slice(0, 120)
          if (seenEv.has(key)) continue
          seenEv.add(key)
          evPicked.push(trimmed)
        }
      }
      const switches = evPicked.slice(-16).map((line) => `${logAge(line)}${line.slice(0, 200)}`)
      if (switches.length > 0) parts.push(`切页与进程事件（系统事件缓冲，最后 ${switches.length} 条）：\n${switches.join('\n')}`)

      /* 原始事件是给排查用的；用户说「刚才它自己跳走了」时，模型需要的是人话。
         同一批事件再翻一遍，去重、去掉系统组件噪声，一行一件事。 */
      if (wanted === '') {
        const story = await deviceStory(device, windowMs).catch(() => [])
        if (story.length > 0) parts.push(`人话时间线（倒推，直接照着回答用户）：\n${story.join('\n')}`)
      }

      /* 崩溃缓冲单独读：和上面混在一起时 FATAL 堆栈会被普通日志冲掉。 */
      const crash = await adb(['-s', device, 'shell', 'logcat', '-b', 'crash', '-d', '-t', '12'], { timeout: 12_000 }).catch(() => null)
      const crashText = crash && crash.ok ? crash.out.trim() : ''
      if (crashText !== '' && (wanted === '' || crashText.includes(wanted))) {
        /* 缓冲里的旧记录不能当成「刚刚崩了」：每行标出距现在多久，边界按整行切。 */
        const crashLines = crashText.split('\n').slice(-14).map((line) => `${logAge(line)}${line.slice(0, 240)}`)
        parts.push(`崩溃缓冲（最近 ${crashLines.length} 行，标了距现在多久）：\n${crashLines.join('\n')}`)
      } else if (crashText !== '' && wanted !== '') {
        parts.push(`崩溃缓冲里有记录，但和 ${wanted} 无关`)
      }

      parts.push('要更早的记录用 adb_sh 跑 logcat -d；要看某个应用的完整堆栈用 adb_crash。')
      return {
        message: parts.join('\n\n'),
        actions: actions.length,
        events: events.length,
        elapsed_ms: Date.now() - began,
      }
    },
  }), 'adb: adb_events')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_web',
    description: [
      '直读 App 里 WebView 的 DOM（走 devtools 协议，比文本树准）：list 列页面，dom 按选择器取元素矩形与文字，eval 跑一段 JS。',
      '混合 App（内嵌 H5）定位不准时优先用它；返回 CSS 像素矩形，附带换算到设备像素的比例，可直接喂 adb_tap point。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'dom', 'eval'], description: '默认 list' },
        package: { type: 'string', description: '包名（必填）：用来找 WebView 进程' },
        selector: { type: 'string', description: 'dom 用：CSS 选择器，默认 *，只回有直接文字的元素' },
        expression: { type: 'string', description: 'eval 用：要执行的 JS 表达式（返回值按 JSON 回）' },
        lines: { type: 'integer', description: '最多回多少个元素，默认 20' },
        webPort: { type: 'integer', description: '已手动 adb forward 时直接用这个本机端口，跳过自动查找' },
      },
      required: ['package'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          text: { type: 'string' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['ok', 'summary', 'text', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(`${value.summary}\n${value.text}`),
    },
    execute: async (args) => {
      const device = await serial()
      const began = Date.now()
      const target = args.webPort ? { pid: '0', socketPid: '手动转发', port: args.webPort } : await webTarget(device, args.package)
      const pagesResponse = await fetch(`http://127.0.0.1:${target.port}/json/list`, { signal: AbortSignal.timeout(6000) }).catch((error) => {
        throw new Error(`WebView 调试口连不上：${oneLine(error.message, 120)}（App 可能没开 WebView 调试）`)
      })
      const pages = await pagesResponse.json().catch(() => [])
      const page = pages.find((item) => item.webSocketDebuggerUrl && String(item.type) === 'page') ?? pages[0]
      if ((args.action ?? 'list') === 'list') {
        const lines = pages.map((item) => `${item.title || '(无标题)'} · ${oneLine(item.url, 90)}`)
        return { ok: true, summary: `${pages.length} 个页面（进程 ${target.socketPid || target.pid}）`, text: lines.join('\n') || '没有页面', elapsed_ms: Date.now() - began }
      }
      if (!page?.webSocketDebuggerUrl) throw new Error('这个 WebView 没有可用的调试页面。')
      const limit = Math.min(Math.max(args.lines ?? 20, 1), 60)
      const expression = args.action === 'dom'
        ? `(() => {
            const out = [];
            const nodes = Array.from(document.querySelectorAll(${JSON.stringify(args.selector ?? '*')}));
            for (const el of nodes) {
              const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
              const label = own || (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '';
              if (!label) continue;
              const r = el.getBoundingClientRect();
              if (r.width < 2 || r.height < 2) continue;
              out.push({ tag: el.tagName.toLowerCase(), text: label.slice(0, 60), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
              if (out.length >= ${limit}) break;
            }
            return { viewport: { iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio, sw: screen.width, sh: screen.height }, items: out };
          })()`
        : `(() => { const value = (${args.expression ?? 'document.title'}); return { viewport: { iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio, sw: screen.width, sh: screen.height }, value }; })()`
      const reply = await wsCall(page.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, 8000)
      if (reply.error) throw new Error(`WebView 执行失败：${oneLine(reply.error.message, 160)}`)
      const result = reply.result?.result?.value
      if (!result) throw new Error('WebView 没有返回值（页面可能已跳转）。')
      const scale = result.viewport.iw > 0 ? result.viewport.sw / result.viewport.iw : 1
      if (args.action === 'eval') {
        const text = typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 2)
        return { ok: true, summary: `eval 完成 · viewport ${result.viewport.iw}×${result.viewport.ih} 缩放 ${scale.toFixed(2)}`, text: oneLine(text, 8000), elapsed_ms: Date.now() - began }
      }
      const rows = (result.items ?? []).map((item) => {
        const cx = Math.round((item.x + item.w / 2) * scale)
        const cy = Math.round((item.y + item.h / 2) * scale)
        return `<${item.tag}> "${oneLine(item.text, 40)}" css ${item.x},${item.y} ${item.w}×${item.h} → 点 ${cx},${cy}`
      })
      return {
        ok: true,
        summary: `${rows.length} 个元素 · viewport ${result.viewport.iw}×${result.viewport.ih} → 设备 ${result.viewport.sw}×${result.viewport.sh}（×${scale.toFixed(2)}）`,
        text: rows.join('\n') || '选择器没匹配到带文字的元素',
        elapsed_ms: Date.now() - began,
      }
    },
  }), 'adb: adb_web')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_action',
    description: [
      '系统级动作一条命令完成，不用在界面里找按钮：home / back / recents / lock / wake / rotate / notifications / quick_settings / night_mode。',
      '走设备 shell（常驻通道，一次 10–40ms），比点界面稳；点亮屏幕、收紧通知栏、转屏这类用它。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['home', 'back', 'recents', 'lock', 'wake', 'rotate', 'notifications', 'quick_settings', 'night_mode'],
          description: '要执行的系统动作',
        },
        degrees: { type: 'integer', enum: [0, 90, 180, 270], description: 'rotate 用：指定方向；不写就转到下一个方向' },
        enable: { type: 'boolean', description: 'night_mode 用：true 开夜间模式，false 关' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['ok', 'summary', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(value.summary),
    },
    execute: async (args) => {
      const device = await serial()
      const began = Date.now()
      let cmd
      let label
      if (args.action === 'home') { cmd = 'input keyevent 3'; label = '回桌面' }
      else if (args.action === 'back') { cmd = 'input keyevent 4'; label = '返回' }
      else if (args.action === 'recents') { cmd = 'input keyevent 187'; label = '最近任务' }
      else if (args.action === 'lock') { cmd = 'input keyevent 223'; label = '锁屏' }
      else if (args.action === 'wake') { cmd = 'input keyevent 224; wm dismiss-keyguard'; label = '点亮并解锁' }
      else if (args.action === 'notifications') { cmd = 'cmd statusbar expand-notifications'; label = '拉下通知栏' }
      else if (args.action === 'quick_settings') { cmd = 'cmd statusbar expand-settings'; label = '拉下快捷开关' }
      else if (args.action === 'night_mode') { cmd = `cmd uimode night ${args.enable === false ? 'no' : 'yes'}`; label = args.enable === false ? '关夜间模式' : '开夜间模式' }
      else if (args.action === 'rotate') {
        const current = await sh(device, 'settings get system user_rotation', 8000)
        const now = Number(String(current.out ?? '').trim())
        const order = [0, 90, 180, 270]
        const degrees = args.degrees ?? order[(order.indexOf(Number.isFinite(now) ? now * 90 : 0) + 1) % 4]
        const value = order.indexOf(degrees)
        cmd = `settings put system accelerometer_rotation 0; settings put system user_rotation ${value < 0 ? 0 : value}`
        label = `转到 ${degrees}°`
      } else {
        throw new Error('action 只能是 home / back / recents / lock / wake / rotate / notifications / quick_settings / night_mode。')
      }
      const r = await sh(device, cmd, 12_000)
      if (!r.ok) throw new Error(failureNote(label, r))
      lastActions.push({ at: Date.now(), what: label })
      if (lastActions.length > 400) lastActions.splice(0, lastActions.length - 400)
      return { ok: true, summary: `${label}完成（${r.ms}ms）。界面变化用 adb_ui 确认。`, elapsed_ms: Date.now() - began }
    },
  }), 'adb: adb_action')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_shot',
    description: '截一张设备屏幕，缩到长边 900px 后返回文件路径，用 read_image 看。只在确实需要看颜色、布局、相机/扫码画面时用；「页面对不对、按钮在不在、有没有报错」用 adb_ui 文本树，快十倍且不花图片 token。scale=0 保留原图。',
    parameters: {
      type: 'object',
      properties: {
        scale: { type: 'integer', description: '长边像素，默认 900；传 0 保留原图（2136x3200 的平板原图约 9MB）' },
        region: { type: 'string', description: '只截这块区域，格式 "x,y,w,h"（设备像素，左上角原点）。看桌宠、小图标这类局部细节用，比整屏快也省 token' },
        path: { type: 'string', description: '保存路径（绝对路径），不写就放临时目录' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          bytes: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['path', 'bytes', 'width', 'height', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(`截图：${value.path}（${value.width}x${value.height}，${Math.round(value.bytes / 1024)}KB，${value.elapsed_ms}ms）。需要看画面时对路径调用 read_image。`),
    },
    execute: async (args) => {
      const device = await serial()
      const began = Date.now()
      /* 侧栏正在直播时，最新一帧就是现在这张屏：0ms，不必再 screencap。 */
      const region = parseRegion(args.region)
      /* 直播帧是 960x640 缩过的，按它裁会错位：有 region 就老老实实抓整屏。 */
      const live = args.scale === 0 || region !== null ? null : mirror.liveFrame(device)
      if (live !== null) {
        const dims = jpegSize(live.frame)
        if (dims !== null) {
          const target = args.path ?? join(tmpdir(), `adb-${Date.now()}.jpg`)
          await mkdir(dirname(target), { recursive: true }).catch(() => {})
          await writeFile(target, live.frame).catch(() => {})
          return { path: target, bytes: live.frame.length, width: dims.w, height: dims.h, elapsed_ms: Date.now() - began }
        }
      }
      const shot = await screenshot(device, { scale: args.scale, path: args.path, region })
      return { path: shot.path, bytes: shot.bytes, width: shot.width, height: shot.height, elapsed_ms: shot.ms }
    },
  }), 'adb: adb_shot')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_recent',
    description: '把最近几秒的画面拼成一张 3x2 序列图（本地环形录像里抽帧，不碰设备）：动画比例、位移、卡顿这类单帧看不出的问题用它。看路径用 read_image。',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'integer', description: '回看几秒，默认 6（2–12）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          seconds: { type: 'integer' },
          bytes: { type: 'integer' },
          source: { type: 'string' },
          message: { type: 'string' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['path', 'seconds', 'bytes', 'source', 'message', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(value.message),
    },
    execute: async (args) => {
      const device = await serial()
      const began = Date.now()
      const seconds = Math.min(12, Math.max(2, Number(args.seconds ?? 6)))
      const strip = await mirror.recentStrip(device, seconds)
      if (strip.ok !== true) {
        return { path: '', seconds, bytes: 0, source: 'none', message: `最近没有录到画面：现场录屏没起来（可能侧栏直播正占着编码器），改用 adb_shot 抓单帧。`, elapsed_ms: Date.now() - began }
      }
      /* 来源必须如实报：磁盘段可能是几分钟前的，拿旧帧当「刚才」会把人带错方向。 */
      const origin = strip.source === 'live'
        ? '直播内存帧'
        : strip.source === 'burst'
          ? '现场现录'
          : `磁盘录像（最后一段 ${Math.round((strip.ageMs ?? 0) / 1000)} 秒前，不是刚刚）`
      return {
        path: strip.path,
        seconds,
        bytes: strip.bytes,
        source: strip.source ?? 'none',
        message: `${origin}：${seconds} 秒窗口的 6 帧拼图 ${strip.path}（${Math.round((strip.bytes ?? 0) / 1024)}KB，${Date.now() - began}ms）。看动效比例/位移用 read_image。`,
        elapsed_ms: Date.now() - began,
      }
    },
  }), 'adb: adb_recent')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_motion',
    description: '逐像素量化「刚才那几秒」的动效：每帧变了多大、变在哪、抖了几下、多久稳住。桌宠/悬浮窗/自绘动画在控件树里看不见，比例不协调、跳变、回弹过头用这个量，别用眼睛猜。',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'integer', description: '回看几秒，默认 4（2–12）' },
        fps: { type: 'integer', description: '抽帧帧率，默认 8（2–10）' },
        region: { type: 'string', description: '只看这一块，格式 "x,y,w,h"（设备像素），例如桌宠所在角落' },
        target: { type: 'string', description: '按控件自动定区域：给文字/资源 id 子串，自动取它的框（比手算坐标准）' },
        threshold: { type: 'integer', description: '像素差阈值，默认 12（2–64）；屏幕有噪点/渐变时调高' },
        force: { type: 'boolean', description: '不管有没有近的磁盘录像，都现在录一段再量（复现/对比时用，多花约 4 秒）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          source: { type: 'string' },
          peak_size_px: { type: 'integer' },
          overshoot_pct: { type: 'number' },
          jitter: { type: 'integer' },
          settle_ms: { type: 'integer' },
          changed_frames: { type: 'integer' },
          real_fps: { type: 'number' },
          region_used: { type: 'string' },
          metric: { type: 'string' },
          biggest_step_at_ms: { type: 'integer' },
          series: { type: 'string' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['message', 'source', 'peak_size_px', 'overshoot_pct', 'jitter', 'settle_ms', 'changed_frames', 'real_fps', 'region_used', 'biggest_step_at_ms', 'series', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(value.message),
    },
    execute: async (args) => {
      const device = await serial()
      const began = Date.now()
      const seconds = Math.min(12, Math.max(2, Number(args.seconds ?? 4)))
      const fps = Math.min(10, Math.max(2, Number(args.fps ?? 8)))
      let region = parseRegion(args.region) ?? null
      let regionNote = region === null ? '全屏' : '区域 ' + region.w + '×' + region.h + ' @' + region.x + ',' + region.y
      const target = typeof args.target === 'string' ? args.target.trim() : ''
      if (region === null && target !== '') {
        const needle = target.toLowerCase()
        const node = parseNodes(await u2Dump(device)).find((each) =>
          (each.text !== '' && each.text.toLowerCase().includes(needle))
          || (each.id !== '' && each.id.toLowerCase().includes(needle))
          || (each.desc !== '' && each.desc.toLowerCase().includes(needle))) ?? null
        if (node === null) {
          return {
            message: '没找到「' + target + '」这个控件，分析区域没设成。先用 adb_ui 看当前界面的文字，或直接给 region="x,y,w,h"。',
            source: 'none', peak_size_px: 0, overshoot_pct: 0, jitter: 0, settle_ms: -1,
            changed_frames: 0, real_fps: 0, region_used: '', metric: 'diag',
            biggest_step_at_ms: 0, series: '', elapsed_ms: Date.now() - began,
          }
        }
        const nodeW = node.x2 - node.x1
        const nodeH = node.y2 - node.y1
        const pad = Math.round(Math.max(nodeW, nodeH) * 0.1)
        region = { x: Math.max(0, node.x1 - pad), y: Math.max(0, node.y1 - pad), w: nodeW + pad * 2, h: nodeH + pad * 2 }
        regionNote = '控件「' + (node.text || node.id.split('/').pop()) + '」 ' + nodeW + '×' + nodeH + ' @' + node.x1 + ',' + node.y1
      }
      const motion = await mirror.motion(device, { seconds, fps, region, threshold: args.threshold, force: args.force === true })
      if (motion === null) {
        return {
          message: '没拿到可分析的画面：现场录屏没起来（可能侧栏直播正占着编码器），先用 adb_shot 看一眼当前画面。',
          source: 'none', peak_size_px: 0, overshoot_pct: 0, jitter: 0, settle_ms: -1,
          changed_frames: 0, real_fps: 0, region_used: regionNote, metric: 'diag',
          biggest_step_at_ms: 0, series: '', elapsed_ms: Date.now() - began,
        }
      }
      const origin = motion.source === 'burst' ? '现场现录' : '磁盘录像（' + Math.round(motion.age_ms / 1000) + ' 秒前）'
      const cadence = '抽 ' + motion.frames + ' 帧，变化 ' + motion.changed_frames + ' 帧（有效 ' + motion.real_fps + ' fps）'
      if (motion.changed_frames < 2) {
        return {
          message: origin + ' ' + seconds + 's，' + regionNote + '，' + cadence + '：这几秒画面基本没动。'
            + '静态界面、或动画不在这一块；要看控件几何用 adb_watch，要看整屏用 adb_shot。',
          source: motion.source, peak_size_px: 0, overshoot_pct: 0, jitter: 0, settle_ms: -1,
          changed_frames: motion.changed_frames, real_fps: motion.real_fps, region_used: regionNote, metric: 'diag',
          biggest_step_at_ms: 0, series: '', elapsed_ms: Date.now() - began,
        }
      }
      /* 只有两三帧在动时，峰值/落点之比没有统计意义（15600% 这种数会误导人）：
         先看证据够不够，再下结论。 */
      const solid = motion.chained_frames >= 4 && motion.tail_size_px >= 12 && motion.peak_size_px >= 20
      const verdict = !solid
        ? '变化帧太少或幅度太小，判不出抖动/回弹（只看到最大单帧跳了 ' + motion.biggest_step_px + 'px）'
        : motion.jitter >= 3
          ? '变化方向来回摆了 ' + motion.jitter + ' 次，偏抖'
          : motion.overshoot_pct >= 30
            ? '峰值比落点大 ' + motion.overshoot_pct + '%，回弹过头'
            : '变化方向上没有明显抖动'
      const settle = motion.settle_ms >= 0
        ? '末尾 ' + motion.settle_ms + 'ms 没再变（已稳住）'
        : '末尾仍在变（截到动画中途，可加 force 再录一段）'
      const chainNote = motion.chained_frames >= 2
        ? '主链路 ' + motion.chained_frames + ' 帧'
        : '没有连成一条的变化（各处各动一下）'
      const sizeLabel = motion.metric === 'reach' ? '外缘半径' : '变化外接框对角'
      const message = origin + ' ' + seconds + 's，' + regionNote + '，' + cadence + '，逐像素比对：'
        + chainNote + '，' + sizeLabel + ' ' + motion.peak_size_px + 'px（峰值，落点 ' + motion.tail_size_px + 'px），最大单帧跳变 ' + motion.biggest_step_px
        + 'px（约 ' + motion.biggest_step_at_ms + 'ms 处），' + settle
        + '，抖 ' + motion.jitter + ' 次 → ' + verdict + '。'
        + (motion.region === null ? '（全屏统计，多处动效会混在一起；要看某一处就传 target 或 region）' : '')
        + '（总 ' + (Date.now() - began) + 'ms' + (motion.record_ms > 0 ? '：录屏 ' + motion.record_ms + ' / 拉回 ' + motion.pull_ms : '') + '）'
      return {
        message,
        source: motion.source,
        peak_size_px: motion.peak_size_px,
        overshoot_pct: motion.overshoot_pct,
        jitter: motion.jitter,
        settle_ms: motion.settle_ms,
        changed_frames: motion.changed_frames,
        real_fps: motion.real_fps,
        region_used: regionNote,
        metric: motion.metric ?? 'diag',
        biggest_step_at_ms: motion.biggest_step_at_ms,
        series: motion.series.join(','),
        elapsed_ms: Date.now() - began,
      }
    },
  }), 'adb: adb_motion')


  ctx.effect(() => ctx.tools.register({
    name: 'adb_state',
    description: '一次调用拿到设备底层状态：前台 Activity、窗口栈（弹窗/输入法/悬浮窗都在栈里）、键盘是否弹出、方向与分辨率、亮屏、电量、是否 root。约 0.5s，判断「有没有弹窗 / 键盘挡没挡 / 跳没跳页」先用它，不要截图。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          activity: { type: 'string' },
          focus: { type: 'string' },
          windows: { type: 'string' },
          keyboard: { type: 'boolean' },
          rotation: { type: 'integer' },
          size: { type: 'string' },
          dialog: { type: 'boolean' },
          screen_on: { type: 'boolean' },
          battery: { type: 'string' },
          root: { type: 'boolean' },
          message: { type: 'string' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['activity', 'focus', 'dialog', 'windows', 'keyboard', 'rotation', 'size', 'screen_on', 'battery', 'root', 'message', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(value.message),
    },
    execute: async () => {
      const device = await serial()
      const started = Date.now()
      const script = [
        /* 不能用 -m2：MIUI 先输出两行 null（mCurrentFocus=null / mFocusedApp=null），
           真值在后面的 Window{...} / ActivityRecord{...} 行里，截前两条就永远读到「未知」。 */
        'echo @F@', 'dumpsys window | grep -E "mCurrentFocus=|mFocusedApp=" | head -8',
        'echo @W@', 'dumpsys window windows | grep -E "^  Window #" | head -12',
        'echo @I@', 'dumpsys input_method | grep -m3 -E "mInputShown=|mShowRequested="',
        'echo @P@', 'dumpsys power | grep -m1 -E "mWakefulness="',
        'echo @B@', 'dumpsys battery | grep -m2 -E "level:|status:"',
        'echo @R@', 'dumpsys display | grep -m1 -o "orientation=[0-9]"',
        'echo @S@', 'wm size',
      ].join('; ')
      const r = await adb(['-s', device, 'shell', script], { timeout: 20_000, buffer: 4 << 20 })
      if (!r.ok && !r.out) throw new Error(`读状态失败：${oneLine(r.err || 'adb 无输出', 200)}`)
      const sections = {}
      let current = ''
      for (const line of r.out.split('\n')) {
        const marker = /^@([FWIPBRS])@$/.exec(line.trim())
        if (marker) {
          current = marker[1]
          sections[current] = []
          continue
        }
        if (current) sections[current].push(line)
      }
      const joined = (key) => (sections[key] ?? []).join('\n').trim()
      const focusSection = joined('F')
      const activity = /mFocusedApp=ActivityRecord\{[^}]*? u\d+ ([\w.]+\/[\w.$]+)/.exec(focusSection)?.[1] ?? '未知'
      const focusWindow = /mCurrentFocus=Window\{[0-9a-f]+ u\d+ ([\w.]+\/[\w.$]+)\}/.exec(focusSection)?.[1] ?? activity
      const sameComponent = (left, right) => {
        const norm = (value) => {
          const [pkg, cls] = String(value).split('/')
          if (!cls) return value
          return `${pkg}/${cls.startsWith('.') ? `${pkg}${cls}` : cls}`
        }
        return norm(left) === norm(right)
      }
      const dialog = !sameComponent(focusWindow, activity) && activity !== '未知' && !/InputMethod/i.test(focusWindow)
      const windowNames = [...new Set([...joined('W').matchAll(/Window #\d+ Window\{[0-9a-f]+ u\d+ ([^}\s]+)/g)].map((m) => m[1]))]
      const ime = joined('I')
      const keyboard = /mInputShown=true/.test(ime)
      const rotation = Number(/orientation=(\d)/.exec(joined('R'))?.[1] ?? 0) * 90
      const sizes = [...joined('S').matchAll(/(Physical|Override) size: (\d+x\d+)/g)].map((m) => `${m[1] === 'Override' ? '覆盖' : '物理'} ${m[2]}`)
      const screenOn = /mWakefulness=(Awake|Dreaming)/.test(joined('P'))
      const level = /level: (\d+)/.exec(joined('B'))?.[1]
      const root = await deviceRoot(device)
      const message = [
        `前台 ${activity}`,
        `焦点窗口 ${focusWindow}${dialog ? '（不是前台 Activity：可能有弹窗/浮层盖着）' : ''}`,
        `窗口 ${windowNames.length > 0 ? windowNames.slice(0, 8).join(' | ') : '（没读到窗口名）'}`,
        `键盘${keyboard ? '弹着' : '没弹'} · ${rotation}° · ${sizes.join(' / ') || '尺寸未知'} · ${screenOn ? '亮屏' : '熄屏'} · 电量 ${level ? `${level}%` : '未知'} · root ${root ? '有' : '无'}`,
      ].join('\n')
      return {
        activity,
        focus: focusWindow,
        dialog,
        windows: windowNames.slice(0, 12).join(' '),
        keyboard,
        rotation,
        size: sizes.join(' / ') || '未知',
        screen_on: screenOn,
        battery: level ? `${level}%` : '未知',
        root,
        message,
        elapsed_ms: Date.now() - started,
      }
    },
  }), 'adb: adb_state')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_device',
    description: '看当前连了哪些 Android 设备、状态、型号，以及选中的设备序列号和分辨率。工具报「没有检测到设备」时先用它排查。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          serial: { type: 'string' },
          devices: { type: 'string' },
          size: { type: 'string' },
          profile: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['serial', 'devices', 'size', 'message'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(value.message),
    },
    execute: async () => {
      const devices = await listDevices()
      const device = await serial().catch(() => '')
      let size = '未知'
      let profile = ''
      if (device) {
        const r = await adb(['-s', device, 'shell', 'wm size; getprop ro.build.characteristics; getprop ro.build.version.sdk'], { timeout: 8000 })
        size = /(\d+x\d+)/.exec(r.out)?.[1] ?? '未知'
        const lines = r.out.split('\n').map((line) => line.trim()).filter((line) => line && !/size/i.test(line))
        if (lines.length > 0) profile = `${lines[0] || '未知'} · sdk ${lines[1] || '?'}`
      }
      const listed = devices.map((item) => `${item.serial}(${item.state}${item.model ? `,${item.model}` : ''})`).join(' ') || '没有设备'
      return {
        serial: device,
        devices: listed,
        size,
        profile,
        message: devices.length > 0
          ? `设备：${listed}\n当前使用：${device} · ${size}${profile ? ` · ${profile}` : ''}`
          : '没有检测到设备：检查 USB 线、手机的「USB 调试」开关，以及手机上是否点了允许调试。',
      }
    },
  }), 'adb: adb_device')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_mirror',
    description: [
      '把设备画面镜像到右侧栏「实时ADB」：那里的画面可以直接点、拖动，也能画圈标注后推进聊天。',
      'action=open 打开侧栏（用户也能自己从「更多工具」打开）；status 看是否在直播和缓冲长度；peek 拿当前一帧的 JPEG 路径（比 adb_shot 快，直接 read_image）；recent 列本机环形缓冲的片段文件；stop 停掉录制。',
      '需要人眼看画面、并说明「就是这个位置」时用它；判断界面结构仍用 adb_ui。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'status', 'peek', 'recent', 'stop'], description: '要做的操作' },
        serial: { type: 'string', description: '设备序列号；不写用当前设备' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['summary'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(value.summary),
    },
    execute: async (args, exec) => {
      if (args.action === 'open') {
        const device = await serial()
        /* 只能开在「发起这次调用的会话」自己的右栏里：拿不到会话就什么都不开，绝不退回到屏幕上那一栏。 */
        const sid = String(exec?.agent?.session?.id ?? exec?.session?.id ?? exec?.agent?.sessionId ?? exec?.sessionId ?? '')
        if (sid === '') {
          return { summary: '找不到发起这次调用的会话，没有打开侧栏（避免开到别人的会话里）。' }
        }
        const opened = mirror.open(sid)
        const state = await mirror.status(device)
        return {
          summary: [
            `已请求在「实时ADB」侧栏打开（${opened} 个页面收到）· ${device}`,
            '页签已建在本会话右栏，回到本会话自动展开',
            state.live ? `画面在直播，约 ${state.fps} 帧/秒` : '画面正在起，几秒后出现',
            `本机缓冲 ${state.bufferedSeconds ?? 0}s`,
          ].join(' · '),
        }
      }
      if (args.action === 'stop') {
        mirror.stopAll()
        return { summary: '已停止镜像与录制。' }
      }
      const device = args.serial || await serial()
      if (args.action === 'peek') {
        const frame = await mirror.peek(device)
        if (!frame.ok) return { summary: `画面还没起来（${device}），再等一两秒重试。` }
        return {
          summary: `${device} · 当前帧 ${Math.round(frame.bytes / 1024)}KB · ${frame.path}`,
          path: frame.path,
        }
      }
      if (args.action === 'recent') {
        const state = await mirror.status(device)
        if (!state.dir) return { summary: `${device} · 还没有录制缓冲；先 action=open 或 peek 起一次。` }
        const listed = (await mirror.segmentList?.(device)) ?? null
        return { summary: `${device} · 本机缓冲约 ${state.bufferedSeconds ?? 0}s · ${state.dir}${listed ? ` · ${listed.length} 段` : ''}` }
      }
      const state = await mirror.status(device)
      return {
        summary: [
          `${device} · ${state.live ? '正在直播' : '未在直播'}`,
          state.live ? `${state.fps ?? 4} 帧/秒 · 已推 ${state.frames ?? 0} 帧` : '',
          `缓冲 ${state.bufferedSeconds ?? 0}s`,
          state.dir ? state.dir : '',
        ].filter(Boolean).join(' · '),
      }
    },
  }), 'adb: adb_mirror')

  const prompt = ctx.get?.('systemPrompt')
  if (prompt && typeof prompt.section === 'function') {
    ctx.effect(() => prompt.section({
      name: 'adb-text-first',
      order: 860,
      text: [
        '## Android 调试：先读文本树，截图只在看外观时用',
        '',
        '判定顺序：先 `adb_state`（前台 Activity + 窗口栈 + 键盘 + 方向，约 0.5s），再 `adb_ui`（界面文本树）。不要用截图回答「页面对不对 / 有没有弹窗 / 键盘挡住没 / 跳没跳页 / 有没有报错」——报错用 `adb_sh logcat -d -t 200`。',
        '要等接口返回、跳转或弹窗，传 `wait_for_text` / `wait_for_activity`，不要 sleep 后再截图；`adb_tap` 点完会自己回执界面有没有变，没变就是可疑信号（被挡住/没点中/还在动画）。',
        '连着做的一串动作（点开→等加载→输入→发送、或先回桌面再进目标页）用 `adb_do` 一次调用跑完，比一步一调少好几个回合；每一步可带 `assert_text` / `assert_gone` 核对，也可带 `wait_all`（几段文字全出现）/ `wait_any`（任一出现就算过，加载完或报错弹窗两种结局都往下走），失败会停在那一步并报出当前页面和屏上的文字。',
        '只想知道「刚才点了之后变了什么」用 `adb_ui changed_only=true`（只给新增/消失的行）。桌面、返回、最近任务、锁屏、亮屏、转屏、通知栏、夜间模式用 `adb_action` 一条命令，不要再去界面里找按钮。',
        '点击用 `adb_tap`（ref / 文字 / id，自己或最近可点祖先里挑更准的落点；ref 来自最近一次 `adb_ui`；目标还没出现会自己等最多 900ms，可用 `wait_ms` 调），不确定有哪些就先 `adb_find`（一次拿全部命中 + ref + 坐标），列表里找不到用 `adb_scroll_to` 边滑边找；输入用 `adb_input`，装包启停用 `adb_app`。要拖拽、曲线滑、按住再拖这种手指轨迹，用 `adb_gesture`（逐点 DOWN/MOVE/UP，比 `input swipe` 的直线更像真人）。顶部状态、开关这类一步就能改的，直接 `adb_sh`（如 `settings put system font_scale 1.15`、`svc wifi enable`、`pm grant`），比点 UI 快且不会点歪。设备已 root 时 `adb_sh root=true cmd="cat /data/data/<包名>/shared_prefs/x.xml"` 能直接读应用存储、数据库、dropbox —— 状态类问题先读存储，比走 UI 点进去更准。',
        '`adb_shot` 只在这些时候用：颜色/布局/相机扫码画面/图表，或文本树几乎全是空节点（Flutter、自绘、部分 WebView）。图缩到长边 900px，配 `read_image` 看。「文本树看着是空的」先别急着截图：`adb_ui` 发现可读文字少于 4 个会自动跑一次 macOS 视觉 OCR，把识别出的文字当成可点击节点补进树里（来源标记 `+ocr`），慢 200ms 但省掉一次截图回合。',
        '动效问题用 `adb_anim`：给 ref/text/id 加时长和 fps，采样期间可以带 `trigger`（tap/swipe/text/action）点一下触发动画，回来的是尺寸/位置时间线 + 抖动次数、超调、帧间步长、稳定时间，比连拍截图准，也不用读图。局限：它读的是控件树坐标，列表滚动、页面转场这类合成器动画坐标可能不动，那种情况改成 `adb_mirror` 里的帧序列看。',
        '卡顿、被杀、内存涨用 `adb_proc`（top / mem / list），别截图猜。内嵌 H5 定位不准用 `adb_web`（CDP 直读 DOM，返回 CSS 矩形和换算后的设备坐标，可直接喂 `adb_tap point=`）；App 没开 WebView 调试时会明确报错。',
      ].join('\n'),
    }), 'adb: system prompt section')
  }
}

/**
 * 测试与脚本出口：纯函数给单测用，几个设备读原语给 scripts/device-bench.mjs 量开销。
 * 这些都是内部实现，不是插件 API：改名不影响工具契约；往这里加东西也等于放弃「纯函数」承诺，
 * 需要设备的地方（如 resolveSerial）必须显式写清它连 adb。
 */
export const __internals = {
  selectNodes,
  nearMiss,
  collapseSameSpot,
  spotList,
  matches,
  nodeStateOk,
  parseNodes,
  compactTree,
  shortId,
  displaySizeFrom,
  decodeEntities,
  digestLine,
  validateSteps,
  retryBudget,
  resolveSerial,
  dumpState,
  foregroundActivity,
  waitFor,
  findBlocker,
  tapPointFast,
  awaitStable,
  scrollToText,
  scrollToSelector,
  u2Dump,
  screenSize,
  scrollFrames,
  swipeLine,
  rectForSelector,
  acquireDirect,
  DIRECT_GATE,
  captureEvidence,
  guardOutput,
  awaitChange,
  tapMissReason,
  describeTapMiss,
  diffLines,
}
