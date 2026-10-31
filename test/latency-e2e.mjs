/**
 * 端到端交互延迟：注入一次输入 → 在镜像视频流里第一次看见画面变化。
 *
 * 两段口径：
 *   inject   注入耗时：从发出注入调用到 adb 返回（常驻 shell 通道，同 adb_tap 的走法）
 *   visible  首帧可见：注入开始 → 第一帧「像素确实变了」的 JPEG 到达
 *   after    注入返回 → 首帧可见（= visible - inject，插件自己那层之外的部分）
 *
 * 为什么用镜像视频流取帧：`adb exec-out screencap` 一次 600ms 以上，用它轮询量出来的
 * 是采样间隔而不是延迟；镜像那条 screenrecord → ffmpeg → JPEG 只有 ~15fps（快时段
 * 66ms 一帧），分辨率够判定「变没变」，也能代表人在侧栏里看到画面的时间。
 *
 * 变化判定不能只看「有没有新帧」：静止画面 screenrecord 也会 1fps 补帧。所以每帧
 * 都解码成 90x160 灰度图，和注入前的基线帧比平均绝对差，超过阈值才算变了。
 *
 * 刺激源只做可逆操作，且不碰前台正在被别的会话使用的应用：
 *   shade    桌面上下划出/收起通知栏（纯触摸注入，不留状态）
 *   settings 系统设置主页面 → 点一个分类进子页 → 返回（页面切换，不改开关）
 * 跑完统一 `cmd statusbar collapse` + 回桌面。
 *
 * 用法：
 *   node test/latency-e2e.mjs [--n 20] [--stim all|shade|settings] [--threshold 12] [--serial 15ca9736]
 * 输出：逐样本表 + p50/p90/p99/min/max，末尾一行 `RESULT {...}` 给脚本消费。
 */
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __internals } from '../index.js'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const flag = (name) => argv.includes(`--${name}`)
const N = Math.max(2, Math.min(60, Number(arg('n', 20)) || 20))
const STIM = String(arg('stim', 'all'))
const THRESHOLD = Math.max(1, Number(arg('threshold', 12)) || 12)
const SERIAL_ARG = String(arg('serial', process.env.ADB_SERIAL ?? '')).trim()
/* 灰度缩略图尺寸：判定「变没变」够用，解码一次 ~10ms。 */
const GW = 90
const GH = 160

const { resolveSerial, shellOnce, dumpState, foregroundActivity } = __internals

/** 最近的一帧（带序号和到达时间）。 @typedef {{seq: number, at: number, bytes: number}} Mark */

/* 采集桥的编码参数与 stream.js 的 JPEG 支路一致：720x1280 录屏 → H.264 → ffmpeg mjpeg。
   自带一条而不是复用 LiveStream：那份文件正在被别人重构（2026-10-29 现场 scheduleIdleStop 抛
   TypeError、且录制子进程不出字节），测量不能被它的状态牵着走。 */
const REC_LIMIT = 180
const MAX_QUEUE = 1024 * 1024

/**
 * 自带采集桥：`adb exec-out screenrecord` 的裸 H.264 直接喂 ffmpeg，拆出 JPEG 帧并记到达时刻。
 * 对外的接口故意做成 LiveStream 的子集（jpegSeq / jpeg / frames / markAfter / info），
 * 这样判定逻辑与被测实现解耦，换回 LiveStream 也不改测量代码。
 */
class JpegBridge {
  /** @param {{serial: string, adb: string}} options - 设备与 adb 路径。 */
  constructor({ serial, adb }) {
    this.serial = serial
    this.adb = adb
    this.jpegSeq = 0
    /** @type {Buffer|null} */
    this.jpeg = null
    this.jpegAt = 0
    /** @type {Mark[]} */
    this.marks = []
    /** @type {Map<number, Buffer>} */
    this.frames = new Map()
    /** 每帧到达时刻（performance.now），用来判断一帧是否「动作之后才到」。 */
    this.frameAt = new Map()
    this.pending = Buffer.alloc(0)
    this.framesSeen = 0
    this.bytes = 0
    this.error = ''
    /** @type {import('node:child_process').ChildProcess|null} */
    this.rec = null
    /** @type {import('node:child_process').ChildProcess|null} */
    this.ff = null
    this.stopped = false
    this.pidFile = `/data/local/tmp/dsh-latency-${serial.replace(/[^\w.-]/g, '_')}.pid`
  }

