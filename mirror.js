/**
 * dsh-mobile-use · 实时镜像：把设备画面低帧率镜像到右侧栏，人手能直接点，
 * 也能画个圈把「这段」连同坐标推回聊天。
 *
 * 数据通路（全部在本机，不经过任何外部服务）：
 *   截图续帧：3 张 exec-out screencap -p 并发 → 一条常驻 ffmpeg 转 JPEG
 *     └─ MJPEG → 侧栏 <img> 直播（实测 4–6 帧/秒，转码 16ms/帧）
 *   分段录制：设备上 10s 一段 mp4 → 拉回本机，只留最近 18 段（约 3 分钟）
 *
 * 屏幕静止时 MIUI 的 screenrecord 几乎不出帧（实测 8s 只出 1 帧），所以直播
 * 由截图续帧，录制走分段文件；要看逐像素外观仍然走 adb_shot。
 * 没人看的时候一张都不抓，侧栏关掉就完全不动。
 *
 * @module dsh-mobile-use/mirror
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import { LiveStream, packFrame } from './stream.js?v=204'
import { KEY_ACTION, ScrcpyChannel, TOUCH_ACTION } from './scrcpy.js?v=9'
import { PLAYER_HTML } from './page.js?v=28'

/** 客户端与宿主共用的路由前缀。 */
export const ROUTE = '/dsh-mobile-use'

/**
 * 低延迟注入入口：setupMirror 里装上实现；没装/没就绪时每个方法都回 null，调用方退回 adb。
 * 返回 null 是「这条路不通」，不是失败，所以调用方必须自己兜底。
 */
export const fastInput = {
  /** @type {null | ((serial: string, x: number, y: number, options?: any) => Promise<any>)} */
  tap: null,
  /** @type {null | ((serial: string, x1: number, y1: number, x2: number, y2: number, ms: number) => Promise<any>)} */
  swipe: null,
  /** @type {null | ((serial: string, tracks: number[][][], ms: number) => Promise<any>)} */
  gesture: null,
  /** @type {null | ((serial: string, keycode: number, options?: any) => Promise<any>)} */
  key: null,
  /** @type {null | ((serial: string) => any)} */
  raw: null,
}

/**
 * 节拍器回调兜底：异常冒到 host 顶层会直接把整个 DSH 带走（2026-10-27 事故），
 * 所以单拍出错只记一行，不停服务、不退进程。
 * @param {string} where - 出问题的路径。
 * @param {() => void} run - 这一拍要做的事。
 * @returns {void}
 */
function guard(where, run) {
  try {
    run()
  } catch (error) {
    console.error(`[dsh-mobile-use] ${where}:`, error)
  }
}

/** 最近一次标注里动效拼图的字节数，0 表示没凑够帧。 */
let lastStripBytes = 0

const diag = []
const clients = new Map()

let wantSession = ''
let wantAt = 0
let wantTitle = ''

/** 对外报的直播帧率：实测 4–5 帧/秒，够看清操作反馈。 */
const LIVE_FPS = 3
/** 往外送帧的节奏：并发截图是一股一股完成的，按固定节拍取最新一帧才顺。 */
const PUSH_TICK_MS = 200
/** 同时在飞的截图数：单张约 0.65s，3 张并发实测 4 帧/秒以上。 */
const CAPTURE_PARALLEL = 2
/** 没人看多久之后收掉分段录制：跟抓帧的空转宽限同一个数，别留两个口径。 */
const WATCH_GRACE_MS = 6000
/** 本进程的随机标识：设备端 pid 文件名带上它，多开/重启时不会互相覆盖。 */
const REC_TAG = Math.random().toString(36).slice(2, 8)

/** 环形缓冲：10 秒一段，留 18 段 ≈ 3 分钟，超出的由 ffmpeg 自己覆盖。 */
const SEGMENT_SECONDS = 10
const SEGMENT_KEEP = 18

/** 一次注入最多带的图：PNG 原图 base64 后可能很大，超过就不注入。 */
const MAX_INJECT_BYTES = 8 * 1024 * 1024

/** 找 ffmpeg：DSH 进程的 PATH 未必带 Homebrew。 */
function pickFfmpeg(name = 'ffmpeg') {
  const env = name === 'ffmpeg' ? process.env.FFMPEG : process.env.FFPROBE
  if (env) return env
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin']) {
    const candidate = `${dir}/${name}`
    if (existsSync(candidate)) return candidate
  }
  return name
}

/** 开发探针（/dev/mse、/sessions）只在明确打开时挂上，发布版不暴露。 */
const DEV = process.env.DSH_ADB_DEV === '1'

const FFMPEG = pickFfmpeg()
const FFPROBE = pickFfmpeg('ffprobe')

/** 问 ffprobe 一段 mp4 有多长。 @param {string} file - 本地路径。 @returns {Promise<number>} 秒；读不到时 0。 */
function probeDuration(file) {
  return new Promise((resolve) => {
    const child = spawn(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', () => resolve(0))
    child.on('close', () => resolve(Number(out.trim()) || 0))
  })
}

/** 抽某一时刻的一帧 JPEG（宽 300），拼图用。 @returns {Promise<Buffer | null>} */
function grabFrameAt(file, at) {
  return new Promise((resolve) => {
    const child = spawn(FFMPEG, ['-v', 'error', '-ss', at.toFixed(3), '-i', file, '-frames:v', '1',
      '-vf', 'scale=-2:300', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'])
    const chunks = []
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.on('error', () => resolve(null))
    child.on('close', () => resolve(chunks.length > 0 ? Buffer.concat(chunks) : null))
  })
}

/** 问视频画面的原始宽高（像素）。 @returns {Promise<{ w: number, h: number } | null>} */
function probeVideoSize(file) {
  return new Promise((resolve) => {
    const child = spawn(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file])
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', () => resolve(null))
    child.on('close', () => {
      const [w, h] = out.trim().split(',').map((each) => Number(each))
      resolve(Number(w) > 0 && Number(h) > 0 ? { w: Number(w), h: Number(h) } : null)
    })
  })
}

/**
 * 按固定帧率把一段录像的末尾抽成灰度帧：动效量化要比对像素，不看 JPEG。
 * @param {string} file - 本地 mp4。
 * @param {number} seconds - 取末尾多少秒。
 * @param {number} fps - 抽帧帧率。
 * @param {{ x: number, y: number, w: number, h: number } | null} region - 只看这一块（原始像素坐标）。
 * @returns {Promise<{ w: number, h: number, bytes: Buffer[] } | null>} 抽不到时 null。
 */
async function grayFrames(file, seconds, fps, region) {
  const size = await probeVideoSize(file)
  if (size === null) return null
  const width = Math.min(320, Math.max(120, Math.round(size.w / 4)))
  const scaled = Math.max(2, Math.round((width * size.h) / size.w / 2) * 2)
  const filters = []
  if (region !== null && region.w > 0 && region.h > 0) filters.push('crop=' + region.w + ':' + region.h + ':' + region.x + ':' + region.y)
  filters.push('fps=' + fps)
  filters.push('scale=' + width + ':' + scaled)
  const frames = await new Promise((resolve) => {
    const child = spawn(FFMPEG, ['-v', 'error', '-sseof', '-' + Math.max(1, seconds).toFixed(2), '-i', file,
      '-vf', filters.join(','), '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'])
    const chunks = []
    let total = 0
    child.stdout.on('data', (chunk) => {
      chunks.push(chunk)
      total += chunk.length
      if (total > 64 * 1024 * 1024) child.kill('SIGKILL')
    })
    child.on('error', () => resolve(null))
    child.on('close', () => resolve(chunks.length > 0 ? Buffer.concat(chunks) : null))
  })
  if (frames === null) return null
  const frameBytes = width * scaled
  if (frameBytes <= 0) return null
  const count = Math.floor(frames.length / frameBytes)
  if (count < 2) return null
  const picked = []
  for (let index = 0; index < count; index += 1) picked.push(frames.subarray(index * frameBytes, (index + 1) * frameBytes))
  return { w: width, h: scaled, bytes: picked }
}

/** 6 帧 JPEG 拼成 3×2 的 PNG。 @returns {Promise<Buffer | null>} */
function tileFrames(picks) {
  return new Promise((resolve) => {
    const child = spawn(FFMPEG, ['-v', 'error', '-f', 'image2pipe', '-framerate', '1', '-c:v', 'mjpeg', '-i', 'pipe:0',
      '-vf', 'scale=-2:300,tile=3x2:padding=6:color=0x222222', '-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'])
    const chunks = []
    let settled = false
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.on('error', () => { if (!settled) { settled = true; resolve(null) } })
    child.on('close', () => { if (!settled) { settled = true; resolve(chunks.length > 0 ? Buffer.concat(chunks) : null) } })
    for (const jpeg of picks.slice(0, 6)) child.stdin.write(jpeg)
    child.stdin.end()
  })
}

/** 环形缓冲落盘位置：本机私有目录，不随工作区进版本库。 */
const ROOT = join(homedir(), '.dsh', 'adb-mirror')

/**
 * 从 JPEG 头里读出宽高：SOFn 段里 高 2 字节 + 宽 2 字节。
 * @param {Buffer} jpeg - 一帧。
 * @returns {{ w: number, h: number } | null} 宽高，读不出时 null。
 */
/** 从 JPEG 头里读宽高，工具层复用侧栏帧时要用。 */
export function frameSize(jpeg) {
  let at = 2
  while (at + 9 < jpeg.length) {
    if (jpeg[at] !== 0xff) return null
    const marker = jpeg[at + 1]
    const length = jpeg.readUInt16BE(at + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: jpeg.readUInt16BE(at + 5), w: jpeg.readUInt16BE(at + 7) }
    }
    at += 2 + length
  }
  return null
}

/**
 * 一台设备的镜像：屏幕录制 + 转码 + 观看者。
 */
/** PNG 文件头。 */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** JPEG 文件头。 */
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff])

/** 设备端截图落点：同一台设备只留一份，覆盖写。 */
const LIVE_SHOT = '/data/local/tmp/.dsh-mobile-use-live.jpg'

/* 页面代码的版本号：写在 client.rev 里。页面拿 /state 的 build 和自己带的对一下，
   不一致就自己重载，省掉「改一次客户端就要人按一次刷新」。 */
const CLIENT_BUILD = (() => {
  try {
    return String(readFileSync(new URL('./client.rev', import.meta.url), 'utf8')).trim()
  } catch {
    return ''
  }
})()

/**
 * 一张 PNG 转成 JPEG：/live 走 MJPEG，帧只能是 JPEG。
 * @param {Buffer} png - PNG 数据。
 * @returns {Promise<Buffer | null>} JPEG，失败时 null。
 */
function pngToJpeg(png) {
  /* 输入可能是 PNG 也可能是设备端直出的 JPEG（`screencap -j`）：按头判断，别写死。 */
  const isJpeg = png.subarray(0, 3).equals(JPEG_SIG)
  return new Promise((resolve) => {
    const child = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', isJpeg ? 'mjpeg' : 'png_pipe', '-i', 'pipe:0',
      '-vf', 'scale=1024:-2:flags=fast_bilinear', '-q:v', '8', '-f', 'mjpeg', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'ignore'] })
    const chunks = []
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.on('error', () => resolve(null))
    child.on('close', () => {
      const out = Buffer.concat(chunks)
      resolve(out.length > 1000 ? out : null)
    })
    child.stdin.on('error', () => {})
    child.stdin.end(png)
  })
}

/** 单个 MJPEG 连接的待写上限：慢客户端不能把宿主进程的堆吃光。 */
const MAX_LIVE_QUEUE = 2 * 1024 * 1024

/**
 * 往一个 MJPEG 连接写一帧。
 * @param {import('node:http').ServerResponse} res - 连接。
 * @param {Buffer} frame - JPEG。
 * @param {() => void} drop - 断开时摘掉。
 * @returns {void}
 */
function writeFrame(res, frame, drop) {
  try {
    /* 慢客户端只许拖垮自己：待写超过上限就直接断连，让它重连，别在宿主里攒队列。 */
    if (res.writableLength > MAX_LIVE_QUEUE) {
      drop()
      res.destroy()
      return
    }
    res.write(`--frame\r\ncontent-type: image/jpeg\r\ncontent-length: ${frame.length}\r\n\r\n`)
    res.write(frame)
    res.write('\r\n')
  } catch {
    drop()
  }
}

export class Mirror {
  /**
   * @param {string} serial - 设备序列号。
   * @param {(args: string[], options?: object) => Promise<{ ok: boolean, out: Buffer, err: string }>} adb - adb 调用器。
   */
  constructor(serial, adb) {
    this.serial = serial
    this.adb = adb
    /* 注入：桥接帧是否新鲜。 */
    this.bridgeFresh = null
    this.frames = 0
    this.latest = null
    this.latestAt = 0
    this.width = 0
    this.height = 0
    this.watchers = new Set()
    this.lastWatchAt = 0
    /* 并发 start 的单飞句柄：见 start()。 */
    this.startPromise = null
    this.dropped = 0
    this.seq = 0
    this.waiters = []
    this.grabMs = 0
    this.recording = false
    /* 分段录制的收尾：请求停止标记 + 设备端 pid 文件名（只杀自己这一次录屏）。 */
    this.recorderStopRequested = false
    this.recorderPidFile = ''
    this.recorderSeq = 0
    this.stopping = false
    this.startedAt = 0
    this.error = ''
    this.dir = join(ROOT, serial.replace(/[^\w.-]/g, '_'))
    this.lastPushAt = 0
    this.timer = null
    this.pushTimer = null
    this.sentAt = 0
    this.pushed = 0
    this.inflight = 0
    this.idleSince = 0
    this.snapping = false
    this.seen = []
    this.recent = []
    this.screen = { w: 0, h: 0 }
    this.physical = { w: 0, h: 0 }
    this.frameSize = { w: 0, h: 0 }
  }

