/**
 * Vision 快路径基准：同一次截图，量「全屏 / 裁区域 / 缩长边 / 同帧复用」几种 OCR 方式的耗时与准确率。
 *
 * 结论只来自实测：每一档都单独报「截图耗时」和「识别耗时」，准确率用全分辨率全屏 OCR 的结果当参照。
 *
 * 用法：
 *   node test/ocr-bench.mjs               # 默认每档 3 次
 *   node test/ocr-bench.mjs --n 5         # 每档 5 次
 *   node test/ocr-bench.mjs --keep        # 测完不回桌面
 *
 * 只做只读操作：打开「关于平板」页读文字，结束后回桌面。不写设备状态。
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { __internals } from '../index.js'
import { ocrImage, stopOcr } from '../ocr.js'

const run = promisify(execFile)
const ADB = process.env.ADB ?? 'adb'
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const flag = (name) => argv.includes(`--${name}`)

/** 每档模式：name 是人类可读名，options 直接喂 ocrImage。 */
const MODES = [
  { name: '全屏·原分辨率', options: {} },
  { name: '全屏·长边 800', options: { max: 800 } },
  { name: '全屏·长边 600', options: { max: 600 } },
  { name: '全屏·长边 400', options: { max: 400 } },
  { name: '裁切区域·原分辨率', options: { crop: true } },
  { name: '裁切区域·长边 600', options: { crop: true, max: 600 } },
  { name: '裁切区域·长边 400', options: { crop: true, max: 400 } },
]

let SERIAL = ''
let N = 3

/** 取数列统计。 @param {number[]} values - 毫秒。 @returns {{n: number, min: number, p50: number, p90: number, max: number, mean: number}} 统计。 */
function stats(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  const n = sorted.length
  if (n === 0) return { n: 0, min: 0, p50: 0, p90: 0, max: 0, mean: 0 }
  const pick = (p) => sorted[Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1))]
  const sum = sorted.reduce((acc, v) => acc + v, 0)
  return {
    n,
    min: Math.round(sorted[0]),
    p50: Math.round(pick(50)),
    p90: Math.round(pick(90)),
    max: Math.round(sorted[n - 1]),
    mean: Math.round(sum / n),
  }
}

/**
 * 把 OCR 结果拆成词集合，用来算召回率。
 * @param {Array<{text: string}>} blocks - 识别块。
 * @returns {Set<string>} 词集合。
 */
function tokens(blocks) {
  const out = new Set()
  for (const block of blocks) {
    for (const piece of String(block.text ?? '').split(/[^\p{L}\p{N}]+/u)) {
      if (piece.length >= 2) out.add(piece.toLowerCase())
    }
  }
  return out
}

/**
 * 拉一张整屏截图到临时目录（原分辨率，不缩放）。
 * @returns {Promise<{path: string, ms: number, bytes: number}>} 文件与耗时。
 */
async function captureFull() {
  const started = Date.now()
  const out = join(DIR, `full-${Date.now()}.jpg`)
  const { stdout } = await run(ADB, ['-s', SERIAL, 'exec-out', 'screencap', '-j'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 30_000 })
  await writeFile(out, stdout)
  return { path: out, ms: Date.now() - started, bytes: stdout.length }
}

let DIR = ''

/**
 * 打开「关于平板」页：字多、静止、只读。
 * @returns {Promise<void>}
 */
async function openAboutPage() {
  await __internals.shellOnce(SERIAL, 'am force-stop com.android.settings; am start -a android.settings.DEVICE_INFO_SETTINGS -f 0x10000000').catch(() => null)
  await new Promise((resolve) => setTimeout(resolve, 1600))
}

/**
 * 主流程。
 * @returns {Promise<void>}
 */