  /** 起录屏和解码器。 @returns {void} */
  start() {
    if (this.rec !== null) return
    const size = '720x1280'
    const command = `sh -c 'echo $$ > ${this.pidFile}; exec screenrecord --output-format=h264 --time-limit=${REC_LIMIT} --size=${size} --bit-rate=4000000 -'`
    const rec = spawn(this.adb, ['-s', this.serial, 'exec-out', command], { stdio: ['ignore', 'pipe', 'pipe'] })
    this.rec = rec
    let recErr = ''
    rec.stderr.setEncoding('utf8')
    rec.stderr.on('data', (chunk) => { recErr = (recErr + chunk).slice(-600) })
    rec.on('error', (error) => { this.error = `录屏起不来：${error?.message ?? error}` })
    rec.on('exit', (code) => {
      if (this.rec === rec) this.rec = null
      if (!this.stopped && code !== 0) this.error = `录屏退出 ${String(code)} ${recErr}`.trim()
    })

    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-flags', 'low_delay',
      '-f', 'h264', '-i', 'pipe:0',
      '-vf', 'fps=15,scale=-2:960',
      '-flush_packets', '1',
      '-fps_mode', 'passthrough',
      '-f', 'mjpeg', '-q:v', '7',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.ff = ff
    let ffErr = ''
    ff.stderr.setEncoding('utf8')
    ff.stderr.on('data', (chunk) => { ffErr = (ffErr + chunk).slice(-400) })
    ff.on('error', (error) => { this.error = `ffmpeg 起不来：${error?.message ?? error}` })
    ff.on('exit', (code) => {
      if (this.ff === ff) this.ff = null
      if (!this.stopped && code !== 0) this.error = `ffmpeg 退出 ${String(code)} ${ffErr}`.trim()
    })
    rec.stdout.on('data', (chunk) => {
      this.bytes += chunk.length
      const stdin = ff.stdin
      if (stdin === null || stdin.destroyed) return
      if (stdin.writableLength > MAX_QUEUE) return
      try {
        stdin.write(chunk)
      } catch {
        this.error = 'ffmpeg stdin 写失败'
      }
    })
    ff.stdout.on('data', (chunk) => this.#feed(chunk))
    rec.stdout.on('end', () => { try { ff.stdin.end() } catch { /* 已关 */ } })
  }

  /** 拆 MJPEG：按 SOI/EOI 切帧，切出完整一帧就记时间戳。 @param {Buffer} chunk - 字节。 @returns {void} */
  #feed(chunk) {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    for (;;) {
      const start = this.pending.indexOf(Buffer.from([0xff, 0xd8]))
      if (start < 0) { this.pending = Buffer.alloc(0); return }
      const end = this.pending.indexOf(Buffer.from([0xff, 0xd9]), start + 2)
      if (end < 0) { this.pending = this.pending.subarray(start); return }
      const jpeg = this.pending.subarray(start, end + 2)
      this.pending = this.pending.subarray(end + 2)
      this.jpegSeq += 1
      this.framesSeen += 1
      this.jpeg = Buffer.from(jpeg)
      this.jpegAt = Date.now()
      this.marks.push({ seq: this.jpegSeq, at: performance.now(), bytes: this.jpeg.length })
      if (this.marks.length > 120) this.marks.splice(0, this.marks.length - 120)
      this.frames.set(this.jpegSeq, this.jpeg)
      this.frameAt.set(this.jpegSeq, performance.now())
      if (this.frames.size > 24) {
        const oldest = this.frames.keys().next().value
        this.frames.delete(oldest)
        this.frameAt.delete(oldest)
      }
    }
  }

  /** 采集桥自带录屏，不需要单独打开。 @returns {boolean} 恒为 true。 */
  enableJpeg() {
    return true
  }

  /** 诊断信息。 @returns {{jpegFrames: number, bytes: number, marks: number}} 计数。 */
  info() {
    return { jpegFrames: this.framesSeen, bytes: this.bytes, marks: this.marks.length }
  }

  /** 停采集：先杀本机子进程，再按 pid 文件清掉设备端录屏（幂等）。 @returns {void} */
  stop() {
    this.stopped = true
    const kill = (child) => {
      if (child === null) return
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经退了 */
      }
    }
    kill(this.ff)
    kill(this.rec)
    this.ff = null
    this.rec = null
    try {
      execFile(this.adb, ['-s', this.serial, 'shell', `sh -c 'kill -9 $(cat ${this.pidFile}) 2>/dev/null; rm -f ${this.pidFile}'`], { timeout: 5000 }, () => {})
    } catch {
      /* adb 走了就算了 */
    }
  }

  /**
   * 等序号大于 since 的一帧。
   * @param {number} since - 基准序号。
   * @param {number} timeoutMs - 上限。
   * @returns {Promise<Mark|null>} 到达的那帧。
   */
  markAfter(since, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    return new Promise((resolve) => {
      const look = () => {
        const hit = this.marks.find((mark) => mark.seq > since)
        if (hit !== undefined) return resolve(hit)
        return null
      }
      const found = look()
      if (found !== undefined && found !== null) return resolve(found)
      const timer = setInterval(() => {
        this.jpegWantedAt = Date.now()
        const hit = look()
        if (hit !== undefined && hit !== null) {
          clearInterval(timer)
          resolve(hit)
          return
        }
        if (Date.now() > deadline) {
          clearInterval(timer)
          resolve(null)
        }
      }, 8)
    })
  }
}