  /** 起抓帧泵与分段录制；重复调用无副作用。 @returns {Promise<void>} 起好了。 */
  /**
   * 有没有人在看：常连的 MJPEG 观看者，或 6 秒内来拉过单帧的面板。
   * @returns {boolean} 有观看者（或刚有人来看）为真。
   */
  anyoneWatching() {
    return this.watchers.size > 0 || Date.now() - this.lastWatchAt < WATCH_GRACE_MS
  }

  async start() {
    if (this.timer !== null || this.stopping) return
    /* 并发 start（页面重载 + /frame 同时到）只许跑一次：起两套定时器后，停的时候必漏一套。 */
    if (this.startPromise !== null) return this.startPromise
    this.startPromise = (async () => {
      await mkdir(this.dir, { recursive: true })
      this.startedAt = Date.now()
      this.error = ''
      const size = await this.adb(['-s', this.serial, 'shell', 'wm', 'size'], { timeout: 6000 })
      const found = /(\d+)x(\d+)/.exec(String(size.out ?? ''))
      if (found !== null) this.physical = { w: Number(found[1]), h: Number(found[2]) }
      await this.snapshot()
      this.alignScreen()
      /* 等到这里再判一次：await 期间可能已经有人 stop 了。 */
      if (this.stopping) return
      this.timer = setInterval(() => guard('pump', () => this.pump()), 200)
      this.timer.unref?.()
      this.pushTimer = setInterval(() => guard('push', () => this.push()), PUSH_TICK_MS)
      this.pushTimer.unref?.()
      /* 录制跟观看者对齐：起服务时没人看就先不录，等 /frame 或 /live 把人带来再开。 */
      this.ensureRecorder()
    })().catch((error) => {
      this.error = String(error?.message ?? error)
    }).finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  /**
   * `wm size` 报的是竖屏的物理尺寸（2136x3200），实际画面是横屏 3200x2136；
   * 标注/点按都按 screen 换算，方向错了就会整体偏到左上角。按真实画面的横竖对齐一次。
   * @returns {void}
   */
  alignScreen() {
    const raw = this.physical
    const frame = this.frameSize
    if (raw.w < 1 || raw.h < 1 || frame.w < 1 || frame.h < 1) return
    const short = Math.min(raw.w, raw.h)
    const long = Math.max(raw.w, raw.h)
    const landscape = frame.w > frame.h
    this.screen = landscape ? { w: long, h: short } : { w: short, h: long }
  }

  /** 有人在看才抓帧；没人看就空转，宽限期过了顺手把分段录制也收掉。 @returns {void} */
  pump() {
    if (this.stopping) return
    if (!this.anyoneWatching()) {
      if (this.inflight === 0) {
        if (this.idleSince === 0) this.idleSince = Date.now()
      }
      this.ensureRecorder()
      return
    }
    this.idleSince = 0
    this.ensureRecorder()
    /* 桥接帧够新就别再抓屏：两种源尺寸不同，混进同一池子画面会跳。 */
    if (this.bridgeFresh !== null && this.bridgeFresh()) return
    /* 每个节拍最多补一张，让 3 张在飞时错开完成，画面才匀。 */
    if (this.inflight < CAPTURE_PARALLEL) {
      this.inflight += 1
      void this.grab().catch((error) => { this.error = String(error?.message ?? error) }).finally(() => { this.inflight -= 1 })
    }
  }

  /**
   * 转出一帧：记最新帧、实测帧率，推给观看者。
   * @param {Buffer} frame - JPEG。
   * @returns {void}
   */
  accept(frame) {
    const dims = frameSize(frame)
    if (dims !== null) this.frameSize = dims
    const at = Date.now()
    this.latest = frame
    this.latestAt = at
    this.alignScreen()
    this.frames += 1
    this.seen.push(at)
    if (this.seen.length > 40) this.seen.shift()
    this.recent.push({ at, jpeg: frame })
    if (this.recent.length > 40) this.recent.shift()
    this.seq += 1
    if (this.waiters.length > 0) {
      const pending = this.waiters
      this.waiters = []
      for (const wake of pending) wake()
    }
  }

  /**
   * 等到比 `since` 更新的一帧：画面一动就回，最多等 `ms`。
   * 客户端拿它做长轮询，省掉固定间隔的空转，延迟只剩「抓一帧」的时间。
   * @param {number} since - 客户端已有的帧序号。
   * @param {number} ms - 最长等待毫秒。
   * @returns {Promise<Buffer | null>} JPEG，没等到时 null。
   */
  nextFrame(since, ms) {
    if (this.seq > since && this.latest !== null) return Promise.resolve(this.latest)
    return new Promise((resolve) => {
      let done = false
      const finish = (frame) => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.waiters = this.waiters.filter((each) => each !== wake)
        resolve(frame)
      }
      const wake = () => finish(this.latest)
      const timer = setTimeout(() => finish(null), ms)
      this.waiters.push(wake)
    })
  }

  /**
   * 把最近几秒的画面抽成一张 3×2 拼图：动效问题（桌宠变大变小、位移）单帧看不出来，
   * 序列帧一眼就能看出哪一帧比例不对。
   * @param {number} seconds - 回看多少秒。
   * @returns {Promise<Buffer | null>} PNG；不够帧时 null。
   */
  async recentStrip(seconds = 6) {
    if (this.recent.length < 3) return this.recentStripFromDisk(seconds)
    const newest = this.recent[this.recent.length - 1].at
    const picks = []
    for (let index = 5; index >= 0; index -= 1) {
      const target = newest - (index * seconds * 1000) / 6
      let best = null
      for (const item of this.recent) {
        if (item.at <= target + 350) best = item
      }
      if (best !== null && (picks.length === 0 || picks[picks.length - 1] !== best.jpeg)) picks.push(best.jpeg)
    }
    if (picks.length < 3) return null
    while (picks.length < 6) picks.push(picks[picks.length - 1])
    const strip = await new Promise((resolve) => {
      const child = spawn(FFMPEG, ['-v', 'error', '-f', 'image2pipe', '-framerate', '1', '-c:v', 'mjpeg', '-i', 'pipe:0',
        '-vf', 'scale=-2:300,tile=3x2:padding=6:color=0x222222', '-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'])
      const chunks = []
      let settled = false
      child.stdout.on('data', (chunk) => chunks.push(chunk))
      child.on('error', () => { if (!settled) { settled = true; resolve(null) } })
      child.on('close', () => { if (!settled) { settled = true; resolve(chunks.length > 0 ? Buffer.concat(chunks) : null) } })
      for (const jpeg of picks.slice(0, 6)) child.stdin.write(jpeg)
      child.stdin.end()
    })
    return strip
  }

  /**
   * 没人看直播时内存里没有帧，但本地环形录像一直在跑：直接从最近一段录像里抽帧拼图。
   * 「刚才我点了两下，桌宠变大不对劲」这种事后回看走这条路。
   * @param {number} seconds - 回看多少秒。
   * @returns {Promise<Buffer | null>} PNG 拼图；抽不到时 null。
   */
  /**
   * 从最近一段磁盘录像里抽帧拼图（没人看直播时的兜底）。
   * @param {number} seconds - 回看多少秒。
   * @returns {Promise<Buffer | null>} PNG 拼图；抽不到时 null。
   */
  async recentStripFromDisk(seconds = 6) {
    const list = await this.segments()
    if (list.length === 0) return null
    for (const item of list.slice(-2).reverse()) {
      const strip = await this.stripFromFile(join(this.dir, item.segment), seconds)
      if (strip !== null) return strip
    }
    return null
  }

  /**
   * 从一段录像的末尾抽帧拼成 3×2 PNG。
   * @param {string} file - 本地 mp4。
   * @param {number} seconds - 取末尾多少秒。
   * @returns {Promise<Buffer | null>} PNG；抽不到时 null。
   */
  async stripFromFile(file, seconds = 6) {
    /* 段是 screenrecord 产物：末尾那段可能还在写，先问时长再定窗口。 */
    const duration = await probeDuration(file)
    if (!(duration > 0.6)) return null
    const window = Math.min(seconds, duration)
    const step = window / 6
    const picks = []
    for (let index = 0; index < 6; index += 1) {
      const at = Math.max(0, duration - window + (index * step))
      const jpeg = await grabFrameAt(file, at)
      if (jpeg === null) break
      picks.push(jpeg)
    }
    if (picks.length < 3) return null
    while (picks.length < 6) picks.push(picks[picks.length - 1])
    return tileFrames(picks)
  }

  /**
   * 磁盘上最近一段录像有多旧：超过宽限就不能再拿它充「近几秒」。
   * @returns {Promise<number>} 毫秒；一段都没有时 Infinity。
   */
  async segmentAge() {
    const list = await this.segments()
    if (list.length === 0) return Number.POSITIVE_INFINITY
    return Math.max(0, Date.now() - list[list.length - 1].at)
  }

  /**
   * 现场录一小段再拉回本机：绕开大文件、秒级出结果，代价是这条命令本身要跑满时长。
   * @param {number} seconds - 录几秒（2–12）。
   * @returns {Promise<string | null>} 本地 mp4 路径；起不来时 null（例如直播正占着编码器）。
   */
  /**
   * 录像尺寸：跟设备竖屏同比例，长边 960。写死 960x640 是横屏 3:2，竖屏内容会被压扁。
   * @returns {string} screenrecord 的 --size 参数。
   */
  recordSize() {
    const p = this.physical
    const short = Math.min(p.w > 0 ? p.w : 9, p.h > 0 ? p.h : 16)
    const long = Math.max(p.w > 0 ? p.w : 9, p.h > 0 ? p.h : 16)
    const k = 960 / long
    const width = Math.max(2, Math.round((short * k) / 2) * 2)
    const height = Math.max(2, Math.round((long * k) / 2) * 2)
    return `${width}x${height}`
  }

  async captureBurst(seconds = 4) {
    const span = Math.min(12, Math.max(2, Math.round(seconds)))
    const remote = `/sdcard/dsh-burst-${this.serial.replace(/[^\w.-]/g, '_')}.mp4`
    const began = Date.now()
    const t0 = Date.now()
    const recorded = await this.adb([
      '-s', this.serial, 'shell', 'screenrecord',
      '--time-limit', String(span), '--bit-rate', '2000000', '--size', this.recordSize(), remote,
    ], { timeout: (span + 15) * 1000, direct: true }).catch(() => null)
    if (!recorded || !recorded.ok) return null
    const t1 = Date.now()
    const pulled = await this.adb(['-s', this.serial, 'exec-out', 'cat', remote], { timeout: 60_000, direct: true }).catch(() => null)
    const t2 = Date.now()
    await this.adb(['-s', this.serial, 'shell', 'rm', '-f', remote], { timeout: 8000 }).catch(() => {})
    if (!pulled || !pulled.ok || !Buffer.isBuffer(pulled.raw) || pulled.raw.length < 4096) return null
    const file = join(this.dir, `burst-${began}.mp4`)
    await writeFile(file, pulled.raw).catch(() => null)
    this.lastBurstTiming = { record_ms: t1 - t0, pull_ms: t2 - t1 }
    return existsSync(file) ? file : null
  }

  /**
   * 取一段「刚刚」的录像文件给逐像素分析用：磁盘段够新就白用，不够新就现场录。
   * @param {number} seconds - 需要多长。
   * @returns {Promise<{ file: string, source: 'disk' | 'burst', ageMs: number, temp: boolean } | null>}
   */
  async recentClip(seconds = 4, force = false) {
    const list = await this.segments()
    if (list.length > 0 && !force) {
      const last = list[list.length - 1]
      const age = Math.max(0, Date.now() - last.at)
      const file = join(this.dir, last.segment)
      const duration = await probeDuration(file)
      if (age < 15_000 && duration >= Math.min(seconds, 1)) return { file, source: 'disk', ageMs: age, temp: false }
    }
    /* 录多 1 秒会给屏录进程多留 1 秒启动开销，末尾取 frame 时本来只要 seconds 秒 */
    const burst = await this.captureBurst(Math.min(12, seconds))
    if (burst !== null) return { file: burst, source: 'burst', ageMs: 0, temp: true }
    if (list.length === 0) return null
    const last = list[list.length - 1]
    return { file: join(this.dir, last.segment), source: 'disk', ageMs: Math.max(0, Date.now() - last.at), temp: false }
  }