async function main() {
  DIR = await mkdtemp(join(tmpdir(), 'dsh-ocr-bench-'))
  SERIAL = await __internals.resolveSerial({}).catch(() => '')
  if (!SERIAL) throw new Error('没找到设备')
  N = Math.min(10, Math.max(1, Number(arg('n', '3')) || 3))
  console.log(`设备 ${SERIAL} · 每档 ${N} 次 · 临时目录 ${DIR}`)

  const probe = await __internals.foregroundActivity(SERIAL).catch(() => '')
  if (/com\.whale\.pet/.test(String(probe))) {
    throw new Error('前台是别人的会话应用，先回桌面再测')
  }
  await __internals.shellOnce(SERIAL, 'input keyevent KEYCODE_HOME').catch(() => null)
  await new Promise((resolve) => setTimeout(resolve, 500))
  await openAboutPage()

  /* 先量一次截图，拿到真实分辨率，据此定裁切区域（上面 45%：标题 + 设备卡片 + 参数表）。 */
  const first = await captureFull()
  const refShot = await ocrImage(first.path, {})
  const width = Math.round(refShot.srcWidth ?? refShot.width ?? 0)
  const height = Math.round(refShot.srcHeight ?? refShot.height ?? 0)
  if (!width || !height) throw new Error('截图尺寸读不出来')
  const crop = [0, Math.round(height * 0.12), width, Math.round(height * 0.46)]
  console.log(`分辨率 ${width}x${height} · 裁切区域 ${crop.join(',')} · 参照块 ${refShot.blocks.length}`)

  const refTokens = tokens(refShot.blocks)
  /** @type {Array<{name: string, captureMs: number, ocrMs: number, blocks: number, recall: number, note: string}>} */
  const rows = []

  for (const mode of MODES) {
    const captureMs = []
    const ocrMs = []
    const blocks = []
    const recalls = []
    for (let i = 0; i < N; i += 1) {
      const shot = await captureFull()
      captureMs.push(shot.ms)
      const options = { ...mode.options }
      if (options.crop === true) options.crop = crop
      const started = Date.now()
      const result = await ocrImage(shot.path, options)
      ocrMs.push(Number(result.ms ?? Date.now() - started))
      blocks.push(result.blocks.length)
      const got = tokens(result.blocks)
      let hit = 0
      for (const token of refTokens) if (got.has(token)) hit += 1
      recalls.push(refTokens.size === 0 ? 0 : hit / refTokens.size)
      await rm(shot.path, { force: true })
    }
    rows.push({
      name: mode.name,
      captureMs: stats(captureMs).p50,
      ocrMs: stats(ocrMs).p50,
      blocks: Math.round(blocks.reduce((a, b) => a + b, 0) / Math.max(1, blocks.length)),
      recall: Math.round((recalls.reduce((a, b) => a + b, 0) / Math.max(1, recalls.length)) * 1000) / 1000,
      note: '',
    })
  }

  /* 同帧复用：同一张图连识别两次，量第二次的「缓存/热进程」收益。 */
  {
    const shot = await captureFull()
    const firstMs = Number((await ocrImage(shot.path, {})).ms)
    const secondMs = Number((await ocrImage(shot.path, {})).ms)
    const thirdMs = Number((await ocrImage(shot.path, {})).ms)
    rows.push({ name: '同帧复用（第 2 次）', captureMs: 0, ocrMs: secondMs, blocks: refShot.blocks.length, recall: 1, note: `首 ${firstMs}ms → 二 ${secondMs}ms → 三 ${thirdMs}ms` })
    await rm(shot.path, { force: true })
  }

  /* 区域截图：设备端只传一块，量「省下来的截图开销」。 */
  {
    const shots = []
    const ocrs = []
    for (let i = 0; i < N; i += 1) {
      const started = Date.now()
      const path = join(DIR, `region-${Date.now()}-${i}.jpg`)
      const { stdout } = await run(ADB, ['-s', SERIAL, 'exec-out', 'screencap', '-j'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 30_000 })
          await writeFile(path, stdout)
      const capture = Date.now() - started
      const cropped = join(DIR, `region-crop-${Date.now()}-${i}.jpg`)
      await run(process.env.FFMPEG ?? 'ffmpeg', ['-y', '-loglevel', 'error', '-i', path, '-vf', `crop=${crop[2]}:${crop[3]}:${crop[0]}:${crop[1]}`, '-frames:v', '1', cropped], { timeout: 20_000 })
      shots.push(capture)
      const result = await ocrImage(cropped, { max: 600 })
      ocrs.push(Number(result.ms))
      await rm(path, { force: true })
      await rm(cropped, { force: true })
    }
    rows.push({ name: '区域截图+裁切后识别', captureMs: stats(shots).p50, ocrMs: stats(ocrs).p50, blocks: 0, recall: 0, note: '截图仍是整屏（screencap 没有区域参数），裁切在宿主侧做' })
  }

  console.log('')
  console.log('| 模式 | 截图 p50 | 识别 p50 | 块数 | 词召回 | 备注 |')
  console.log('| --- | --- | --- | --- | --- | --- |')
  for (const row of rows) {
    console.log(`| ${row.name} | ${row.captureMs} ms | ${row.ocrMs} ms | ${row.blocks} | ${(row.recall * 100).toFixed(1)}% | ${row.note} |`)
  }

  const summary = {
    device: SERIAL,
    at: new Date().toISOString(),
    n: N,
    width,
    height,
    crop,
    refBlocks: refShot.blocks.length,
    refTokens: refTokens.size,
    rows,
  }
  const out = join(tmpdir(), 'dsh-mobile-use-ocr.json')
  await writeFile(out, `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`RESULT ${JSON.stringify(summary)}`)
  console.log(`JSON ${out}`)

  await stopOcr().catch(() => null)
  if (!flag('keep')) {
    await __internals.shellOnce(SERIAL, 'input keyevent KEYCODE_HOME').catch(() => null)
  }
}

main()
  .catch((error) => {
    console.error(`失败：${error?.stack ?? error}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await stopOcr().catch(() => null)
    await __internals.killShell(SERIAL).catch(() => null)
    await rm(DIR, { recursive: true, force: true }).catch(() => null)
  })