/* ---------------- ffmpeg 解码：JPEG → 灰度缩略图，用来算像素差 ---------------- */

/* 临时目录在 main 里建：模块顶层不能裸 await（插件约定，脚本也照办）。 */
let dir = ''
let decodeSeq = 0

/**
 * 把一帧 JPEG 解码成 GW*GH 的灰度字节。
 * @param {Buffer} jpeg - 帧字节。
 * @returns {Promise<Buffer|null>} 灰度数据。
 */
async function gray(jpeg) {
  decodeSeq += 1
  const file = join(dir, `f${decodeSeq}.jpg`)
  await writeFile(file, jpeg)
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2', '-i', file,
      '-vf', `scale=${GW}:${GH}`, '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] })
    const parts = []
    let size = 0
    child.stdout.on('data', (chunk) => {
      parts.push(chunk)
      size += chunk.length
      if (size > GW * GH * 4) child.kill('SIGKILL')
    })
    child.on('error', () => resolve(null))
    child.on('exit', () => {
      const raw = Buffer.concat(parts)
      resolve(raw.length >= GW * GH ? raw.subarray(0, GW * GH) : null)
    })
  })
}

/**
 * 两帧灰度图的平均绝对差。
 * @param {Buffer} a - 基线。
 * @param {Buffer} b - 新帧。
 * @returns {number} 0–255。
 */
function diff(a, b) {
  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i])
  return sum / a.length
}

/* ---------------- 设备动作 ---------------- */

/**
 * 在常驻 shell 里注入一条输入命令。
 * @param {string} cmd - 例如 `input swipe 540 4 540 2200 220`。
 * @returns {Promise<{ms: number, ok: boolean}>} 注入耗时。
 */
async function inject(cmd) {
  const began = performance.now()
  const res = await shellOnce(SERIAL, cmd, 8000)
  return { ms: Math.round(performance.now() - began), ok: res.ok === true, shellMs: res.ms }
}

/**
 * 等采集桥真正出流。
 * raw H.264 从管道进来时 ffmpeg 要先攒够 analyzeduration（默认 5s 时长）才吐出第一帧：
 * 静止画面只有 1 个 IDR，实测 19s 一个 JPEG 都不出；持续动画面 7s 左右才开始出帧。
 * 所以这里主动制造持续画面（上下拉通知栏，起手状态可恢复），出帧即止，冷的几秒不算进样本。
 * @param {JpegBridge} stream - 采集桥。
 * @param {string} serial - 设备序列号。
 * @returns {Promise<boolean>} 是否出流。
 */
async function warmUp(stream, serial) {
  const t0 = performance.now()
  let cursor = stream.jpegSeq
  let flip = 0
  while (performance.now() - t0 < 14_000) {
    flip += 1
    const cmd = flip % 2 === 1 ? 'input swipe 1068 20 1068 1400 120' : 'input swipe 1068 1400 1068 20 120'
    await shellOnce(serial, cmd, 5000).catch(() => {})
    const mark = await stream.markAfter(cursor, 400)
    if (mark !== null) {
      cursor = mark.seq
      /* 一帧不代表 ffmpeg 已经越过 analyzeduration；攒到 ~120 帧（≈5s 时长）才算稳。 */
      if (stream.framesSeen > 120) {
        await shellOnce(serial, 'cmd statusbar collapse', 4000).catch(() => {})
        await new Promise((resolve) => setTimeout(resolve, 250))
        return true
      }
    }
  }
  await shellOnce(serial, 'cmd statusbar collapse', 4000).catch(() => {})
  return false
}