  /**
   * 逐像素动效时间线：每帧相对上一帧变了多大、变在哪、抖了几下、多久稳住。
   * 桌宠、悬浮窗、自绘动画在控件树里看不见，只能这样量。
   * @param {object} options - seconds / fps / region / threshold。
   * @returns {Promise<object | null>} 指标与逐帧序列。
   */
  async motionTimeline(options = {}) {
    const seconds = Math.min(12, Math.max(2, Number(options.seconds ?? 4)))
    const fps = Math.min(10, Math.max(2, Number(options.fps ?? 8)))
    const threshold = Math.min(64, Math.max(2, Number(options.threshold ?? 12)))
    const region = options.region ?? null
    const clip = await this.recentClip(seconds, options.force === true)
    if (clip === null) return null
    try {
      const size = await probeVideoSize(clip.file)
      /* region 是设备像素坐标，录像只有 960x640：先按比例换到视频坐标再裁，
         否则 crop 越界，ffmpeg 一帧都不给，看起来像「录屏没起来」。 */
      const screen = this.screen !== undefined && this.screen.w > 0 ? this.screen : size
      const crop = region !== null && screen !== null && size !== null && region.w > 0 && region.h > 0
        ? {
            x: Math.max(0, Math.min(size.w - 2, Math.round((region.x / screen.w) * size.w))),
            y: Math.max(0, Math.min(size.h - 2, Math.round((region.y / screen.h) * size.h))),
            w: 0,
            h: 0,
          }
        : null
      if (crop !== null) {
        crop.w = Math.max(2, Math.min(size.w - crop.x, Math.round((region.w / screen.w) * size.w)))
        crop.h = Math.max(2, Math.min(size.h - crop.y, Math.round((region.h / screen.h) * size.h)))
      }
      const gray = await grayFrames(clip.file, seconds, fps, crop)
      if (gray === null) return null
      const factor = crop !== null ? region.w / gray.w : (screen === null ? 1 : screen.w / gray.w)
      const frames = []
      const series = []
      const reaches = []
      for (let index = 1; index < gray.bytes.length; index += 1) {
        const before = gray.bytes[index - 1]
        const after = gray.bytes[index]
        const width = gray.w
        const height = gray.h
        const mask = new Uint8Array(after.length)
        let scattered = 0
        for (let at = 0; at < after.length; at += 1) {
          if (Math.abs(after[at] - before[at]) <= threshold) continue
          mask[at] = 1
          scattered += 1
        }
        let area = 0
        let outer = 0
        let blobs = 0
        let minX = width
        let minY = height
        let maxX = -1
        let maxY = -1
        if (crop !== null) {
          /* 已经圈到某一处（例如桌宠）时，变化就是这一件事本身：
             取全部变化像素的外接框，别做连通块拆分，否则壳/嘴/气泡各算一块，
             框在帧间来回跳，会把「整体变大」误读成抖动。 */
          area = scattered
          let sumX = 0
          let sumY = 0
          for (let at = 0; at < mask.length; at += 1) {
            if (mask[at] !== 1) continue
            const x = at % width
            const y = (at - x) / width
            sumX += x
            sumY += y
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
          }
          if (scattered > 0) {
            const cx = sumX / scattered
            const cy = sumY / scattered
            for (let at = 0; at < mask.length; at += 1) {
              if (mask[at] !== 1) continue
              const x = at % width
              const y = (at - x) / width
              const reach = Math.max(Math.abs(x - cx), Math.abs(y - cy))
              if (reach > outer) outer = reach
            }
          }
          blobs = scattered > 0 ? 1 : 0
        } else {
          /* 全屏时时钟、状态栏、各处动效各变各的，混成一个外接框会得到假抖动：
             只认最大的一团。 */
          const stack = new Int32Array(after.length)
          for (let seed = 0; seed < mask.length; seed += 1) {
            if (mask[seed] !== 1) continue
            blobs += 1
            let top = 0
            let size = 0
            let left = width
            let right = -1
            let up = height
            let down = -1
            stack[0] = seed
            top = 1
            mask[seed] = 2
            while (top > 0) {
              const cur = stack[--top]
              const x = cur % width
              const y = (cur - x) / width
              size += 1
              if (x < left) left = x
              if (x > right) right = x
              if (y < up) up = y
              if (y > down) down = y
              if (x > 0 && mask[cur - 1] === 1) { mask[cur - 1] = 2; stack[top++] = cur - 1 }
              if (x < width - 1 && mask[cur + 1] === 1) { mask[cur + 1] = 2; stack[top++] = cur + 1 }
              if (y > 0 && mask[cur - width] === 1) { mask[cur - width] = 2; stack[top++] = cur - width }
              if (y < height - 1 && mask[cur + width] === 1) { mask[cur + width] = 2; stack[top++] = cur + width }
            }
            if (size > area) { area = size; minX = left; minY = up; maxX = right; maxY = down }
          }
        }
        const boxed = maxX >= minX && maxY >= minY
        const box = boxed
          ? { x: Math.round(minX * factor), y: Math.round(minY * factor), w: Math.round((maxX - minX + 1) * factor), h: Math.round((maxY - minY + 1) * factor) }
          : { x: 0, y: 0, w: 0, h: 0 }
        const frame = {
          t: Math.round((index / fps) * 1000),
          changed_pct: Number(((area / after.length) * 100).toFixed(2)),
          scattered_pct: Number(((scattered / after.length) * 100).toFixed(2)),
          blobs,
          box,
          reach: Math.round(outer * factor),
          dup: area === 0,
        }
        frames.push(frame)
        reaches.push(Math.round(outer * factor))
        series.push(box.w === 0 && box.h === 0 ? 0 : Math.round(Math.sqrt((box.w * box.w) + (box.h * box.h))))
      }
      /* 画面静止时 screenrecord 按内容驱动只有约 1 帧/秒，抽到 8fps 会有大量重复帧：
         重复帧不算「一次变化」，否则 0 帧差会被当成一次反向抖动。
         变化再按空间切链：相邻变化帧外接框不重叠 = 另一处在动，重开一条链，
         峰值/回弹/抖动只在最长的那条链上算，避免全屏里多处动效互相污染。 */
      const chains = []
      let chain = null
      let previousBox = null
      for (let index = 0; index < frames.length; index += 1) {
        const frame = frames[index]
        if (frame.dup) { chain = null; previousBox = null; continue }
        const box = frame.box
        const touched = previousBox !== null
          && Math.min(previousBox.x + previousBox.w, box.x + box.w) > Math.max(previousBox.x, box.x)
          && Math.min(previousBox.y + previousBox.h, box.y + box.h) > Math.max(previousBox.y, box.y)
        if (!touched) { chain = null; previousBox = box }
        if (chain === null) {
          chain = { diags: [], steps: [] }
          chains.push(chain)
          chain.diags.push(Math.round(Math.sqrt((box.w * box.w) + (box.h * box.h))))
        } else {
          const now = Math.round(Math.sqrt((box.w * box.w) + (box.h * box.h)))
          const was = chain.diags[chain.diags.length - 1]
          chain.diags.push(now)
          chain.steps.push(now - was)
          previousBox = box
        }
      }
      let focus = null
      /* 圈定了区域（例如桌宠）时，衡量「大小」用外缘半径：变化圈往外涨=变大，往里收=变小。
         全屏没法这么算（各处距离同一个圆心没有意义），仍用最大连通块的外接框对角。 */
      let metric = "diag"
      if (crop !== null) {
        metric = "reach"
        const values = []
        const steps = []
        for (let index = 0; index < reaches.length; index += 1) {
          if (frames[index].dup) continue
          if (values.length > 0) steps.push(reaches[index] - values[values.length - 1])
          values.push(reaches[index])
        }
        focus = { diags: values, steps }
      } else {
        for (const each of chains) if (focus === null || each.diags.length >= focus.diags.length) focus = each
      }
      const focusDiags = focus === null ? [] : focus.diags
      const peak = focusDiags.length > 0 ? Math.max(...focusDiags) : 0
      const tail = focusDiags.length > 0 ? focusDiags[focusDiags.length - 1] : 0
      const chainPeak = peak
      let jitter = 0
      let previousSign = 0
      let biggestStep = 0
      let biggestStepAt = 0
      if (focus !== null) {
        for (let index = 0; index < focus.steps.length; index += 1) {
          const delta = focus.steps[index]
          if (Math.abs(delta) >= Math.max(4, chainPeak * 0.1)) {
            const sign = Math.sign(delta)
            if (previousSign !== 0 && sign !== previousSign) jitter += 1
            previousSign = sign
          }
          if (Math.abs(delta) > biggestStep) { biggestStep = Math.abs(delta); biggestStepAt = index }
        }
      }
      /* settle：末尾连续重复帧的长度就是「已经稳住多久」；末尾还在变就返回 -1，别硬报 0。 */
      let settleMs = -1
      if (series.length > 0) {
        let trailing = 0
        for (let index = frames.length - 1; index >= 1; index -= 1) {
          if (!frames[index].dup) break
          trailing += 1
        }
        if (trailing > 0) settleMs = Math.round((trailing / fps) * 1000)
      }
      const liveCount = frames.filter((frame) => !frame.dup).length
      return {
        source: clip.source,
        age_ms: clip.ageMs,
        record_ms: this.lastBurstTiming?.record_ms ?? 0,
        pull_ms: this.lastBurstTiming?.pull_ms ?? 0,
        fps,
        real_fps: Number((liveCount / seconds).toFixed(1)),
        frames: frames.length,
        changed_frames: liveCount,
        chained_frames: focus === null ? 0 : focus.diags.length,
        metric,
        region: region === null ? null : { x: region.x, y: region.y, w: region.w, h: region.h },
        duplicates: frames.length - liveCount,
        device: size === null ? null : { w: size.w, h: size.h },
        peak_size_px: peak,
        tail_size_px: tail,
        overshoot_pct: tail > 0 ? Number((((peak - tail) / tail) * 100).toFixed(1)) : 0,
        biggest_step_px: biggestStep,
        biggest_step_at_ms: Math.round(((biggestStepAt + 1) / fps) * 1000),
        jitter,
        settle_ms: settleMs,
        series: metric === "reach" && focus !== null ? focus.diags : series,
        timeline: frames,
      }
    } finally {
      if (clip.temp) await rm(clip.file, { force: true }).catch(() => {})
    }
  }

  /**
   * 「刚才那几秒」：优先真近的帧，并如实交代来源——内存直播帧 / 近 25 秒的磁盘段 / 现场现录。
   * 之前它可能拿几分钟前的旧段拼图，看着像回看其实是旧的，这里把这件事钉死。
   * @param {number} seconds - 回看多少秒。
   * @returns {Promise<{ png: Buffer, source: 'live' | 'burst' | 'disk', ageMs: number } | null>}
   */
  async recentStripWithSource(seconds = 6) {
    const newest = this.recent.length > 0 ? this.recent[this.recent.length - 1].at : 0
    if (newest > 0 && Date.now() - newest < 8000) {
      const png = await this.recentStrip(seconds)
      if (png !== null) return { png, source: 'live', ageMs: 0 }
    }
    const age = await this.segmentAge()
    if (!Number.isFinite(age) || age > 25_000) {
      const file = await this.captureBurst(seconds)
      if (file !== null) {
        const png = await this.stripFromFile(file, seconds + 0.5)
        await rm(file, { force: true }).catch(() => {})
        if (png !== null) return { png, source: 'burst', ageMs: 0 }
      }
    }
    const png = await this.recentStripFromDisk(seconds)
    return png === null ? null : { png, source: 'disk', ageMs: age }
  }

  /**
   * 抓一张当前画面当最新帧：屏幕静止时编码器不出帧，靠它兜底。
   * @returns {Promise<Buffer | null>} JPEG，抓不到时 null。
   */
  async snapshot() {
    if (this.snapping) return null
    this.snapping = true
    try {
      return await this.grab()
    } finally {
      this.snapping = false
    }
  }

  /**
   * 抓一张并写进最新帧。
   * @returns {Promise<Buffer | null>} JPEG，抓不到时 null。
   */
  async grab() {
    const began = Date.now()
    const frame0 = await this.grabOnce()
    this.grabMs = Date.now() - began
    return frame0
  }

  /**
   * 抓一张原始实现，`grab` 只在外层记耗时。
   * @returns {Promise<Buffer | null>} JPEG。
   */
  async grabOnce() {
    /* 设备端直出 JPEG 再 cat：0.36 s / 3.5 MB，比 `exec-out screencap -p`（3 s / 8.5 MB）
       快一个量级。两件事塞进一次 exec-out，省一个 adb 往返。 */
    let image = null
    try {
      /* JPEG 直接写 stdout：不再落临时文件，也就没有两张并发抢同一个文件、cat 到半截
         图像（画面突然一大块颜色就是这么来的）。一次 adb 往返，3.5 MB。 */
      const shot = await this.adb(['-s', this.serial, 'exec-out', 'sh', '-c',
        'screencap -j /dev/stdout 2>/dev/null'], { timeout: 6_000 })
      const raw = shot?.raw
      if (Buffer.isBuffer(raw) && raw.length > 2_000) {
        const at = raw.indexOf(JPEG_SIG)
        if (at >= 0) {
          const jpeg = raw.subarray(at)
          /* 只收完整帧：结尾缺 EOI 就是被截断的图，画上去就是色块。 */
          if (jpeg.length > 2_000 && jpeg.subarray(-2).equals(Buffer.from([0xff, 0xd9]))) image = jpeg
          else this.dropped += 1
        }
      }
    } catch { /* 老系统没有 screencap -j，走下面的 PNG 回退 */ }
    if (image === null) {
      let shot
      try {
        shot = await this.adb(['-s', this.serial, 'exec-out', 'screencap', '-p'], { timeout: 12_000 })
      } catch {
        return null
      }
      const raw = shot?.raw
      if (!Buffer.isBuffer(raw) || raw.length < 1000) return null
      const png = raw.indexOf(PNG_SIG)
      if (png < 0) return null
      image = raw.subarray(png)
    }
    const frame = await pngToJpeg(image)
    if (frame === null) return null
    this.accept(frame)
    return frame
  }

  /**
   * 该录就录、该停就停：只有有人在看才保留分段录制，没人看超过宽限期就收掉。
   * 由 pump() 每 200ms 调一次，重复调用无副作用。
   * @returns {void}
   */
  ensureRecorder() {
    if (this.stopping) return
    if (this.anyoneWatching()) {
      if (!this.recording) void this.startRecorder()
      return
    }
    if (!this.recording) return
    const idleAt = this.idleSince > 0 ? this.idleSince : this.lastWatchAt
    if (idleAt > 0 && Date.now() - idleAt < WATCH_GRACE_MS) return
    this.stopRecorder()
  }