/**
 * 等画面静止：连续 quietMs 没有新帧。
 * @param {JpegBridge} stream - 流。
 * @param {number} quietMs - 静止判定。
 * @param {number} capMs - 最多等多久。
 * @returns {Promise<void>}
 */
async function settle(stream, quietMs = 300, capMs = 3000) {
  const deadline = Date.now() + capMs
  let lastSeq = stream.jpegSeq
  let lastChange = Date.now()
  while (Date.now() < deadline) {
    stream.jpegWantedAt = Date.now()
    await new Promise((resolve) => setTimeout(resolve, 40))
    if (stream.jpegSeq !== lastSeq) {
      lastSeq = stream.jpegSeq
      lastChange = Date.now()
    } else if (Date.now() - lastChange >= quietMs) return
  }
}

/**
 * 打开设置主页面（静态列表，没有动态壁纸和时钟动画），当测量基准页。
 * 只在页面上停着看，不改任何开关；结束由全局复位负责回桌面。
 * @returns {Promise<boolean>} 是否已到设置页。
 */
async function openSettings() {
  await shellOnce(SERIAL, 'cmd statusbar collapse', 5000).catch(() => {})
  const INFO = 'am start -a android.settings.DEVICE_INFO_SETTINGS -f 0x10000000'
  /* 设置主页面在这台机器上起不来：am start SETTINGS 不管 force-stop 与否都落到 WLAN 子页
     （任务根就是它，BACK 直接把设置退掉）。改用「我的设备/关于手机」这一页当基准：
     只读、静态、点任何一行都只是往下推一层页面，BACK 一定回得来。 */
  const fg0 = String((await foregroundActivity(SERIAL).catch(() => '')) ?? '')
  if (!/MyDeviceInfo/i.test(fg0)) {
    await shellOnce(SERIAL, 'am force-stop com.android.settings', 8000).catch(() => {})
    await shellOnce(SERIAL, INFO, 10_000).catch(() => {})
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      const fg = String((await foregroundActivity(SERIAL).catch(() => '')) ?? '')
      if (/MyDeviceInfo/i.test(fg)) return true
    }
    return false
  }
  /* 停在点进去的子页：BACK 一层就回到基准页。 */
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fg = String((await foregroundActivity(SERIAL).catch(() => '')) ?? '')
    if (/MyDeviceInfo/i.test(fg)) return true
    await shellOnce(SERIAL, 'input keyevent KEYCODE_BACK', 5000).catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  const fg = String((await foregroundActivity(SERIAL).catch(() => '')) ?? '')
  return /MyDeviceInfo/i.test(fg)
}

/** 关于手机页里只读、点进去只换页的行（不碰开关、不碰联网）。 */
const SETTINGS_ROW = /全部参数|All specs|版本|版本号|型号|Model|Android|内核|Kernel|基带|Baseband|处理器|CPU|运行内存|RAM|存储|Storage/

/**
 * 回到设置主页面，读一次树拿分类行坐标。
 * @returns {Promise<{x: number, y: number, text: string}|null>} 落点。
 */
async function settingsTarget() {
  if (!await openSettings()) return null
  const state = await dumpState(SERIAL, { ocr: 'off' })
  const rows = (state.nodes ?? []).filter((node) => {
    /* 可点的是外面那层无文字的 ViewGroup，所以按「文字节点」挑，点它的中心一样落在行上。 */
    const text = String(node.text ?? '')
    if (text === '' || !SETTINGS_ROW.test(text)) return false
    const y1 = Number(node.y1)
    const w = Number(node.x2) - Number(node.x1)
    /* 跳过标题栏/搜索框/角标：那些点下去什么都不换。 */
    return y1 > 400 && w > 120
  })
  if (rows.length === 0) return null
  /* 固定挑同一行（全部参数与信息）：同一个页面切换动作，样本之间可比。 */
  const prefers = (text) => (/全部参数|All specs/.test(String(text)) ? 0 : 1)
  rows.sort((a, b) => prefers(a.text) - prefers(b.text) || a.y1 - b.y1)
  const node = rows[0]
  return {
    x: Math.round((node.x1 + node.x2) / 2),
    y: Math.round((node.y1 + node.y2) / 2),
    text: String(node.text ?? '').slice(0, 12),
  }
}