  /**
   * 请求停掉分段录制：只按自己记下的设备端 pid 收尾，不碰别人的 screenrecord。
   * @returns {void}
   */
  stopRecorder() {
    this.recorderStopRequested = true
    const pidFile = this.recorderPidFile
    this.recorderPidFile = ''
    if (pidFile !== '') void this.killOwnRecorder(pidFile)
  }

  /**
   * 精确杀自己这一次录屏：pid 取自启动时写下的设备端文件，并核对进程名还是 screenrecord。
   * pid 拿不到（文件为空/读不到）就退化为不杀，只记一条错误，交给下一段自己超时结束。
   * @param {string} pidFile - 启动时写下的 pid 文件绝对路径。
   * @returns {Promise<string>} 设备端回话：`killed:<pid>` 或 `skip:<原因>`。
   */
  async killOwnRecorder(pidFile) {
    const safe = String(pidFile).replace(/[^\w./-]/g, '')
    if (safe === '') return 'skip:no-pid-file'
    const script = `p='${safe}'; r=$(cat "$p" 2>/dev/null); rm -f "$p"; if [ -n "$r" ] && [ "$(cat /proc/$r/comm 2>/dev/null)" = 'screenrecord' ]; then kill -9 "$r"; echo killed:$r; else echo skip:$r; fi`
    const result = await this.adb(['-s', this.serial, 'shell', script], { timeout: 8000, direct: true }).catch(() => null)
    const out = String(result?.out ?? '').trim()
    if (out.startsWith('killed:')) return out
    this.error = this.error || `录屏收尾没拿到 pid（${out || '没有回话'}），没杀设备端进程`
    return out || 'skip:no-reply'
  }

  /**
   * 循环分段录制：设备上录 10s 一段，拉回本机，只留最近 18 段。
   * 每段启动时把 pid 写进设备端文件，停止时按 pid 精确 kill。
   * @returns {Promise<void>} 停了才返回。
   */
  async startRecorder() {
    if (this.recording || this.stopping) return
    this.recording = true
    this.recorderStopRequested = false
    const safeSerial = this.serial.replace(/[^\w.-]/g, '_')
    const remote = `/sdcard/dsh-${safeSerial}.mp4`
    while (!this.stopping && !this.recorderStopRequested) {
      const started = Date.now()
      this.recorderSeq += 1
      const pidFile = `/data/local/tmp/dsh-mobile-use-rec-${safeSerial}-${REC_TAG}-${this.recorderSeq}.pid`
      this.recorderPidFile = pidFile
      /* exec 让 shell 的 pid 就是 screenrecord 的 pid：停的时候按这个 pid 精确 kill。 */
      const command = `sh -c 'echo $$ > ${pidFile}; exec screenrecord --time-limit ${SEGMENT_SECONDS} --bit-rate 2000000 --size ${this.recordSize()} ${remote}'`
      const recorded = await this.adb(['-s', this.serial, 'shell', command], {
        timeout: (SEGMENT_SECONDS + 20) * 1000,
        direct: true,
      }).catch((error) => ({ ok: false, err: String(error?.message ?? error) }))
      if (this.stopping || this.recorderStopRequested) break
      if (!recorded.ok) {
        this.error = String(recorded.err ?? '').trim().slice(0, 200) || '录制失败'
        await new Promise((resolve) => setTimeout(resolve, 1500))
        continue
      }
      const pulled = await this.adb(['-s', this.serial, 'exec-out', 'cat', remote], { timeout: 60_000, direct: true })
      await this.adb(['-s', this.serial, 'shell', 'rm', '-f', remote], { timeout: 8000 })
      const bytes = pulled.raw
      if (pulled.ok && Buffer.isBuffer(bytes) && bytes.length > 2048) {
        const name = `seg-${started}.mp4`
        await writeFile(join(this.dir, name), bytes).catch(() => {})
        this.error = ''
        void this.rotate()
      } else {
        this.error = '这一段没录到画面'
      }
      const spent = Date.now() - started
      if (spent < SEGMENT_SECONDS * 1000) await new Promise((resolve) => setTimeout(resolve, Math.max(0, 400 - spent)))
    }
    this.recording = false
    this.recorderStopRequested = false
  }

  /** 本机只留最近 18 段（约 3 分钟）。 @returns {Promise<void>} 删完。 */
  async rotate() {
    try {
      const names = (await readdir(this.dir)).filter((name) => name.startsWith('seg-') && name.endsWith('.mp4')).sort()
      const extra = names.slice(0, Math.max(0, names.length - SEGMENT_KEEP))
      for (const name of extra) await rm(join(this.dir, name), { force: true }).catch(() => {})
    } catch {
      /* 目录还没建好 */
    }
  }

  /** @returns {number} 最近几秒的实测帧率，一位小数。 */
  measuredFps() {
    if (this.seen.length < 2) return 0
    const span = this.seen[this.seen.length - 1] - this.seen[0]
    if (span <= 0) return 0
    return Math.round(((this.seen.length - 1) / span) * 1000 * 10) / 10
  }

  /**
   * 按固定节拍把最新一帧写给所有观看者。截图是一股一股完成的，
   * 只在有新帧时才送会把画面卡成 1–2 帧/秒，所以按节拍原样重发。
   * @returns {void}
   */
  push() {
    if (!this.anyoneWatching() || this.latest === null) return
    this.sentAt = this.latestAt
    this.pushed += 1
    const frame = this.latest
    for (const res of this.watchers) writeFrame(res, frame, () => this.watchers.delete(res))
  }

  /**
   * 等第一帧出现。
   * @param {number} ms - 上限。
   * @returns {Promise<Buffer | null>} 帧，或 null。
   */
  async firstFrame(ms = 4000) {
    const deadline = Date.now() + ms
    while (this.latest === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
    return this.latest
  }

  /** 停掉两条子进程、收掉分段录制并断开观看者；重复调用无副作用。 @returns {void} */
  stop() {
    this.stopping = true
    this.stopRecorder()
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    if (this.pushTimer !== null) clearInterval(this.pushTimer)
    this.pushTimer = null
    for (const res of this.watchers) {
      try { res.end() } catch { /* 已经断了 */ }
    }
    this.watchers.clear()
    void this.adb(['-s', this.serial, 'shell', 'rm', '-f', `/sdcard/dsh-${this.serial.replace(/[^\w.-]/g, '_')}.mp4`], { timeout: 8000 }).catch(() => {})
  }

  /** @returns {Promise<{ segment: string, bytes: number, at: number }[]>} 环形缓冲里的片段。 */
  async segments() {
    try {
      const names = (await readdir(this.dir)).filter((name) => name.endsWith('.mp4')).sort()
      const out = []
      for (const name of names) {
        const info = await stat(join(this.dir, name))
        out.push({ segment: name, bytes: info.size, at: info.mtimeMs })
      }
      return out
    } catch {
      return []
    }
  }
}

/**
 * 装好镜像能力：HTTP 路由、直播、录制、标注回传。
 * @param {any} ctx - Cordis 上下文。
 * @param {{ adb: any, resolveSerial: () => Promise<string>, uiInRect?: (serial: string, rect: any) => Promise<string[]> }} tools - 宿主已有的能力。
 * @returns {{ open: () => number, status: (serial?: string) => Promise<object>, stopAll: () => void }} 给工具层用的入口。
 */
export function setupMirror(ctx, tools) {
  /**
   * 人手在侧栏的动作也写进宿主的时间线：agent 要能回答「用户到底点了没有」。
   * 时间线坏了不能挡住输入，所以整段包在 try 里。
   * @param {string} what - 动作描述。
   * @returns {void}
   */
  const note = (what) => {
    try {
      tools.noteAction?.(what)
    } catch { /* 时间线不是关键路径 */ }
  }
  const mirrors = new Map()
  const events = new Set()
  /** 每台设备的 H.264 推流。 @type {Map<string, LiveStream>} */
  const streams = new Map()

  /* 低延迟通道：一台设备一条 scrcpy 连接，懒启动，失败就永久退回 adb。
     host 不能因为它崩：起停全在 guard 里，启动 Promise 失败也只记一个 failed。 */
  const channels = new Map()
  let channelSeq = 0

  /**
   * 拿一台设备的低延迟通道，没就绪就顺手启动（异步，不阻塞调用方）。
   * @param {string} serial - 设备。
   * @param {boolean} [autoStart] - 没就绪时是否启动。
   * @returns {any | null} 已就绪的通道；没就绪给 null。
   */
  function channelFor(serial, autoStart = true) {
    let entry = channels.get(serial)
    /* failed 不能是永久判决：设备侧 server 偶发起不来一次，之后所有观众都被钉在
       screenrecord 回退路径上。失败 10 秒后允许再试。 */
    /* 失败冷却别设太长：冷却期内只能退回 screenrecord，那条路更慢还会抢编码器。
       4 秒足够挡掉启动风暴，又不至于让人等半天才恢复高清。 */
    if (entry !== undefined && entry.failed === true && Date.now() - (Number(entry.failedAt) || 0) > 4000) {
      entry.failed = false
      entry.failedAt = 0
    }
    /* 通道对象被 closed 回调清成 null 之后，这个 entry 就永远等不到 ready 了：
       之前没人把它扔掉，于是「重建后一直退回录屏」。这里补上重造。 */
    if (entry !== undefined && entry.channel === null && entry.starting !== true && entry.failed !== true) {
      channels.delete(serial)
      entry = undefined
    }
    if (entry === undefined) {
      entry = { channel: null, ready: null, failed: false, starting: false, failedAt: 0 }
      channels.set(serial, entry)
      try {
        channelSeq += 1
        const channel = new ScrcpyChannel({
          serial,
          adbPath: tools.adb.path,
          port: 27185 + channelSeq,
          maxSize: Number(process.env.ADBM_MAX_SIZE ?? 1600),
          maxFps: Number(process.env.ADBM_MAX_FPS ?? 0),
          videoBitRate: Number(process.env.ADBM_BITRATE ?? 8_000_000),
          log: (note) => ctx.logger?.debug?.(`[scrcpy] ${String(note)}`),
        })
        entry.channel = channel
        /* 通道是一次性的：stop()/对端断开之后再 start() 只会立刻失败，而这个 entry 会一直
           缓存着那个死对象，于是「等采集源」永远等不到，只能退回 screenrecord 那条死路。
           断开就把它扔掉，下一次 channelFor 重新 new 一条（新端口、新 scid）。 */
        channel.on?.('closed', () => {
          entry.ready = null
          entry.channel = null
          entry.starting = false
        })
      } catch {
        entry.failed = true
        entry.failedAt = Date.now()
      }
    }
    if (autoStart && entry.failed !== true && entry.ready === null && entry.starting !== true && entry.channel !== null) {
      entry.starting = true
      void Promise.resolve()
        .then(() => entry.channel.start())
        .then((ok) => {
          entry.starting = false
          if (ok === true) entry.ready = entry.channel
          else {
            /* 起不来也扔掉这条通道，给下一次留一次重新 new 的机会；
               失败原因必须留痕，否则只看到「一直退回录屏」却不知道为什么。 */
            entry.channel = null
            entry.failed = true
            entry.failedAt = Date.now()
            streamFor(serial).debug('scrcpy 通道启动失败（start 返回非 true），退回 screenrecord')
            ctx.logger?.warn?.('[scrcpy] 通道启动失败，退回 screenrecord（4 秒后再试）')
          }
        })
        .catch((error) => {
          entry.starting = false
          entry.channel = null
          entry.failed = true
          entry.failedAt = Date.now()
          streamFor(serial).debug('scrcpy 通道启动抛错：' + String(error?.message ?? error))
          ctx.logger?.warn?.('[scrcpy] 通道启动抛错：' + String(error?.message ?? error))
        })
    }
    return entry.ready
  }

  /**
   * 等一台设备的低延迟通道就绪：最多 2.5 秒。等不到给 null，调用方退回 screenrecord。
   * @param {string} serial - 设备。
   * @returns {Promise<any | null>} 就绪的通道。
   */
  /**
   * 采集源现在处于哪一步：通道还在连的时候调用方应该继续等，而不是掉到录屏。
   * @param {string} serial - 设备。
   * @returns {'ready' | 'starting' | 'failed' | 'idle' | 'none'} 状态。
   */
  function channelState(serial) {
    const entry = channels.get(serial)
    if (entry === undefined) return 'none'
    if (entry.ready !== null && entry.ready !== undefined) return 'ready'
    if (entry.failed === true) return 'failed'
    if (entry.starting === true) return 'starting'
    return 'idle'
  }

  async function waitSource(serial, timeoutMs = 2500) {
    const ready = channelFor(serial)
    if (ready !== null) return ready
    const entry = channels.get(serial)
    if (entry === undefined || entry.failed === true) return null
    const deadline = Date.now() + (Number(timeoutMs) > 0 ? Number(timeoutMs) : 2500)
    while (Date.now() < deadline) {
      await tick(120)
      if (entry.ready !== null) return entry.ready
      if (entry.failed === true) return null
    }
    return null
  }

  /** 触控消息的公共字段：坐标空间 = 视频尺寸 = 设备像素。 @returns {any | null} 尺寸没读到给 null。 */
  function touchBase(channel) {
    const info = channel?.info ?? null
    const width = Number(info?.width) || 0
    const height = Number(info?.height) || 0
    if (!(width > 0) || !(height > 0)) return null
    return { screenWidth: width, screenHeight: height, pressure: 1, buttons: 1 }
  }

  /** 微秒级等待。 @returns {Promise<void>} */
  function tick(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
  }

  /**
   * 点一下（可选长按）。
   * @returns {Promise<{ok: boolean, engine: string} | null>} null 表示这条路不通，调用方退回 adb。
   */
  async function scrcpyTap(serial, x, y, options = {}) {
    const channel = channelFor(serial)
    if (channel === null) return null
    const base = touchBase(channel)
    if (base === null) return null
    const px = Math.round(Number(x) || 0)
    const py = Math.round(Number(y) || 0)
    if (channel.pushTouch({ ...base, action: TOUCH_ACTION.DOWN, x: px, y: py }) !== true) return null
    if (options.long === true) await tick(Math.max(120, Math.min(3000, Number(options.holdMs) || 620)))
    const ok = channel.pushTouch({ ...base, action: TOUCH_ACTION.UP, x: px, y: py, pressure: 0, buttons: 0 })
    return ok === true ? { ok: true, engine: 'scrcpy' } : null
  }

  /** 一条直线滑动：12~24 个 MOVE，按总时长均分，手感接近真实手指。 @returns {Promise<any | null>} 结果。 */
  async function scrcpySwipe(serial, x1, y1, x2, y2, ms) {
    const channel = channelFor(serial)
    if (channel === null) return null
    const base = touchBase(channel)
    if (base === null) return null
    const total = Math.max(16, Math.min(4000, Math.round(Number(ms) || 300)))
    /* 一次注入的离散点：60 Hz 起步（16 ms 一步），上限 60 步；pushTouch 只要 0.28 ms，密一点不会拖慢。 */
    const steps = Math.max(3, Math.min(60, Math.round(total / 16)))
    const fromX = Math.round(Number(x1) || 0)
    const fromY = Math.round(Number(y1) || 0)
    const toX = Math.round(Number(x2) || 0)
    const toY = Math.round(Number(y2) || 0)
    if (channel.pushTouch({ ...base, action: TOUCH_ACTION.DOWN, x: fromX, y: fromY }) !== true) return null
    for (let i = 1; i <= steps; i += 1) {
      const k = i / steps
      channel.pushTouch({
        ...base,
        action: TOUCH_ACTION.MOVE,
        x: Math.round(fromX + (toX - fromX) * k),
        y: Math.round(fromY + (toY - fromY) * k),
      })
      await tick(total / steps)
    }
    const ok = channel.pushTouch({ ...base, action: TOUCH_ACTION.UP, x: toX, y: toY, pressure: 0, buttons: 0 })
    return ok === true ? { ok: true, engine: 'scrcpy' } : null
  }

  /**
   * 多条轨迹同时走（单指滑动、双指缩放都走这里）。
   * @returns {Promise<any | null>} 结果；多于 5 指或多步轨迹长度不一致时不接。
   */
  async function scrcpyGesture(serial, tracks, ms) {
    const channel = channelFor(serial)
    if (channel === null) return null
    const base = touchBase(channel)
    if (base === null) return null
    if (!Array.isArray(tracks) || tracks.length === 0 || tracks.length > 5) return null
    if (!tracks.every((track) => Array.isArray(track) && track.length >= 2)) return null
    const total = Math.max(16, Math.min(4000, Math.round(Number(ms) || 300)))
    const steps = Math.max(3, Math.min(24, Math.round(total / 40)))
    const at = (track, k) => {
      const pos = k * (track.length - 1)
      const index = Math.min(track.length - 2, Math.floor(pos))
      const frac = pos - index
      const ax = Number(track[index][0]) || 0
      const ay = Number(track[index][1]) || 0
      const bx = Number(track[index + 1][0]) || 0
      const by = Number(track[index + 1][1]) || 0
      return [Math.round(ax + (bx - ax) * frac), Math.round(ay + (by - ay) * frac)]
    }
    const pointers = tracks.map((track, index) => ({ track, pointerId: index }))
    /* 第一根手指就是普通 DOWN；后面的手指用 POINTER_DOWN 挂上去。 */
    const first = at(pointers[0].track, 0)
    if (channel.pushTouch({ ...base, action: TOUCH_ACTION.DOWN, x: first[0], y: first[1], pointerId: 0 }) !== true) return null
    for (const pointer of pointers.slice(1)) {
      const spot = at(pointer.track, 0)
      channel.pushTouch({ ...base, action: TOUCH_ACTION.POINTER_DOWN, x: spot[0], y: spot[1], pointerId: pointer.pointerId })
    }
    for (let i = 1; i <= steps; i += 1) {
      const k = i / steps
      for (const pointer of pointers) {
        const spot = at(pointer.track, k)
        channel.pushTouch({ ...base, action: TOUCH_ACTION.MOVE, x: spot[0], y: spot[1], pointerId: pointer.pointerId })
      }
      await tick(total / steps)
    }
    for (const pointer of pointers.slice(1).reverse()) {
      const spot = at(pointer.track, 1)
      channel.pushTouch({ ...base, action: TOUCH_ACTION.POINTER_UP, x: spot[0], y: spot[1], pointerId: pointer.pointerId, pressure: 0, buttons: 0 })
    }
    const last = at(pointers[0].track, 1)
    const ok = channel.pushTouch({ ...base, action: TOUCH_ACTION.UP, x: last[0], y: last[1], pointerId: 0, pressure: 0, buttons: 0 })
    return ok === true ? { ok: true, engine: 'scrcpy' } : null
  }

  /** 按键（keycode 数字）。 @returns {Promise<any | null>} 结果。 */
  async function scrcpyKey(serial, keycode, options = {}) {
    const channel = channelFor(serial)
    if (channel === null) return null
    const code = Number(keycode)
    if (!Number.isFinite(code) || code <= 0) return null
    if (channel.pushKeycode({ action: KEY_ACTION.DOWN, keycode: code, metastate: Number(options.metastate) || 0 }) !== true) return null
    if (options.holdMs !== undefined && Number(options.holdMs) > 0) await tick(Number(options.holdMs))
    const ok = channel.pushKeycode({ action: KEY_ACTION.UP, keycode: code, metastate: Number(options.metastate) || 0 })
    return ok === true ? { ok: true, engine: 'scrcpy' } : null
  }

  fastInput.tap = scrcpyTap
  fastInput.swipe = scrcpySwipe
  fastInput.gesture = scrcpyGesture
  fastInput.key = scrcpyKey
  fastInput.raw = (serial) => {
    const channel = channelFor(serial)
    if (channel === null) return null
    const base = touchBase(channel)
    if (base === null) return null
    return {
      engine: 'scrcpy',
      down: (x, y, pointerId = 0) => channel.pushTouch({ ...base, action: TOUCH_ACTION.DOWN, x: Math.round(x), y: Math.round(y), pointerId }),
      move: (x, y, pointerId = 0) => channel.pushTouch({ ...base, action: TOUCH_ACTION.MOVE, x: Math.round(x), y: Math.round(y), pointerId }),
      up: (x, y, pointerId = 0) => channel.pushTouch({ ...base, action: TOUCH_ACTION.UP, x: Math.round(x), y: Math.round(y), pointerId, pressure: 0, buttons: 0 }),
    }
  }

  /**
   * 拿一台设备的镜像，没有就建。
   * @param {string} serial - 序列号。
   * @returns {Mirror} 镜像。
   */
  /**
   * 拿一台设备的持续推流，没有就建。和抓帧的 Mirror 并行，互不影响。
   * @param {string} serial - 序列号。
   * @returns {LiveStream} 推流。
   */
  function streamFor(serial) {
    let stream = streams.get(serial)
    if (stream === undefined) {
      stream = new LiveStream({
        serial,
        adb: tools.adb.path,
        /* 有低延迟通道就用它的 H.264：连续出帧、少一个设备编码器；没就绪退回 screenrecord。 */
        sourceReady: () => channelFor(serial),
        /* 通道还在连的时候等它一下（≤2.5s），别先起 screenrecord 再切。 */
        sourceWait: (ms) => waitSource(serial, ms),
        sourceState: () => channelState(serial),
      })
      /* 空闲回收前先问一句：镜像还有人在看（/live 常连或刚拉过帧）就别停。 */
      stream.stillWanted = () => {
        const mirror = mirrors.get(serial)
        return mirror !== undefined && mirror.anyoneWatching()
      }
      streams.set(serial, stream)
    }
    return stream
  }

  function mirrorFor(serial) {
    let mirror = mirrors.get(serial)
    if (mirror === undefined) {
      mirror = new Mirror(serial, tools.adb)
      mirror.bridgeFresh = () => streamFor(serial).jpegFresh()
      mirrors.set(serial, mirror)
    }
    return mirror
  }

  /** 通知所有页面：打开「实时ADB」这一栏。 @returns {number} 通知到几个页面。 */
  function open(sessionId) {
    const wanted = String(sessionId ?? '')
    /* 没有明确的目标会话就不广播：广播出去只可能落到「当前可见」的那一栏，也就是别的会话。 */
    if (wanted === '') return 0
    wantSession = wanted
    wantAt = Date.now()
    wantTitle = ''
    /* 标题只用来兜底认窗口：有些窗口是多栏的，mounted 报的是另一栏的会话。 */
    try {
      const listed = ctx.get?.('sessionController')?.list?.()
      void Promise.resolve(listed).then((value) => {
        const bare = wantSession.replace(/^session-/, '')
        const hit = (value?.items ?? []).find((item) => {
          const full = String(item.sessionId)
          return full === wantSession || full.replace(/^session-/, '') === bare || full.endsWith(bare)
        })
        const title = hit?.projections?.values?.title
        if (typeof title === 'string' && title !== '') wantTitle = title
      }).catch(() => {})
    } catch { /* 列不出来就只认 mounted */ }
    let sent = 0
    for (const res of events) {
      try {
        res.write(`data: ${JSON.stringify({ type: 'open', sessionId: sessionId ?? '', at: Date.now() })}\n\n`)
        sent += 1
      } catch {
        events.delete(res)
      }
    }
    return sent
  }

  /**
   * 把标注过的画面推进聊天：人画的圈 + 圈里的控件 + 一句话。
   * @param {{ session: string, note: string, png: string, rect: any, serial: string }} input - 客户端发来的标注。
   * @returns {Promise<{ ok: boolean, reason?: string, bytes: number }>} 结果。
   */
  async function annotate(input) {
    let session = String(input.session ?? '')
    const base64 = String(input.png ?? '')
    const wantsRecent = input.recent === true
    if (session === '') return { ok: false, reason: '缺少会话', bytes: 0 }
    if (base64 === '' && !wantsRecent) return { ok: false, reason: '缺少画面', bytes: 0 }
    const png = base64 === '' ? Buffer.alloc(0) : Buffer.from(base64, 'base64')
    if (png.length === 0 && !wantsRecent) return { ok: false, reason: '画面为空', bytes: 0 }
    if (png.length > MAX_INJECT_BYTES) return { ok: false, reason: `画面超过 ${MAX_INJECT_BYTES / 1024 / 1024}MB`, bytes: png.length }
    /* 会话 id 可能来自工具结果的短形式，宿主认的是 session-<uuid>：按登记表补全，别让一次就对不上的 id 白丢一张标注。 */
    const sessionController = ctx.get?.('sessionController')
    try {
      const items = (await sessionController.list()).items ?? []
      const bare = session.replace(/^session-/, '')
      const known = items.find((item) => String(item.sessionId) === session)
        ?? items.find((item) => String(item.sessionId).replace(/^session-/, '') === bare)
      if (known !== undefined) session = String(known.sessionId)
    } catch { /* 列不出来就按原样试一次 */ }
    const controller = ctx.get?.('sessionController')
    const writable = controller?.prompt !== undefined
    const rect = input.rect ?? null
    const lines = []
    const note = String(input.note ?? '').trim()
    if (note !== '') lines.push(note)
    if (rect !== null && Number(rect.w) > 0) {
      lines.push(`圈选区域（设备坐标）：x=${Math.round(rect.x)} y=${Math.round(rect.y)} w=${Math.round(rect.w)} h=${Math.round(rect.h)}`)
    }
    /* 圈是画在冻结帧上的：把「画面是几秒前的」交出去，免得把那一刻的控件位置当成现在。 */
    const frozenMs = Number(input.frozen_ms)
    if (Number.isFinite(frozenMs) && frozenMs >= 1) {
      lines.push(`这张图是一张 ${(frozenMs / 1000).toFixed(1)} 秒前冻结的画面，圈的位置以那一帧为准。`)
    }
    if (tools.uiInRect !== undefined && rect !== null) {
      const inside = await tools.uiInRect(String(input.serial ?? ''), rect).catch(() => [])
      if (inside.length > 0) lines.push(`圈选区域内的控件：\n${inside.join('\n')}`)
    }
    const timeline = typeof tools.recentActions === 'function' ? tools.recentActions(90_000) : []
    if (timeline.length > 0) lines.push(`圈选前的操作（时间倒推）：\n${timeline.join('\n')}`)
    /* 用户圈一下不说话时，「刚才设备上发生了什么」才是能对上他意思的那条线。 */
    if (typeof tools.deviceStory === 'function') {
      const story = await tools.deviceStory(String(input.serial ?? ''), 120_000).catch(() => [])
      if (story.length > 0) lines.push(`最近这台设备上发生的事：\n${story.join('\n')}`)
    }
    const strip = await mirrorFor(String(input.serial ?? '')).recentStrip(6).catch(() => null)
    lastStripBytes = strip?.length ?? 0
    if (strip !== null) {
      lines.push(`最近 6 秒的画面（每张间隔约 1 秒，左上→右下，看动效比例/位移是否连贯）：`)
    }
    if (!writable) return { ok: false, reason: '会话不在可写入状态', bytes: png.length, strip: strip?.length ?? 0 }
    if (lines.length === 0) lines.push(wantsRecent ? '请看一下最近几秒的画面。' : '标注了一张设备画面。')
    const content = [{ type: 'text', text: lines.join('\n') }]
    if (png.length > 0) content.push({ type: 'image', mediaType: 'image/png', data: png.toString('base64'), name: 'device-annotated.png' })
    if (strip !== null) content.push({ type: 'image', mediaType: 'image/png', data: strip.toString('base64'), name: 'device-recent-frames.png' })
    try {
      await controller.prompt({
        requestId: `adb-mirror-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sessionId: session,
        mode: 'queue',
        content,
      }, new AbortController().signal)
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error).slice(0, 200), bytes: png.length }
    }
    if (png.length > 0) {
      /* 发成功才落盘：失败时不留一堆没人看过的标注图。 */
      await mkdir(join(ROOT, 'annotations'), { recursive: true }).catch(() => {})
      await writeFile(join(ROOT, 'annotations', `adb-${Date.now()}.png`), png).catch(() => {})
    }
    return { ok: true, bytes: png.length, strip: strip?.length ?? 0 }
  }

  /**
   * 一次性探针：宿主里会话控制器长什么样、认哪些 id。仅回环，调试用。
   * @returns {Promise<any>} 控制器方法名与已注册会话 id 样本。
   */
  async function sessionProbe() {
    const controller = ctx.get?.('sessionController')
    if (controller === undefined) return { ok: false, reason: '没有 sessionController' }
    const names = []
    let proto = Object.getPrototypeOf(controller)
    while (proto !== null && proto !== Object.prototype && names.length < 60) {
      for (const name of Object.getOwnPropertyNames(proto)) if (!names.includes(name)) names.push(name)
      proto = Object.getPrototypeOf(proto)
    }
    const own = Object.getOwnPropertyNames(controller).slice(0, 40)
    try {
      const agents = controller.agents
      const keys = agents instanceof Map ? [...agents.keys()] : Object.keys(agents ?? {})
      out.agentIds = keys.slice(0, 8)
      out.agentCount = keys.length
    } catch { /* 探不到就算了 */ }
    const out = { ok: true, names, own }
    for (const key of ['list', 'snapshot', 'sessions', 'get', 'states']) {
      try {
        const value = controller[key]
        out[`type:${key}`] = typeof value
        if (typeof value === 'function') {
          const result = await value.call(controller)
          out[`call:${key}`] = JSON.stringify(result).slice(0, 900)
        }
      } catch (error) {
        out[`call:${key}`] = `ERR ${String(error?.message ?? error).slice(0, 120)}`
      }
    }
    return out
  }

  /**
   * 读 JSON 请求体。
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @param {number} limit - 字节上限。
   * @returns {Promise<any>} 解析后的对象。
   */
  function readJson(req, limit = 24 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(new Error('请求过大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
        } catch {
          resolve({})
        }
      })
      req.on('error', reject)
    })
  }

  /**
   * 一条 adb input 命令。
   * @param {string} serial - 设备。
   * @param {string[]} args - input 之后的参数。
   * @returns {Promise<{ ok: boolean, reason?: string }>} 结果。
   */
  /* 快通道要数字 keycode；没收录的名字就退回 adb。 */
  const KEYCODE_BY_NAME = Object.freeze({
    HOME: 3, BACK: 4, CALL: 5, ENDCALL: 6, VOLUME_UP: 24, VOLUME_DOWN: 25, POWER: 26,
    CAMERA: 27, TAB: 61, ENTER: 66, DEL: 67, MENU: 82, NOTIFICATION: 83, SEARCH: 84,
    MEDIA_PLAY_PAUSE: 85, MEDIA_STOP: 86, MEDIA_NEXT: 87, MEDIA_PREVIOUS: 88,
    PAGE_UP: 92, PAGE_DOWN: 93, APP_SWITCH: 187, WAKEUP: 224, SLEEP: 223,
    ESCAPE: 111, SPACE: 62, DPAD_UP: 19, DPAD_DOWN: 20, DPAD_LEFT: 21, DPAD_RIGHT: 22,
    DPAD_CENTER: 23, MOVE_HOME: 122, FORWARD_DEL: 112,
  })

  async function input(serial, args) {
    const result = await tools.adb(['-s', serial, 'shell', 'input', ...args], { timeout: 8000 })
    if (!result.ok) return { ok: false, reason: result.err.slice(0, 200) || 'adb 执行失败' }
    return { ok: true }
  }

  /* 触摸屏直写：一条 input_event 24 字节（arm64：tv_sec i64 / tv_usec i64 /
     type u16 / code u16 / value i32）。逐条 sendevent 在端上约 14 ms 一条，
     一次两指捏合 30 条就要 0.4 s 以上；同一个手势拼成二进制流写设备节点，
     14 帧实测 178 ms（含节拍），快一个量级，而且是设备上唯一能做多指的路子。 */
  const touchNodes = new Map()

  /** 一条 input_event。 */
  function event24(type, code, value) {
    const buf = Buffer.alloc(24)
    buf.writeUInt16LE(type, 16)
    buf.writeUInt16LE(code, 18)
    buf.writeInt32LE(value, 20)
    return buf
  }

  /** 设备开机秒数，注入事件的时间戳从它往前推。 */
  async function uptime(serial) {
    const read = await tools.adb(['-s', serial, 'shell', 'cat', '/proc/uptime'], { timeout: 6000, direct: true })
    const hit = /([\d.]+)/.exec(String(read.out ?? ''))
    return hit === null ? 0 : Number(hit[1])
  }

  /**
   * 给一帧里的每条事件写同一个时间戳。内核按时间戳排序，全零会被当成远古事件。
   * @param {Buffer} frame - 该帧字节。
   * @param {number} at - 开机秒数。
   * @returns {Buffer} 同一段字节，已写好时间。
   */
  function stampFrame(frame, at) {
    const seconds = Math.floor(at)
    const micros = Math.round((at - seconds) * 1e6)
    for (let offset = 0; offset + 24 <= frame.length; offset += 24) {
      frame.writeBigInt64LE(BigInt(seconds), offset)
      frame.writeBigInt64LE(BigInt(micros), offset + 8)
    }
    return frame
  }

  /**
   * 屏幕坐标换算成面板坐标。触摸面板固定在竖屏原生方向，画面一转就得换轴，
   * 换了轴还要定镜像方向，差了就是「点哪儿都不对」。
   * @param {{ w: number, h: number }} screen - 当前画面尺寸。
   * @param {{ ax: number, ay: number }} range - ABS 量程。
   * @param {number} rotation - 0 / 90 / 180 / 270。
   * @returns {(x: number, y: number) => { x: number, y: number }} 换算函数。
   */
  function mapper(screen, range, rotation) {
    const { w, h } = screen
    if (rotation === 90) {
      return (x, y) => ({ x: ((h - y) / h) * range.ax, y: (x / w) * range.ay })
    }
    if (rotation === 270) {
      return (x, y) => ({ x: (y / h) * range.ax, y: ((w - x) / w) * range.ay })
    }
    if (rotation === 180) {
      return (x, y) => ({ x: ((w - x) / w) * range.ax, y: ((h - y) / h) * range.ay })
    }
    return (x, y) => ({ x: (x / w) * range.ax, y: (y / h) * range.ay })
  }

  /** 当前画面方向，走一次 dumpsys，实测 30 ms。 */
  async function rotationOf(serial) {
    const result = await tools.adb(['-s', serial, 'shell',
      'dumpsys window 2>/dev/null | grep -m1 -oE "mRotation=.{0,12}"'], { timeout: 8000, direct: true })
    if (!result.ok) return 0
    const hit = /ROTATION_(\d+)/.exec(String(result.out))
    return hit === null ? 0 : Number(hit[1]) % 360
  }

  /**
   * 找触摸屏节点和 ABS 量程，每台设备只探一次。
   * @param {string} serial - 设备。
   * @returns {Promise<{ node: string, ax: number, ay: number } | null>} 节点与量程。
   */
  async function touchInfo(serial) {
    if (touchNodes.has(serial)) return touchNodes.get(serial)
    const scan = await tools.adb(['-s', serial, 'shell',
      'grep -ilE "touchscreen|capacitive" /sys/class/input/event*/device/name'], { timeout: 8000, direct: true })
    if (!scan.ok) return null
    const rows = String(scan.out).split('\n').map((line) => line.trim()).filter((line) => line.endsWith('/name'))
    if (rows.length === 0) return null
    /* 一部机器上常有两三个带 Touch 的节点（手写笔、虚拟键），电容屏才是要写的那个。 */
    const event = /event\d+/.exec(rows[0])
    if (event === null) return null
    const node = '/dev/input/' + event[0]
    const detail = await tools.adb(['-s', serial, 'shell', 'getevent', '-p', node], { timeout: 8000, direct: true })
    if (!detail.ok) return null
    const size = (code) => {
      const hit = new RegExp('^\\s*' + code + '\\s*:.*max\\s+(\\d+)', 'm').exec(String(detail.out))
      return hit === null ? 0 : Number(hit[1])
    }
    const info = { node, ax: size('0035'), ay: size('0036') }
    if (info.ax < 1 || info.ay < 1) return null
    touchNodes.set(serial, info)
    return info
  }

  /**
   * 一帧触摸数据，末尾一条 SYN_REPORT 收帧。
   * @param {Array<{ slot: number, id: number, x: number, y: number }>} points - 该帧面板坐标；id 为 -1 表示抬起。
   * @returns {Buffer} 该帧字节。
   */
  function touchFrame(points, touch) {
    const parts = []
    for (const point of points) {
      parts.push(event24(3, 47, point.slot))
      parts.push(event24(3, 57, point.id))
      if (point.id < 0) continue
      parts.push(event24(3, 53, Math.round(point.x)))
      parts.push(event24(3, 54, Math.round(point.y)))
      parts.push(event24(3, 58, 100))
    }
    if (touch === 1) parts.push(event24(1, 330, 1))
    if (touch === 0) parts.push(event24(1, 330, 0))
    parts.push(event24(0, 0, 0))
    return Buffer.concat(parts)
  }

  /**
   * 把整段帧按节拍写进设备：一次 shell 常驻，端上零进程开销。
   * @param {string} serial - 设备。
   * @param {Buffer[]} frames - 每帧字节。
   * @param {number} ms - 整段时长。
   * @param {string} node - 触摸屏节点。
   * @returns {Promise<{ ok: boolean, reason?: string }>} 结果。
   */
  async function injectFrames(serial, frames, ms, node) {
    const step = Math.max(4, Math.round(ms / Math.max(1, frames.length)))
    const start = (await uptime(serial)) + 0.05
    return new Promise((resolve) => {
      const child = spawn(tools.adb.path, ['-s', serial, 'shell', 'cat > ' + node], { stdio: ['pipe', 'ignore', 'ignore'] })
      let index = 0
      let done = false
      const finish = (result) => {
        if (done) return
        done = true
        resolve(result)
      }
      child.on('error', (error) => finish({ ok: false, reason: String(error && error.message ? error.message : error).slice(0, 200) }))
      child.on('exit', (code) => finish(code === 0 ? { ok: true } : { ok: false, reason: '退出码 ' + code }))
      const tick = () => guard('gesture-tick', () => {
        if (index >= frames.length) {
          child.stdin.end()
          return
        }
        child.stdin.write(stampFrame(frames[index], start + (index * step) / 1000))
        index += 1
        setTimeout(tick, step)
      })
      tick()
      setTimeout(() => guard('gesture-timeout', () => {
        if (done) return
        child.kill('SIGKILL')
        finish({ ok: false, reason: '注入超时' })
      }), ms + 4000)
    })
  }

  /**
   * 多指手势：每条轨迹是若干屏幕坐标点，所有轨迹同节拍推进，先全部抬起收尾。
   * @param {string} serial - 设备。
   * @param {number[][]} tracks - 每条轨迹的点列 [[x, y], ...]。
   * @param {number} ms - 时长。
   * @returns {Promise<{ ok: boolean, reason?: string }>} 结果。
   */
  async function gesture(serial, tracks, ms) {
    const info = await touchInfo(serial)
    if (info === null) return { ok: false, reason: '没有找到触摸屏' }
    const rotation = await rotationOf(serial)
    let screen = mirrorFor(serial).screen
    if (screen === undefined || screen.w < 1 || screen.h < 1) {
      /* 刚连上还没出画面时没有画面尺寸，退回物理尺寸再按方向换轴。 */
      const probed = await tools.adb(['-s', serial, 'shell', 'wm', 'size'], { timeout: 6000, direct: true })
      const found = /(\d+)x(\d+)/.exec(String(probed.out ?? ''))
      if (found === null) return { ok: false, reason: '屏幕尺寸还没读到' }
      const w = Number(found[1])
      const h = Number(found[2])
      screen = rotation === 90 || rotation === 270 ? { w: h, h: w } : { w, h }
    }
    const map = mapper(screen, info, rotation)
    const count = Math.max(2, Math.min(40, Math.round(ms / 16)))
    const frames = []
    for (let index = 0; index <= count; index += 1) {
      const t = index / count
      const points = []
      tracks.forEach((track, slot) => {
        const raw = Math.min(track.length - 1, Math.round(t * (track.length - 1)))
        const point = map(track[raw][0], track[raw][1])
        points.push({ slot, id: 700 + slot, x: point.x, y: point.y })
      })
      frames.push(touchFrame(points, index === 0 ? 1 : undefined))
    }
    frames.push(touchFrame(tracks.map((_, slot) => ({ slot, id: -1, x: 0, y: 0 })), 0))
    return injectFrames(serial, frames, ms, info.node)
  }

  /**
   * 两指捏合 / 张开。
   * @param {string} serial - 设备。
   * @param {number} x - 中心点。
   * @param {number} y - 中心点。
   * @param {number} from - 起始两指间距。
   * @param {number} to - 结束间距。
   * @param {number} ms - 时长。
   * @returns {Promise<{ ok: boolean, reason?: string }>} 结果。
   */
  function pinch(serial, x, y, from, to, ms) {
    const ease = (t) => 1 - (1 - t) * (1 - t)
    const at = (gap) => [
      [x, y - gap / 2],
      [x, y + gap / 2],
    ]
    const trackA = []
    const trackB = []
    const steps = 12
    for (let index = 0; index <= steps; index += 1) {
      const gap = from + (to - from) * ease(index / steps)
      const pair = at(gap)
      trackA.push(pair[0])
      trackB.push(pair[1])
    }
    return gesture(serial, [trackA, trackB], ms)
  }

  /**
   * 只认本机回环 + 同源：侧栏页面在 127.0.0.1 直连，别的网页没法借道操设备。
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @returns {boolean} 是否放行。
   */
  function isLocal(req) {
    const peer = req.socket?.remoteAddress ?? ''
    if (peer !== '127.0.0.1' && peer !== '::1' && peer !== '::ffff:127.0.0.1') return false
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '')
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]' && host !== '::1') return false
    if (req.method === 'GET' || req.method === 'HEAD') return true
    const origin = String(req.headers.origin ?? '')
    if (origin === '') return req.headers['sec-fetch-site'] === undefined || req.headers['sec-fetch-site'] === 'same-origin'
    try {
      return new URL(origin).host === String(req.headers.host ?? '')
    } catch {
      return false
    }
  }

  /** @param {import('node:http').IncomingMessage} req - 请求。 @param {import('node:http').ServerResponse} res - 响应。 */
  async function handler(req, res) {
    const url = new URL(req.url ?? ROUTE, 'http://dsh.invalid')
    const path = url.pathname.slice(ROUTE.length) || '/'
    const json = (value, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    if (!isLocal(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('forbidden')
      return
    }
    try {
      if (path === '/' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(PLAYER_HTML)
      }

      if (path === '/events' && req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        res.write('retry: 2000\n\n')
        events.add(res)
        res.write(`data: ${JSON.stringify({ type: 'hello', at: Date.now() })}\n\n`)
        const beat = setInterval(() => {
          try { res.write(': beat\n\n') } catch { events.delete(res) }
        }, 15_000)
        beat.unref?.()
        const close = () => {
          clearInterval(beat)
          events.delete(res)
        }
        req.on('close', close)
        res.on('error', close)
        return
      }

      if (path === '/devices' && req.method === 'GET') {
        const serial = await tools.resolveSerial().catch(() => '')
        const list = await tools.adb(['devices'], { timeout: 5000 })
        const rows = String(list.out ?? '')
          .split('\n')
          .slice(1)
          .map((line) => line.trim())
          .filter((line) => line !== '' && line.endsWith('device'))
          .map((line) => line.split(/\s+/)[0])
        return json({ serial, devices: rows })
      }

      if (path === '/live' && req.method === 'GET') {
        const serial = url.searchParams.get('serial') || await tools.resolveSerial()
        const mirror = mirrorFor(serial)
        res.writeHead(200, {
          'content-type': 'multipart/x-mixed-replace; boundary=frame',
          'cache-control': 'no-store, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        res.flushHeaders()
        mirror.watchers.add(res)
        const frame = mirror.latest ?? await mirror.firstFrame(4000)
        if (frame !== null) writeFrame(res, frame, () => mirror.watchers.delete(res))
        void mirror.start()
        const close = () => mirror.watchers.delete(res)
        req.on('close', close)
        res.on('error', close)
        return
      }

      if (path === '/stream' && req.method === 'GET') {
        const serial = url.searchParams.get('serial') || await tools.resolveSerial()
        const stream = streamFor(serial)
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'cache-control': 'no-store, no-transform',
          'x-accel-buffering': 'no',
          connection: 'keep-alive',
        })
        res.flushHeaders()
        let closed = false
        /* 先占位再订阅：subscribe 可能同步补发初始化段，那时 unsubscribe 还没赋值。 */
        let unsubscribe = () => {}
        const close = () => {
          if (closed) return
          closed = true
          try {
            unsubscribe()
          } catch {
            /* 退订本身不能再往外抛：这条链路已经在收尾了。 */
          }
        }
        /* 清理必须先挂上：subscribe 里同步补发初始化段可能抛（对端已断），
           一旦抛在挂清理之前，这个观众就永远留在 waiting 里，采集链路会被反复重建。 */
        req.on('close', close)
        res.on('close', close)
        res.on('error', close)
        req.socket?.on('close', close)
        try {
          unsubscribe = stream.subscribe((bytes) => {
            if (closed) return
            /* 积压超过 2 MB 就断开重连：宁可重连一次，也不要让延迟越滚越大。 */
            if (res.writableLength > 2 << 20) {
              close()
              res.destroy()
              return
            }
            res.write(bytes)
          })
        } catch (error) {
          this?.logger?.warn?.('stream 订阅失败：' + String(error?.message ?? error))
          close()
          res.destroy()
        }
        return
      }

      if (path === '/stream/info' && req.method === 'GET') {
        const serial = url.searchParams.get('serial') || await tools.resolveSerial()
        return json(streamFor(serial).info())
      }

      /* 调试用：看设备最近发生了什么（和标注回传给模型的是同一份人话时间线）。 */
      if (path === '/story') {
        const serial = url.searchParams.get('serial') || await tools.resolveSerial()
        const lines = await tools.deviceStory(serial, 180_000).catch(() => [])
        return json({ serial, lines })
      }

      /* 调试用：把推流和采集通道立刻收掉，省得为了测冷启动等两分钟宽限。
         必须显式 confirm=1，避免误触。 */
      if (path === '/stream/stop' && url.searchParams.get('confirm') === '1') {
        const stopped = []
        for (const [serial, stream] of streams) {
          try {
            stream.stop()
            stopped.push(serial)
          } catch {
            /* 单台收尾失败不影响其它 */
          }
        }
        for (const [serial, entry] of channels) {
          try {
            entry.channel?.stop?.()
            entry.ready = null
            entry.channel = null
            entry.starting = false
            /* 显式停止就是「从头再来」：连失败冷却一起清掉，别让下一次开流白白退回录屏。 */
            entry.failed = false
            entry.failedAt = 0
          } catch {
            /* 同上 */
          }
        }
        return json({ stopped })
      }

      if (path === '/dev/mse' && req.method === 'GET' && DEV === true) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(DEV_MSE_PAGE)
        return
      }
      if (path === '/watching') {
        const serial = url.searchParams.get('serial') || await tools.resolveSerial()
        const mirror = mirrorFor(serial)
        mirror.lastWatchAt = Date.now()
        void mirror.start()
        return json({ watching: true })
      }

      if (path === '/frame' && req.method === 'GET') {
        const serial = url.searchParams.get('serial') || await tools.resolveSerial()
        const mirror = mirrorFor(serial)
        mirror.lastWatchAt = Date.now()
        const starting = mirror.start()
        const since = Number(url.searchParams.get('since') ?? '') || 0
        const wait = Math.min(2500, Math.max(0, Number(url.searchParams.get('wait') ?? '') || 0))
        /* H.264 桥接：screenrecord 已经在跑，让 ffmpeg 把它解成 JPEG 喂进同一个帧池。
           实测 screencap 一帧 867 ms，桥接后是解码延迟（几十毫秒），帧率上限也不再是 1 fps。 */
        const stream = streamFor(serial)
        void stream.enableJpeg()
        /* 录屏尺寸必须跟设备真实竖屏比例一致：横着录出来的帧和抓帧帧比例不同，画面会一大一小跳。 */
        void starting.then(() => {
          if (mirror.physical.w > 0) stream.configure(mirror.physical.w, mirror.physical.h)
          void stream.enableJpeg()
          /* 录屏到时长会停；每次有人拉帧都把它续上，否则画面就只剩抓帧那一路。 */
          void stream.start()
          /* start() 会清空闲定时器，所以续命之后重新排一次：面板关掉 20 秒后自动停录。 */
          stream.scheduleIdleStop()
        })
        const pump = () => {
          const jpeg = stream.jpeg
          if (jpeg !== null && stream.jpegAt > mirror.latestAt) mirror.accept(Buffer.from(jpeg))
        }
        let pumpTimer = null
        if (stream.jpegChild !== null) {
          pump()
          pumpTimer = setInterval(pump, 40)
          pumpTimer.unref?.()
        }
        let frame = null
        try {
          if (wait > 0) {
            if (mirror.seq === 0) frame = await mirror.firstFrame(4000)
            if (frame === null) frame = await mirror.nextFrame(since, wait)
          } else {
            frame = await mirror.firstFrame(4000)
            if (frame !== null && Date.now() - mirror.latestAt > 1200 && !stream.jpegFresh()) frame = (await mirror.snapshot()) ?? frame
          }
        } finally {
          if (pumpTimer !== null) clearInterval(pumpTimer)
        }
        if (frame === null) return json({ error: '画面还没起来' }, 503)
        res.writeHead(200, {
          'content-type': 'image/jpeg',
          'cache-control': 'no-store',
          'x-adb-seq': String(mirror.seq),
          'x-adb-at': String(mirror.latestAt),
          'x-adb-engine': stream.jpegFresh() ? 'h264' : 'capture',
        })
        return res.end(frame)
      }

      if (path === '/state' && req.method === 'GET') {
        const serial = url.searchParams.get('serial') || await tools.resolveSerial()
        const mirror = mirrorFor(serial)
        void mirror.start()
        const segments = await mirror.segments()
        return json({
          serial,
          build: CLIENT_BUILD,
          stream: (streams.get(serial) ?? null)?.info() ?? null,
          /* 低延迟通道状态：ready 就代表注入走 socket 写，不再吃 adb 往返。 */
          fastInput: (() => {
            const entry = channels.get(serial)
            if (entry === undefined) return { state: 'idle' }
            if (entry.failed === true) return { state: 'fallback' }
            if (entry.ready !== null) return { state: 'ready', port: Number(entry.channel?._options?.port) || 0 }
            return { state: entry.starting === true ? 'starting' : 'idle' }
          })(),
          started: mirror.startedAt,
          frames: mirror.frames,
          fps: mirror.measuredFps(),
          live: mirror.latest !== null,
          watchers: mirror.watchers.size,
          /* 录制是后台行为：状态里如实报，别让人以为没人看时也在录。 */
          recording: mirror.recording,
          dropped: mirror.dropped,
          grabMs: mirror.grabMs,
          pushed: mirror.pushed,
          screen: mirror.screen,
          frame: mirror.latest === null ? null : { w: mirror.frameSize.w, h: mirror.frameSize.h },
          bytes: mirror.latest?.length ?? 0,
          recent: mirror.recent.length,
          strip: lastStripBytes,
          segments: segments.length,
          bufferedSeconds: segments.length * SEGMENT_SECONDS,
          dir: mirror.dir,
          error: mirror.error,
          pages: events.size,
          want: wantSession,
          clients: [...clients.values()].map(({ pid, at, mounted, title, beat, lag_ms }) => ({ pid, at, mounted, title, beat, lag_ms })),
          diag,
        })
      }

      if (path === '/recent' && req.method === 'GET') {
        const serial = url.searchParams.get('serial') || await tools.resolveSerial()
        const mirror = mirrorFor(serial)
        return json({ serial, segments: await mirror.segments(), dir: mirror.dir })
      }

      if (path === '/tap' && req.method === 'POST') {
        const body = await readJson(req)
        const serial = String(body.serial ?? '')
        note(`${body.long === true ? '长按' : '点击'} ${Math.round(Number(body.x))},${Math.round(Number(body.y))}`)
        const fast = await scrcpyTap(serial, Number(body.x), Number(body.y), { long: body.long === true })
        if (fast !== null) return json(fast)
        const x = String(Math.round(body.x))
        const y = String(Math.round(body.y))
        /* 长按用同点 swipe 顶住 700 ms：input 没有 longpress 子命令。 */
        const args = body.long === true ? ['swipe', x, y, x, y, '700'] : ['tap', x, y]
        return json(await input(serial, args))
      }

      if (path === '/scroll' && req.method === 'POST') {
        const body = await readJson(req)
        const serial = String(body.serial ?? '')
        const x = Math.round(Number(body.x ?? 0))
        const y = Math.round(Number(body.y ?? 0))
        const dy = Math.max(-4000, Math.min(4000, Number(body.dy ?? 0)))
        if (serial === '' || dy === 0) return json({ ok: false, reason: '缺少参数' })
        /* 滚轮向下 = 内容上移，手指就从下往上滑。 */
        const span = Math.max(60, Math.min(900, Math.abs(dy)))
        const from = dy > 0 ? y + span / 2 : y - span / 2
        const to = dy > 0 ? y - span / 2 : y + span / 2
        const ms = String(Math.max(120, Math.min(320, Math.round(span * 0.5))))
        const fast = await scrcpySwipe(serial, x, from, x, to, Number(ms))
        if (fast !== null) return json(fast)
        return json(await input(serial, ['swipe', String(x), String(Math.round(from)), String(x), String(Math.round(to)), ms]))
      }

      if (path === '/swipe' && req.method === 'POST') {
        const body = await readJson(req)
        note(`滑动 ${Math.round(Number(body.x1))},${Math.round(Number(body.y1))}→${Math.round(Number(body.x2))},${Math.round(Number(body.y2))}`)
        const fastSwipe = await scrcpySwipe(String(body.serial ?? ''), body.x1, body.y1, body.x2, body.y2, Number(body.ms ?? 300))
        if (fastSwipe !== null) return json(fastSwipe)
        return json(await input(String(body.serial ?? ''), [
          'swipe',
          String(Math.round(body.x1)), String(Math.round(body.y1)),
          String(Math.round(body.x2)), String(Math.round(body.y2)),
          String(Math.round(body.ms ?? 300)),
        ]))
      }

      if (path === '/gesture' && req.method === 'POST') {
        const body = await readJson(req)
        const serial = String(body.serial ?? '')
        if (serial === '') return json({ ok: false, reason: '缺少参数' })
        const tracks = Array.isArray(body.tracks) ? body.tracks : []
        const ok = tracks.length > 0 && tracks.length <= 5
          && tracks.every((track) => Array.isArray(track) && track.length > 1
            && track.every((point) => Array.isArray(point) && point.length === 2
              && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]))))
        if (!ok) return json({ ok: false, reason: '轨迹格式不对' })
        const ms = Math.max(16, Math.min(2000, Number(body.ms ?? 240)))
        const points = tracks.map((track) => track.map((point) => [Number(point[0]), Number(point[1])]))
        note(`手势 ${points.length} 指 ${ms}ms`)
        const fast = await scrcpyGesture(serial, points, ms)
        if (fast !== null) return json(fast)
        /* 回退路径慢一个数量级（实测 172ms vs 20ms），必须把用的哪条路说清楚。 */
        const slow = await gesture(serial, points, ms)
        return json({ ...slow, engine: slow.engine ?? 'adb-input' })
      }

      if (path === '/raw' && req.method === 'POST') {
        const body = await readJson(req)
        const serial = String(body.serial ?? '')
        if (serial === '') return json({ ok: false, reason: '缺少参数' })
        const ms = Math.max(16, Math.min(2000, Number(body.ms ?? 200)))
        const points = [[
          [Number(body.x1 ?? 0), Number(body.y1 ?? 0)],
          [Number(body.x2 ?? 0), Number(body.y2 ?? 0)],
        ]]
        const fast = await scrcpyGesture(serial, points, ms)
        if (fast !== null) return json(fast)
        /* 回退路径慢一个数量级（实测 172ms vs 20ms），必须把用的哪条路说清楚。 */
        const slow = await gesture(serial, points, ms)
        return json({ ...slow, engine: slow.engine ?? 'adb-input' })
      }

      if (path === '/pinch' && req.method === 'POST') {
        const body = await readJson(req)
        const serial = String(body.serial ?? '')
        if (serial === '') return json({ ok: false, reason: '缺少参数' })
        const num = (value, fallback) => {
          const n = Number(value)
          return Number.isFinite(n) ? n : fallback
        }
        const from = Math.max(40, Math.min(1600, num(body.from, 520)))
        const to = Math.max(40, Math.min(1600, num(body.to, 140)))
        const ms = Math.max(80, Math.min(1200, num(body.ms, 280)))
        return json(await pinch(serial, num(body.x, 0), num(body.y, 0), from, to, ms))
      }

      if (path === '/text' && req.method === 'POST') {
        const body = await readJson(req)
        const serial = String(body.serial ?? '')
        const text = String(body.text ?? '').slice(0, 400)
        if (serial === '' || text === '') return json({ ok: false, reason: '缺少参数' })
        note(`输入 ${text.length} 字`)
        if (/[^\x20-\x7e]/.test(text)) {
          /* 中文没有 input text 可用：剪贴板 + 长按粘贴，由宿主传下来。 */
          try {
            return json(await tools.typeText(serial, text))
          } catch (error) {
            return json({ ok: false, reason: String(error && error.message ? error.message : error).slice(0, 200) })
          }
        }
        /* adb input 的坑：空格要写成 %s，其余空格类字符一律换掉，否则整句被截断。 */
        const escaped = text.replace(/\\/g, '\\\\').replace(/ /g, '%s').replace(/\s+/g, '%s').replace(/['"]/g, '')
        return json(await input(serial, ['text', escaped]))
      }

      if (path === '/key' && req.method === 'POST') {
        const body = await readJson(req)
        const serial = String(body.serial ?? '')
        const name = String(body.key ?? 'BACK').toUpperCase()
        note(`按键 ${name}`)
        const keycode = Number.isFinite(Number(body.keycode)) ? Number(body.keycode) : KEYCODE_BY_NAME[name]
        if (keycode !== undefined) {
          const fast = await scrcpyKey(serial, keycode, { holdMs: Number(body.holdMs) || 0 })
          if (fast !== null) return json(fast)
        }
        return json(await input(serial, ['keyevent', name]))
      }

      if (path === '/want' && req.method === 'GET') {
        return json({ session: wantSession, at: wantAt, title: wantTitle, pages: events.size })
      }

      if (path === '/actions') {
        const ops = typeof tools.recentActions === 'function' ? tools.recentActions(120_000) : []
        return json({ at: Date.now(), actions: ops.slice(-5) })
      }

      if (path === '/diag' && req.method === 'GET') {
        /* 页面报上来的现场：没有 CDP 也能看见它看到的构建号、渲染异常、交互结果。 */
        return json({
          at: Date.now(),
          watchers: [...clients.values()].filter((each) => Date.now() - each.at < 120000).length,
          diag: diag.slice(-20),
        })
      }

      if (path === '/diag' && req.method === 'POST') {
        const body = await readJson(req)
        diag.push({ at: Date.now(), body })
        if (diag.length > 20) diag.shift()
        if (typeof body?.pid === 'string') clients.set(body.pid, { at: Date.now(), ...body })
        return json({ ok: true })
      }

      if (path === '/sessions' && DEV === true) {
        return json(await sessionProbe())
      }
      if (path === '/annotate' && req.method === 'POST') {
        return json(await annotate(await readJson(req)))
      }

      return json({ error: 'not found' }, 404)
    } catch (error) {
      return json({ error: String(error?.message ?? error).slice(0, 200) }, 500)
    }
  }

  const mount = (scope) => scope.effect(() => {
    const server = scope.get?.('webServer') ?? ctx.get?.('webServer')
    if (server?.register === undefined) return undefined
    return server.register({ kind: 'prefix', path: ROUTE, handler })
  }, 'adb: 实时镜像路由')
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], mount)
  else mount(ctx)

  /**
   * 把最新一帧存成 JPEG，给 agent 直接看图。
   * @param {string} serial - 设备。
   * @returns {Promise<{ ok: boolean, path?: string, bytes?: number, at?: number }>} 结果。
   */
  async function peek(serial) {
    const mirror = mirrorFor(serial)
    void mirror.start()
    const frame = await mirror.firstFrame(4000)
    if (frame === null) return { ok: false }
    const file = join(ROOT, `peek-${serial.replace(/[^\w.-]/g, '_')}.jpg`)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, frame)
    return { ok: true, path: file, bytes: frame.length, at: mirror.latestAt }
  }

  return {
    open,
    peek,
    /**
     * 侧栏正在直播时，内存里最新一帧可以直接当截图用：0ms，不碰设备。
     * @param {string} serial - 设备。
     * @returns {{ frame: Buffer, at: number } | null} 够新才给。
     */
    liveFrame(serial) {
      const mirror = mirrors.get(serial)
      if (mirror === undefined || mirror.latest === null) return null
      if (mirror.watchers.size === 0) return null
      if (Date.now() - mirror.latestAt > 2500) return null
      return { frame: mirror.latest, at: mirror.latestAt }
    },
    /**
     * 最近几秒的画面拼成一张 3x2 图：动效比例/位移这类问题看序列帧最快。
     * @param {string} serial - 设备。
     * @param {number} seconds - 回看秒数。
     * @returns {Promise<{ ok: boolean, path?: string, bytes?: number }>} 结果。
     */
    /**
     * 逐像素动效时间线：问「刚才那下哪里不协调」时用。
     * @param {string} serial - 设备。
     * @param {object} options - seconds / fps / region / threshold。
     * @returns {Promise<object | null>} 指标。
     */
    async motion(serial, options = {}) {
      return mirrorFor(serial).motionTimeline(options)
    },
    async recentStrip(serial, seconds = 6) {
      const mirror = mirrorFor(serial)
      const found = await mirror.recentStripWithSource(seconds)
      if (found === null) return { ok: false }
      const file = join(ROOT, `recent-${serial.replace(/[^\w.-]/g, "_")}-${Date.now()}.png`)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, found.png)
      return { ok: true, path: file, bytes: found.png.length, source: found.source, ageMs: found.ageMs }
    },
    async status(serial) {
      const chosen = serial ?? await tools.resolveSerial().catch(() => '')
      const mirror = mirrors.get(chosen)
      if (mirror === undefined) return { serial: chosen, live: false, frames: 0, segments: 0 }
      const segments = await mirror.segments()
      return {
        serial: chosen,
        live: mirror.latest !== null,
        recording: mirror.recording,
        frames: mirror.frames,
        fps: mirror.measuredFps(),
        bufferedSeconds: segments.length * SEGMENT_SECONDS,
        dir: mirror.dir,
      }
    },
    async segmentList(serial) {
      const chosen = serial ?? await tools.resolveSerial().catch(() => '')
      const mirror = mirrors.get(chosen)
      return mirror === undefined ? [] : mirror.segments()
    },
    stopAll() {
      /* 先停 H.264 直播：每个实例都有自己的设备端录屏和 ffmpeg 子进程，比抓帧泵重得多。
         只清 mirrors 会把这些子进程留在设备上继续录，卸载插件后还在跑。 */
      for (const stream of streams.values()) {
        try { stream.stop() } catch { /* 已经停了 */ }
      }
      streams.clear()
      for (const entry of channels.values()) {
        try { void entry.channel?.stop?.() } catch { /* 已经停了 */ }
      }
      channels.clear()
      fastInput.tap = null
      fastInput.swipe = null
      fastInput.gesture = null
      fastInput.key = null
      fastInput.raw = null
      for (const mirror of mirrors.values()) mirror.stop()
      mirrors.clear()
      for (const res of events) {
        try { res.end() } catch { /* 已断 */ }
      }
      events.clear()
    },
  }
}

/** 环形缓冲根目录，工具层汇报用。 */
export const MIRROR_ROOT = ROOT

/** 段长，工具层汇报用。 */
export const SEGMENT = { seconds: SEGMENT_SECONDS, keep: SEGMENT_KEEP, fps: LIVE_FPS }

/**
 * 【内部自测页】只在开发时用来验证 MSE 链路：打开 /dsh-mobile-use/dev/mse 就能自己订阅 /stream。
 * 产品界面走 client.js，这个页面不参与打包。
 */
const DEV_MSE_PAGE = `<!doctype html><meta charset="utf-8"><title>MSE probe</title>
<body style="margin:0;background:#111;color:#ddf;font:13px ui-monospace">
<video id="v" muted playsinline autoplay style="width:960px;height:640px;background:#000"></video>
<pre id="s">booting</pre>
<script>
const v = document.getElementById('v'), S = document.getElementById('s')
const q = new URLSearchParams(location.search)
const serial = q.get('serial') || ''
const t0 = performance.now()
let sb = null, queue = [], inits = 0, media = 0, shown = 0, first = 0, err = ''
function say() {
  const b = sb && sb.buffered.length > 0 ? sb.buffered.end(sb.buffered.length - 1) : 0
  S.textContent = ['ready', v.readyState, 't', v.currentTime.toFixed(2), 'buf', b.toFixed(2),
    'err', v.error ? v.error.code : 0,
    'init', inits, 'media', media, 'res', v.videoWidth + 'x' + v.videoHeight,
    'first', first ? Math.round(first) + 'ms' : '-', err].join(' ')
}
function reset() {
  sb = null; queue = []
  const ms = new MediaSource()
  ms.addEventListener('sourceopen', () => {
    sb = ms.addSourceBuffer('video/mp4; codecs="avc1.640020"')
    sb.mode = 'segments'
    sb.addEventListener('updateend', () => {
      if (queue.length > 0) push()
      else if (v.paused && sb.buffered.length > 0) v.play().catch(() => {})
    })
    push()
  }, { once: true })
  v.src = URL.createObjectURL(ms)
  v.play().catch(() => {})
}
function push() {
  if (sb === null || sb.updating || queue.length === 0) return
  try { sb.appendBuffer(queue.shift()) } catch (e) { err = 'append: ' + e.message }
}
v.addEventListener('loadeddata', () => { if (!shown) { shown = 1; first = performance.now() - t0 } })
async function run() {
  const res = await fetch('/dsh-mobile-use/stream?serial=' + encodeURIComponent(serial))
  const rd = res.body.getReader()
  let buf = new Uint8Array(0)
  for (;;) {
    const { value, done } = await rd.read()
    if (done) break
    const merged = new Uint8Array(buf.length + value.length)
    merged.set(buf); merged.set(value, buf.length); buf = merged
    for (;;) {
      if (buf.length < 5) break
      const len = new DataView(buf.buffer, buf.byteOffset).getUint32(1, false)
      if (buf.length < 5 + len) break
      const type = buf[0], body = buf.slice(5, 5 + len)
      buf = buf.slice(5 + len)
      if (type === 1) { inits += 1; reset(); queue.push(body) }
      else if (type === 2) { media += 1; queue.push(body); push() }
    }
  }
}
setInterval(() => { say(); if (v.paused && v.readyState > 0) v.play().catch(() => {}) }, 400)
reset()
run().catch((e) => { err = e.message })
</script>`