/** 每种刺激源：prepare（把界面摆到起点）/ inject（被测动作）/ restore（复位）。 */
const STIMULI = {
  /**
   * 通知栏：从顶部下拉 → 收起。纯触摸注入，桌面不受影响。
   */
  shade: {
    async prepare() {
      /* 桌面上有动态壁纸+时钟，静止也在变（实测 25fps、像素差 53/255），
         拿它当基准等于在噪声里找信号；统一在静态的设置页上做。 */
      if (!await openSettings()) return null
      return { note: '设置页 → 下拉通知栏' }
    },
    async inject() {
      return inject('input swipe 540 4 540 2200 220')
    },
    async restore() {
      await shellOnce(SERIAL, 'cmd statusbar collapse', 5000)
    },
  },
  /**
   * 设置页：主页面 → 点分类进子页 → BACK 回主页面。
   */
  settings: {
    async prepare() {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const target = await settingsTarget()
        if (target !== null) return target
      }
      return null
    },
    async inject(target) {
      return inject(`input tap ${target.x} ${target.y}`)
    },
    async restore() {
      /* 点进去的子页层数不定，一路 BACK 到主页面为止。 */
      await openSettings()
      await new Promise((resolve) => setTimeout(resolve, 300))
    },
  },
}

/* ---------------- 统计 ---------------- */

/**
 * 最近秩百分位。
 * @param {number[]} values - 已排序副本。
 * @param {number} p - 0–100。
 * @returns {number} 毫秒。
 */
function pct(values, p) {
  if (values.length === 0) return 0
  const rank = Math.ceil((p / 100) * values.length) - 1
  return values[Math.min(values.length - 1, Math.max(0, rank))]
}

/**
 * 一组毫秒数的分布。
 * @param {number[]} values - 毫秒。
 * @returns {{n: number, min: number, p50: number, p90: number, p99: number, max: number, mean: number}} 分布。
 */
function stats(values) {
  if (values.length === 0) return { n: 0, min: 0, p50: 0, p90: 0, p99: 0, max: 0, mean: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const mean = Math.round(values.reduce((a, b) => a + b, 0) / values.length)
  return {
    n: sorted.length,
    min: sorted[0],
    p50: pct(sorted, 50),
    p90: pct(sorted, 90),
    p99: pct(sorted, 99),
    max: sorted[sorted.length - 1],
    mean,
  }
}

/* ---------------- 主流程 ---------------- */

let SERIAL = ''

/**
 * 跑一组样本。
 * @param {JpegBridge} stream - 视频流。
 * @param {string} name - 刺激源名。
 * @returns {Promise<Array<{stim: string, injectMs: number, visibleMs: number, afterMs: number, skipped: number, diff: number, ok: boolean}>>} 样本。
 */
async function runStimulus(stream, name) {
  const stim = STIMULI[name]
  const rows = []
  for (let index = 0; index < N; index += 1) {
    const start = await stim.prepare()
    if (start === null) {
      console.error(`[${name}] prepare 失败：找不到可点的分类行，跳过这组`)
      break
    }
    await settle(stream)
    stream.jpegWantedAt = Date.now()
    /* 基线帧：注入前最后一帧。 */
    const beforeSeq = stream.jpegSeq
    const baselineJpeg = stream.frames.get(beforeSeq) ?? stream.jpeg
    if (baselineJpeg === null) {
      console.error(`[${name}] 没拿到基线帧，跳过`)
      continue
    }
    const baseline = await gray(baselineJpeg)
    if (baseline === null) continue
    const fgPrep = String((await foregroundActivity(SERIAL).catch(() => '?')) ?? '?')
    /* 噪声探针：静止时 250ms 内进来的帧，拿它们的最大像素差当「不算变化」的下限参考。 */
    const noiseMark = await stream.markAfter(beforeSeq, 250)
    const baseSeq = noiseMark === null ? beforeSeq : noiseMark.seq
    const t0 = performance.now()
    const injected = await stim.inject(start)
    const t1 = performance.now()
    const fgInj = String((await foregroundActivity(SERIAL).catch(() => '?')) ?? '?')
    let seen = null
    let skipped = 0
    let observed = 0
    /** @type {number[]} */
    const diffs = []
    let changeSeq = baseSeq
    const deadline = performance.now() + 3000
    while (performance.now() < deadline) {
      stream.jpegWantedAt = Date.now()
      const mark = await stream.markAfter(changeSeq, 1200)
      if (mark === null) continue
      changeSeq = mark.seq
      const jpeg = stream.frames.get(mark.seq)
      if (jpeg === undefined) continue
      /* 只认「动作开始之后才到」的帧：任务切换时 screenrecord 会卡住一两秒，
         卡住期间读到的是动作之前就编好的旧帧，拿它判可见会把延迟量成 0。 */
      const arrivedAt = stream.frameAt.get(mark.seq) ?? mark.at
      if (arrivedAt < t0) continue
      const frame = await gray(jpeg)
      if (frame === null) continue
      const score = diff(baseline, frame)
      observed += 1
      diffs.push(score)
      if (score >= THRESHOLD) {
        seen = { mark: { seq: mark.seq, at: arrivedAt }, score }
        break
      }
      skipped += 1
      if (observed >= 80) break
    }
    if (seen === null) {
      /* 没测到变化时把现场打出来：点了哪、落到哪个页面、各帧差多少。 */
      const fg = await foregroundActivity(SERIAL).catch(() => '?')
      const detail = diffs.slice(0, 6).map((d) => d.toFixed(1)).join('/')
      console.log(`  #${index + 1} 未检测到变化（跳过帧 ${skipped}，落点 ${JSON.stringify(start)}，注入前前台 ${fgPrep}，注入后前台 ${fgInj}，现在 ${fg}，帧差 ${detail || '无帧'}）`)
    }
    await stim.restore()
    if (seen === null) {
      rows.push({ stim: name, injectMs: injected.ms, visibleMs: -1, afterMs: -1, skipped, diff: 0, ok: false })
      continue
    }
    const row = {
      stim: name,
      injectMs: injected.ms,
      visibleMs: Math.round(seen.mark.at - t0),
      afterMs: Math.round(seen.mark.at - t1),
      skipped,
      diff: Math.round(seen.score * 10) / 10,
      ok: true,
    }
    rows.push(row)
    console.log(`  #${String(index + 1).padStart(2)} ${name.padEnd(8)} 注入 ${String(row.injectMs).padStart(4)}ms  首帧可见 ${String(row.visibleMs).padStart(4)}ms  (注入后 ${String(row.afterMs).padStart(3)}ms)  跳过 ${skipped} 帧  变化 ${row.diff}`)
  }
  return rows
}

/**
 * 主流程。
 * @returns {Promise<void>}
 */
async function main() {
  dir = await mkdtemp(join(tmpdir(), 'dsh-lat-'))
  const picked = await resolveSerial({ serial: SERIAL_ARG }).catch((error) => {
    throw new Error(`选设备失败：${error?.message ?? error}`)
  })
  SERIAL = String(picked ?? '').trim()
  if (SERIAL === '') throw new Error('没选中设备：用 --serial 指定，或确认 adb devices 里有一台 device。')
  if (!flag('keep')) {
    const fg = await foregroundActivity(SERIAL).catch(() => '')
    if (/com\.whale\.pet/.test(String(fg))) {
      console.log(`前台是 com.whale.pet（别的会话在用），先回桌面再测`)
      await shellOnce(SERIAL, 'input keyevent KEYCODE_HOME', 5000)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  const names = STIM === 'all' ? ['shade', 'settings'] : [STIM]
  for (const name of names) {
    if (STIMULI[name] === undefined) throw new Error(`未知刺激源：${name}（可用 shade / settings / all）`)
  }

  /* 开流：screenrecord → ffmpeg → JPEG。等第一帧真正到手再开始测，冷启动的 2–4s 不算进样本。 */
  const stream = new JpegBridge({
    serial: SERIAL,
    adb: arg('adb', process.env.ADB_PATH ?? 'adb'),
  })
  const exit = () => {
    try {
      stream.stop()
    } catch {
      /* 已经停了 */
    }
  }
  process.once('SIGINT', exit)
  process.once('SIGTERM', exit)
  try {
    console.log(`设备 ${SERIAL} · 刺激源 ${names.join('+')} · 每源 ${N} 次 · 判定阈值 ${THRESHOLD}/255`)
    stream.start()
    stream.enableJpeg()
    const live = await warmUp(stream, SERIAL)
    if (!live) throw new Error(`视频流起不来：14s 持续动画面仍无 JPEG（rec=${stream.bytes}B ${stream.error || '无错' }）`)
    /* 刚起流时会有几帧初始化抖动，先静一下。 */
    await new Promise((resolve) => setTimeout(resolve, 600))
    await settle(stream, 400, 4000)

    /* 静止噪声：静止观测 2s，看随机会有多少帧进来、像素差多大。 */
    if (!await openSettings()) throw new Error('打不开设置页：没法建立静态基准')
    await settle(stream, 600, 5000)
    let idleFrames = 0
    let idleMaxDiff = 0
    {
      const baseSeq = stream.jpegSeq
      const baselineJpeg = stream.frames.get(baseSeq) ?? stream.jpeg
      const baseline = baselineJpeg === null ? null : await gray(baselineJpeg)
      if (baseline !== null) {
        let cursor = baseSeq
        const until = performance.now() + 2000
        while (performance.now() < until) {
          const mark = await stream.markAfter(cursor, 500)
          if (mark === null) break
          cursor = mark.seq
          idleFrames += 1
          const jpeg = stream.frames.get(mark.seq)
          if (jpeg === undefined) continue
          const frame = await gray(jpeg)
          if (frame !== null) idleMaxDiff = Math.max(idleMaxDiff, Math.round(diff(baseline, frame) * 10) / 10)
        }
      }
    }
    console.log(`静止 2s：${idleFrames} 帧，最大像素差 ${idleMaxDiff}/255（阈值 ${THRESHOLD}）`)

    const all = []
    for (const name of names) {
      console.log(`\n== ${name} ==`)
      all.push(...await runStimulus(stream, name))
    }

    /* 复位：收通知栏、回桌面。 */
    await shellOnce(SERIAL, 'cmd statusbar collapse', 5000).catch(() => {})
    await shellOnce(SERIAL, 'input keyevent KEYCODE_HOME', 5000).catch(() => {})
    const fg = await foregroundActivity(SERIAL).catch(() => '')

    const ok = all.filter((row) => row.ok)
    const collect = (key) => stats(ok.map((row) => row[key]))
    const summary = {
      device: SERIAL,
      at: new Date().toISOString(),
      fps: Math.round(stream.info().jpegFrames ?? 0),
      threshold: THRESHOLD,
      samples: all.length,
      detected: ok.length,
      injection: collect('injectMs'),
      visible: collect('visibleMs'),
      afterInjectionReturn: collect('afterMs'),
      skippedFrames: stats(ok.map((row) => row.skipped)),
      idle: { framesIn2s: idleFrames, maxDiff: idleMaxDiff },
      byStim: Object.fromEntries(names.map((name) => {
        const rows = ok.filter((row) => row.stim === name)
        return [name, { n: rows.length, inject: stats(rows.map((row) => row.injectMs)), visible: stats(rows.map((row) => row.visibleMs)), after: stats(rows.map((row) => row.afterMs)) }]
      })),
      foregroundAfter: fg,
    }
    console.log('\n== 汇总（毫秒）==')
    for (const [label, value] of [['注入耗时', summary.injection], ['首帧可见(注入开始算)', summary.visible], ['首帧可见(注入返回算)', summary.afterInjectionReturn]]) {
      console.log(`${label.padEnd(22)} n=${value.n} min=${value.min} p50=${value.p50} p90=${value.p90} p99=${value.p99} max=${value.max} mean=${value.mean}`)
    }
    for (const name of names) {
      const group = summary.byStim[name]
      console.log(`  ${name}: n=${group.n} 可见 p50=${group.visible.p50} p90=${group.visible.p90} 注入 p50=${group.inject.p50}`)
    }
    console.log(`测完前台：${fg || '(读不到)'}`)
    console.log(`RESULT ${JSON.stringify(summary)}`)
    await writeFile(join(tmpdir(), 'dsh-mobile-use-latency.json'), `${JSON.stringify(summary, null, 2)}\n`)
  } finally {
    exit()
    await new Promise((resolve) => setTimeout(resolve, 300))
    /* 常驻 shell 通道的 adb 子进程会让事件循环一直活着：不主动 kill 就永远退不出去。 */
    try {
      __internals.killShell(SERIAL)
    } catch {
      /* 通道本来就没起 */
    }
  }
}

main().catch((error) => {
  console.error(`失败：${error?.stack ?? error}`)
  process.exitCode = 1
})
