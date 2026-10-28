/**
 * 持续推流：设备端 `screenrecord --output-format=h264` 出流，主进程用 ffmpeg 把裸流
 * 重排成分片 MP4（fMP4），浏览器用 MediaSource 边收边放。
 *
 * 和「定时抓 JPEG」相比，这条路的延迟只等于「屏幕变化 → 硬件编码 → 管道」，
 * 静止时几乎不产流量，也不需要客户端轮询；抓帧那 600~700 ms 的编码开销不存在了。
 *
 * 屏幕旋转或分辨率变化会让编码器重启，那时会换一段新的初始化段（moov），
 * 推给浏览器的帧头部会带上类型，让前端重建 MediaSource。
 */

import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 帧类型：0 文本元信息，1 初始化段，2 媒体分片，3 一条流结束（前端应重连）。 */
export const FRAME_META = 0
export const FRAME_INIT = 1
export const FRAME_MEDIA = 2
export const FRAME_END = 3

/** screenrecord 单个进程最长 180 s，留出余量后自动续。 */
const RECORD_LIMIT = 175

/**
 * 把一条消息封成 `[类型 1 B][长度 4 B BE][负载]`，前端照这个切包。
 * @param {number} type - 帧类型。
 * @param {Buffer} payload - 负载。
 * @returns {Buffer} 可写进响应体的缓冲。
 */
export function packFrame(type, payload) {
  const head = Buffer.allocUnsafe(5)
  head.writeUInt8(type, 0)
  head.writeUInt32BE(payload.length, 1)
  return Buffer.concat([head, payload], 5 + payload.length)
}

/**
 * 读无符号指数哥伦布码。
 * @param {number[]} bits - 比特数组。
 * @param {{pos: number}} cursor - 游标。
 * @returns {number} 值。
 */
function ue(bits, cursor) {
  let zeros = 0
  while (cursor.pos < bits.length && bits[cursor.pos] === 0) {
    zeros += 1
    cursor.pos += 1
  }
  cursor.pos += 1
  let value = 0
  for (let i = 0; i < zeros; i += 1) {
    value = value * 2 + (bits[cursor.pos] ?? 0)
    cursor.pos += 1
  }
  return 2 ** zeros - 1 + value
}

/**
 * 有符号指数哥伦布码。
 * @param {number[]} bits - 比特数组。
 * @param {{pos: number}} cursor - 游标。
 * @returns {number} 值。
 */
function se(bits, cursor) {
  const value = ue(bits, cursor)
  return value % 2 === 1 ? (value + 1) / 2 : -value / 2
}

/**
 * 从 H.264 裸流里找第一段 SPS/PPS，解出可直接喂 `addSourceBuffer` 的编码串。
 * @param {Buffer} raw - 任意位置的裸流（含 start code）。
 * @returns {{codec: string, width: number, height: number} | null} 解析结果。
 */
export function parseAvcConfig(raw) {
  const spsList = []
  const ppsList = []
  let i = 0
  while (i + 4 < raw.length) {
    let start = -1
    if (raw[i] === 0 && raw[i + 1] === 0 && raw[i + 2] === 1) start = i + 3
    else if (raw[i] === 0 && raw[i + 1] === 0 && raw[i + 2] === 0 && raw[i + 3] === 1) start = i + 4
    if (start < 0) {
      i += 1
      continue
    }
    const type = raw[start] & 0x1f
    let end = raw.length
    for (let j = start + 1; j + 2 < raw.length; j += 1) {
      if (raw[j] === 0 && raw[j + 1] === 0 && (raw[j + 2] === 1 || (raw[j + 2] === 0 && raw[j + 3] === 1))) {
        end = j
        break
      }
    }
    if (type === 7) spsList.push(raw.subarray(start, end))
    else if (type === 8) ppsList.push(raw.subarray(start, end))
    i = end
    if (spsList.length > 0 && ppsList.length > 0) break
  }
  if (spsList.length === 0 || ppsList.length === 0) return null
  const sps = spsList[0]
  if (sps.length < 4) return null
  const profile = sps[1]
  const compat = sps[2]
  const level = sps[3]
  const bits = []
  for (let k = 4; k < sps.length; k += 1) {
    for (let b = 7; b >= 0; b -= 1) bits.push((sps[k] >> b) & 1)
  }
  const cursor = { pos: 0 }
  try {
    ue(bits, cursor) // seq_parameter_set_id
    const profileIdc = profile
    let chromaFormat = 1
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
      chromaFormat = ue(bits, cursor)
      if (chromaFormat === 3) cursor.pos += 1
      ue(bits, cursor) // bit_depth_luma_minus8
      ue(bits, cursor) // bit_depth_chroma_minus8
      cursor.pos += 1 // qpprime_y_zero_transform_bypass_flag
      if (bits[cursor.pos] === 1) {
        cursor.pos += 1
        const count = chromaFormat === 3 ? 12 : 8
        for (let k = 0; k < count; k += 1) {
          if (bits[cursor.pos] === 0) cursor.pos += 1
          else return null
        }
      } else cursor.pos += 1
    }
    ue(bits, cursor) // log2_max_frame_num_minus4
    const pocType = ue(bits, cursor)
    if (pocType === 0) ue(bits, cursor)
    else if (pocType === 1) {
      cursor.pos += 1
      se(bits, cursor)
      se(bits, cursor)
      const count = ue(bits, cursor)
      for (let k = 0; k < count; k += 1) se(bits, cursor)
    }
    ue(bits, cursor) // max_num_ref_frames
    cursor.pos += 1 // gaps_in_frame_num_value_allowed_flag
    const widthMbs = ue(bits, cursor) + 1
    const heightMapUnits = ue(bits, cursor) + 1
    const frameMbsOnly = bits[cursor.pos]
    cursor.pos += 1
    if (frameMbsOnly === 0) cursor.pos += 1
    cursor.pos += 1 // direct_8x8_inference_flag
    let cropLeft = 0
    let cropRight = 0
    let cropTop = 0
    let cropBottom = 0
    if (bits[cursor.pos] === 1) {
      cursor.pos += 1
      cropLeft = ue(bits, cursor)
      cropRight = ue(bits, cursor)
      cropTop = ue(bits, cursor)
      cropBottom = ue(bits, cursor)
    }
    const chromaArray = chromaFormat === 0 ? 1 : chromaFormat
    const cropUnitX = chromaArray === 3 ? 1 : 2
    const cropUnitY = (chromaArray === 1 ? 2 : 1) * (2 - frameMbsOnly)
    const width = widthMbs * 16 - cropUnitX * (cropLeft + cropRight)
    const height = (2 - frameMbsOnly) * heightMapUnits * 16 - cropUnitY * (cropTop + cropBottom)
    return { codec: `avc1.${hex2(profile)}${hex2(compat)}${hex2(level)}`, width, height }
  } catch {
    return null
  }
}

/**
 * 两位十六进制。
 * @param {number} value - 0..255。
 * @returns {string} 小写两位。
 */
function hex2(value) {
  return value.toString(16).padStart(2, '0')
}

/**
 * 一路设备画面：录屏进程 + ffmpeg 重排 + 断线自动续。
 */
/**
 * 分片里有没有 IDR（H.264 NAL type 5）。新观众必须从关键帧起步。
 * @param {Buffer} chunk - moof + mdat。
 * @returns {boolean} 含关键帧就为真。
 */
function containsIdr(chunk) {
  const mdat = chunk.indexOf(Buffer.from('mdat'))
  if (mdat < 0) return false
  let i = mdat + 4
  while (i + 5 <= chunk.length) {
    /* fMP4 的 mdat 是长度前缀的 NAL，不是起始码；两种写法都认一下。 */
    if (chunk[i] === 0 && chunk[i + 1] === 0 && chunk[i + 2] === 1) {
      if ((chunk[i + 3] & 0x1f) === 5) return true
      i += 3
      continue
    }
    if (chunk[i] === 0 && chunk[i + 1] === 0 && chunk[i + 2] === 0 && chunk[i + 3] === 1) {
      if ((chunk[i + 4] & 0x1f) === 5) return true
      i += 4
      continue
    }
    const len = chunk.readUInt32BE(i)
    if (len === 0 || i + 4 + len > chunk.length) return false
    if ((chunk[i + 4] & 0x1f) === 5) return true
    i += 4 + len
  }
  return false
}

/** 最后一个观众走后，录屏再活这么久：侧栏重载/切页回来时能立刻出画面，不用等 2 秒起流。 */
const IDLE_GRACE_MS = 20000
/** 主链路待写队列上限：ffmpeg 不读数据时，队列涨到这里就整条重建，绝不把宿主内存吃光。 */
const MAX_REMUX_QUEUE = 4 * 1024 * 1024
/** JPEG 是可选支路：落后超过这个量就丢掉重建，它没有资格拖慢采集。 */
const MAX_JPEG_QUEUE = 1024 * 1024

/** GOP 缓存字节上限：超过就整段丢掉等下一张 IDR，保证新观众永远从 IDR 起播。 */
const MAX_GOP_BYTES = 4 * 1024 * 1024
/** 排空比这还慢就认为 ffmpeg 卡死了（设备端编码器会一直吐，不能跟着等）。 */
const REMUX_STALL_MS = 2000
/** 本进程的随机标识：设备端 pid 文件名带上它，多开/重启不会互相认领对方的录屏。 */
const RUN_TAG = Math.random().toString(36).slice(2, 8)

/**
 * 定时器 / 子进程回调 / 清理路径的统一兜底：这里漏出去的异常会冒到 host 顶层，
 * 整个 DSH 直接以 1 退出（2026-10-27 `this.killStale is not a function` 两次事故）。
 * 日志本身也可能失败（对象已销毁、debug 未注入），所以连写日志都要再包一层。
 * @param {(note: string) => void} log - 写诊断日志的函数。
 * @param {string} where - 出问题的路径。
 * @param {() => void} run - 要执行的事。
 * @returns {boolean} 是否正常跑完（不抛）。
 */
export function guardCall(log, where, run) {
  try {
    run()
    return true
  } catch (error) {
    try {
      log?.(`guard ${where}: ${String(error?.stack ?? error).slice(0, 400)}`)
    } catch {
      /* 日志也失败就算了：绝不让它变成新的未捕获异常 */
    }
    return false
  }
}

export class LiveStream {
  /**
   * @param {{serial: string, adb: string, width?: number, height?: number, bitrate?: number}} options - 设备与画质。
   */
  constructor(options) {
    this.serial = options.serial
    this.adbPath = options.adb
    /* 默认必须是竖屏比例：横屏录制出来的帧和抓帧帧比例不同，侧栏画面就会一大一小跳。 */
    this.width = options.width ?? 720
    this.height = options.height ?? 1280
    this.bitrate = options.bitrate ?? 4_000_000
    this.recorder = null
    /* 设备端 pid 文件名：停止时只按这个 pid 精确收尾，绝不 pkill 别人在录的屏。 */
    this.recorderPidFile = ''
    this.remuxer = null
    this.stopping = false
    this.restartTimer = null
    this.clients = new Set()
    /* 由 mirror 装上：问一句「镜像那边还有人在看吗」，空闲回收时用。 */
    this.stillWanted = null
    this.init = null
    this.pending = Buffer.alloc(0)
    /** 待拼的 box 字节。 @type {Buffer} */
    this.buffer = Buffer.alloc(0)
    /** moov 之前的 box（ftyp/moov）。 @type {Buffer} */
    this.initPending = Buffer.alloc(0)
    /** 正在攒的 moof+mdat。 @type {Buffer} */
    this.frag = Buffer.alloc(0)
    this.prelude = Buffer.alloc(0)
    this.lastKeyChunks = []
    this.lastKeyBytes = 0
    /** 等关键帧的新观众。 @type {Set<(bytes: Buffer) => void>} */
    this.waiting = new Set()
    this.total = 0
    this.startedAt = 0
    this.sessions = 0
    this.config = null
    this.error = ''
    this.intentional = false
    this.idleTimer = null
    this.firstFrameAt = 0
    this.bytes = 0
    this.framesSeen = 0
    this.lastAt = 0
    /** 最新的 JPEG 帧（桥接器解出来的）。 @type {Buffer|null} */
    this.jpeg = null
    this.jpegAt = 0
    this.jpegSeq = 0
    this.jpegChild = null
    this.jpegPending = Buffer.alloc(0)
    this.jpegWaiters = new Set()
    this.jpegOpenAt = 0
    /** 最近一次有人要 JPEG 的时间：JPEG 观看者也该把推流钉住，否则每轮轮询都要重开录屏。 */
    this.jpegWantedAt = 0
    /** 每次启动/停止都换一代：旧进程的 exit 回调据此作废，停止之后不会自己复活。 */
    this.generation = 0
    this.spawning = false
    /** 背压状态：正在因为 ffmpeg 写不动而暂停读录屏流。 */
    this.recorderPaused = false
    /** 诊断计数：队列保护触发了几次、暂停过几次。 */
    this.queueDrops = 0
    this.queueStalls = 0
    this.jpegDrops = 0
  }

  /**
   * 按设备物理尺寸定录屏尺寸：长边封顶 1280，保持竖屏比例，宽高取偶数。
   * 尺寸变了要重开录屏换新 IDR，否则编码器还按旧尺寸出帧。
   * @param {number} w - `wm size` 报的宽。
   * @param {number} h - `wm size` 报的高。
   * @returns {boolean} 尺寸有变化为 true。
   */
  configure(w, h) {
    if (!(w > 0) || !(h > 0)) return false
    const short = Math.min(w, h)
    const long = Math.max(w, h)
    const k = Math.min(1, 1280 / long)
    const width = Math.max(2, Math.round((short * k) / 2) * 2)
    const height = Math.max(2, Math.round((long * k) / 2) * 2)
    if (width === this.width && height === this.height) return false
    this.width = width
    this.height = height
    if (this.recorder !== null) this.rekey()
    return true
  }

  /**
   * 收掉上一次插件重载留下的 ffmpeg：旧模块实例不会自己清理，解码器会越积越多。
   * @param {string} serial - 设备序列号。
   * @returns {void}
   */
  static reapJpeg(serial) {
    const registry = globalThis.__dshAdbJpeg
    if (!(registry instanceof Map)) return
    const seen = registry.get(serial)
    if (!(seen instanceof Set)) return
    for (const child of seen) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经退了 */
      }
    }
    seen.clear()
  }

  /** 有人要看 JPEG 帧时才起解码器：不看不花 CPU。 @returns {boolean} 是否可用（解码器起来后 300 ms 内有帧）。 */
  enableJpeg() {
    this.jpegWantedAt = Date.now()
    /* 只看帧（/frame 轮询）也会起录屏：没人再来取帧就按同一套宽限停掉，否则设备一直在录。
       必须排在这里之后：start() 会清掉空闲定时器（它以为有人回来了）。 */
    if (this.jpegChild !== null) {
      this.scheduleIdleStop()
      return true
    }
    if (this.stopping) return false
    if (Date.now() - this.jpegOpenAt < 2000) return false
    this.jpegOpenAt = Date.now()
    this.start()
    this.scheduleIdleStop()
    LiveStream.reapJpeg(this.serial)
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-flags', 'low_delay',
      '-f', 'h264', '-i', 'pipe:0',
      /* 12 fps 够看清手指动作；960 高在展开的侧栏里也不糊，编码开销只有几十毫秒。 */
      '-vf', 'fps=15,scale=-2:960',
      /* mjpeg 复用器会把 20 KB 级的帧攒在 avio 缓冲里，不加这个要等进程退出才吐一帧。 */
      '-flush_packets', '1',
      '-fps_mode', 'passthrough',
      '-f', 'mjpeg', '-q:v', '7',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.jpegChild = child
    if (!(globalThis.__dshAdbJpeg instanceof Map)) globalThis.__dshAdbJpeg = new Map()
    if (!(globalThis.__dshAdbJpeg.get(this.serial) instanceof Set)) globalThis.__dshAdbJpeg.set(this.serial, new Set())
    globalThis.__dshAdbJpeg.get(this.serial).add(child)
    child.on('exit', () => globalThis.__dshAdbJpeg.get(this.serial)?.delete(child))
    /* 同上：管道 EPIPE 只许结束这条可选支路，不能冒泡到宿主。 */
    child.stdin.on('error', (error) => this.guard('jpeg-stdin-error', () => {
      this.error = 'JPEG 管道断开：' + String(error?.message ?? error)
      if (this.jpegChild === child) this.closeJpeg()
    }))
    child.stdout.on('data', (chunk) => this.guard('feed-jpeg', () => this.feedJpeg(chunk)))
    child.stderr.on('data', (buf) => {
      const text = String(buf).trim()
      if (text !== '') this.error = text.slice(-300)
    })
    child.on('error', (error) => {
      if (this.jpegChild === child) this.jpegChild = null
      this.error = 'JPEG 桥接起不来：' + String(error?.message ?? error)
    })
    child.on('exit', (code) => {
      if (this.jpegChild === child) this.jpegChild = null
      if (code !== 0 && code !== null && !this.stopping) this.error = 'JPEG 桥接退出码 ' + String(code)
    })
    return true
  }

  /** 按 SOI/EOI 切 MJPEG 字节流。 @param {Buffer} chunk - 解码器输出。 @returns {void} */
  feedJpeg(chunk) {
    this.jpegPending = Buffer.concat([this.jpegPending, chunk])
    if (this.jpegPending.length > 8_000_000) this.jpegPending = this.jpegPending.subarray(-4_000_000)
    for (;;) {
      const start = this.jpegPending.indexOf(Buffer.from([0xff, 0xd8]))
      if (start < 0) {
        this.jpegPending = Buffer.alloc(0)
        return
      }
      const end = this.jpegPending.indexOf(Buffer.from([0xff, 0xd9]), start + 2)
      if (end < 0) {
        if (start > 0) this.jpegPending = this.jpegPending.subarray(start)
        return
      }
      const frame = this.jpegPending.subarray(start, end + 2)
      this.jpegPending = this.jpegPending.subarray(end + 2)
      this.jpeg = Buffer.from(frame)
      this.jpegAt = Date.now()
      this.jpegSeq += 1
      for (const waiter of [...this.jpegWaiters]) waiter(this.jpeg)
      this.jpegWaiters.clear()
    }
  }

  /** 有比 since 更新的帧就立刻给，否则等到超时。 @param {number} since - 客户端已有的序号。 @param {number} ms - 最多等多久。 @returns {Promise<Buffer|null>} 帧或 null。 */
  nextJpeg(since, ms) {
    if (this.jpeg !== null && this.jpegSeq > since && Date.now() - this.jpegAt < 1200) return Promise.resolve(this.jpeg)
    return new Promise((resolve) => {
      let done = false
      const finish = (value) => {
        if (done) return
        done = true
        this.jpegWaiters.delete(finish)
        resolve(value)
      }
      this.jpegWaiters.add(finish)
      const timer = setTimeout(() => finish(this.jpeg !== null && Date.now() - this.jpegAt < 2500 ? this.jpeg : null), Math.max(120, ms))
      timer.unref?.()
    })
  }

  /** 桥接帧是不是新鲜的（拿来判断该不该回退到 screencap）。 @returns {boolean} 新鲜为 true。 */
  jpegFresh() {
    return this.jpeg !== null && Date.now() - this.jpegAt < 1200
  }

  /** 观众都走了：留一段宽限再停，重开侧栏就不用重新起流。 @returns {void} */
  scheduleIdleStop(delayMs = IDLE_GRACE_MS) {
    if (this.idleTimer !== null) return
    this.idleTimer = setTimeout(() => this.guard('idle-stop', () => {
      this.idleTimer = null
      if (this.clients.size > 0 || this.waiting.size > 0) return
      /* 只看帧的人每隔一秒来一次，取帧时间戳会被不断刷新；差多少补多少，不重复排满宽限。 */
      /* 镜像那边还有常连观看者（/live）时不能停：它不走 clients，只靠这个回调说话。 */
      if (typeof this.stillWanted === 'function' && this.stillWanted()) {
        this.scheduleIdleStop()
        return
      }
      const left = IDLE_GRACE_MS - (Date.now() - this.jpegWantedAt)
      if (left > 250) {
        this.scheduleIdleStop(left)
        return
      }
      this.stop()
    }), Math.max(0, delayMs))
    this.idleTimer.unref?.()
  }

  /** 有人在看才开始录，没人看一会儿就停，省设备电和带宽。 @returns {void} */
  start() {
    if (this.stopping || this.spawning) return
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    if (this.recorder !== null) {
      this.ensureRemuxer()
      return
    }
    this.startedAt = Date.now()
    this.spawning = true
    this.spawnRecorder()
    this.spawning = false
  }

  /**
   * 重开一次录屏，换一张新的 IDR：新观众进场时用，代价约半秒黑屏。
   * @returns {void}
   */
  rekey() {
    if (this.stopping) return
    this.intentional = true
    const child = this.recorder
    this.recorder = null
    /* 换 IDR 前先收掉自己这次的设备端录屏，只按 pid 杀，不碰别人的。 */
    this.killOwnRecorder()
    this.init = null
    this.error = ''
    this.lastKeyChunks = []
    this.lastKeyBytes = 0
    this.closeRemuxer()
    if (child !== null) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经退了 */
      }
    }
    /* 不在这里直接 spawn：旧进程还没退，同时起两个会撞上另一个录屏在跑。
       exit 回调里的 scheduleRestart 会在 120 ms 后换新 IDR。 */
  }

  /**
   * 设备端精确收尾：按启动时写下的 pid 文件找到「自己这一次」的 screenrecord，
   * 核对进程名还是 screenrecord 再 kill。pid 拿不到就不杀（只记日志），
   * 让它按 time-limit 自己结束，也不会误伤别人的录屏。
   * @param {string} [pidFile] - pid 文件；默认用当前这次录屏的。
   * @returns {void}
   */
  killOwnRecorder(pidFile = this.recorderPidFile) {
    const safe = String(pidFile).replace(/[^\w./-]/g, '')
    if (safe === '') {
      this.debug('kill-device skipped: no pid file')
      return
    }
    if (this.recorderPidFile === pidFile) this.recorderPidFile = ''
    const script = `p='${safe}'; r=$(cat "$p" 2>/dev/null); rm -f "$p"; if [ -n "$r" ] && [ "$(cat /proc/$r/comm 2>/dev/null)" = 'screenrecord' ]; then kill -9 "$r"; echo killed:$r; else echo skip:$r; fi`
    try {
      const child = spawn(this.adbPath, ['-s', this.serial, 'shell', script], { stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      child.stdout?.on('data', (chunk) => { out = (out + String(chunk)).slice(-120) })
      child.on('exit', () => this.debug('kill-device ' + (out.trim() || 'no-reply')))
      child.on('error', () => this.debug('kill-device spawn-error'))
      child.unref?.()
    } catch {
      this.debug('kill-device threw')
    }
  }

  /**
   * 正常到时长退出的清理：只删自己的 pid 文件，不 kill（pid 可能已被别人复用）。
   * @returns {void}
   */
  dropRecorderPidFile() {
    const pidFile = this.recorderPidFile
    this.recorderPidFile = ''
    const safe = String(pidFile).replace(/[^\w./-]/g, '')
    if (safe === '') return
    try {
      const child = spawn(this.adbPath, ['-s', this.serial, 'shell', 'rm', '-f', safe], { stdio: 'ignore' })
      child.on('error', () => {})
      child.unref?.()
    } catch {
      /* 清不掉就留着，几十字节，不影响主流程 */
    }
  }

  /**
   * 定时器与子进程回调的兜底：这里抛出的异常会冒到 host 顶层，整个 DSH 以 1 退出
   * （2026-10-27 `this.killStale` 两次事故），所以宁可这一步不做也要写日志。
   * @param {string} where - 出问题的路径，写进 stream-debug.log。
   * @param {() => void} run - 真正要做的事。
   * @returns {void}
   */
  guard(where, run) {
    guardCall((note) => this.debug(note), where, run)
  }

  /** 起一次录屏。 @returns {void} */
  debug(note) {
    /* 常开：只在开/停录屏时写一行，量极小，出问题不用再复现一次。 */
    try {
      const line = JSON.stringify({ at: Date.now(), serial: this.serial, note, sessions: this.sessions, clients: this.clients.size, waiting: this.waiting.size, err: this.error }) + '\n'
      mkdirSync(join(homedir(), '.dsh', 'adb-mirror'), { recursive: true })
      appendFileSync(join(homedir(), '.dsh', 'adb-mirror', 'stream-debug.log'), line)
    } catch {
      /* 调试失败不影响推流 */
    }
  }

  spawnRecorder() {
    if (this.stopping) return
    const size = `${this.width}x${this.height}`
    this.sessions += 1
    const safeSerial = this.serial.replace(/[^\w.-]/g, '_')
    const pidFile = `/data/local/tmp/dsh-mobile-use-stream-${safeSerial}-${RUN_TAG}-${this.sessions}.pid`
    this.recorderPidFile = pidFile
    /* exec 让 shell 的 pid 就是 screenrecord 的 pid：停止时按这个 pid 精确 kill。 */
    const command = `sh -c 'echo $$ > ${pidFile}; exec screenrecord --output-format=h264 --time-limit=${RECORD_LIMIT} --size=${size} --bit-rate=${this.bitrate} -'`
    const args = ['-s', this.serial, 'exec-out', command]
    const child = spawn(this.adbPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.recorder = child
    /* 新进程意味着读端是新的：上一轮为背压按下的暂停状态必须清掉。 */
    this.recorderPaused = false
    const gen = this.generation
    this.debug('spawn gen=' + String(gen) + ' session=' + String(this.sessions))
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000)
    })
    child.stdout.on('data', (chunk) => this.guard('feed-raw', () => this.feedRaw(chunk)))
    child.on('error', (error) => this.guard('recorder-error', () => {
      if (gen !== this.generation) return
      this.error = String(error?.message ?? error)
      this.recorder = null
      this.scheduleRestart()
    }))
    child.on('exit', (code) => this.guard('recorder-exit', () => {
      if (this.recorder === child) this.recorder = null
      /* stop() 之后的旧进程回调一律作废：否则「关掉页面 180 ms 后又自己开始录」。 */
      if (gen !== this.generation) return
      this.closeRemuxer()
      if (this.stopping) return
      const wasIntentional = this.intentional
      this.intentional = false
      this.debug('recorder-exit code=' + String(code) + ' intentional=' + String(wasIntentional) + ' stderr=' + stderr.trim().slice(-120))
      if (code !== 0 && stderr.trim() !== '' && !wasIntentional) {
        /* screenrecord 在一些机型上会因为「另一个录屏在跑」直接退出，记下来便于排查。 */
        const text = stderr.trim().split('\n').slice(-2).join(' ')
        if (/denied|error|failed|another/i.test(text)) this.error = text
      }
      /* 正常到时长或编码器重启都走这里：换一份 moov，前端按 INIT 帧重建 MediaSource。 */
      if (this.clients.size > 0) this.broadcast(packFrame(FRAME_END, Buffer.alloc(0)))
      /* 录满时长正常退出：screenrecord 已经不在了，只删自己的 pid 文件（不 kill，免 pid 复用误伤）。 */
      if (code === 0) this.dropRecorderPidFile()
      if (wasIntentional && this.stopping) return
      this.scheduleRestart()
    }))
  }

  /** 到点自动续上，避免中断超过半秒。 @returns {void} */
  scheduleRestart() {
    if (this.stopping || this.restartTimer !== null) return
    if (this.clients.size === 0 && this.waiting.size === 0) return
    this.restartTimer = setTimeout(() => this.guard('restart', () => {
      this.restartTimer = null
      if (!this.stopping && (this.clients.size > 0 || this.waiting.size > 0)) {
        /* 上一轮可能是被 SIGKILL 的 adb：先按自己的 pid 清掉设备端残留，再开新录屏。 */
        this.killOwnRecorder()
        this.spawnRecorder()
      }
    }), 120)
    this.restartTimer.unref?.()
  }

  /** 有裸流分片就交给 ffmpeg；顺手记录编码参数。 @param {Buffer} chunk - 裸 H.264。 @returns {void} */
  feedRaw(chunk) {
    this.bytes += chunk.length
    this.lastAt = Date.now()
    if (this.firstFrameAt === 0) this.firstFrameAt = this.lastAt
    if (this.config === null) {
      /* SPS 可能被切在两个分片之间，攒一段再解析。 */
      this.prelude = Buffer.concat([this.prelude, chunk]).subarray(-262144)
      const config = parseAvcConfig(this.prelude)
      if (config !== null) {
        this.config = config
        this.broadcast(packFrame(FRAME_META, Buffer.from(JSON.stringify({ codec: config.codec, width: config.width, height: config.height }))))
      }
    }
    const jpegChild = this.jpegChild
    if (jpegChild !== null) {
      const jpegIn = jpegChild.stdin
      if (jpegIn === null || jpegIn.writableLength > MAX_JPEG_QUEUE) {
        /* 可选支路落后就整条丢掉重建，它没有资格拖住采集链。 */
        this.jpegDrops += 1
        this.closeJpeg()
      } else {
        try {
          jpegIn.write(chunk)
        } catch {
          this.closeJpeg()
        }
      }
    }
    this.ensureRemuxer()
    const remuxer = this.remuxer
    if (remuxer === null) return
    const mp4In = remuxer.stdin
    if (mp4In === null || mp4In.writableLength > MAX_REMUX_QUEUE) {
      /* 排到上限说明 ffmpeg 已经不读了：整条重建，宁可黑半秒也不憋住内存。 */
      this.queueDrops += 1
      this.error = 'ffmpeg 写入落后，已重建转封装'
      this.closeRemuxer()
      return
    }
    try {
      if (mp4In.write(chunk) === false) this.pauseForRemuxer(remuxer)
    } catch {
      this.closeRemuxer()
    }
  }

  /**
   * ffmpeg 报背压：暂停读录屏流，等它排空；等太久就整条重建（含重新要 IDR）。
   * @param {import('node:child_process').ChildProcess} remuxer - 当前转封装进程。
   * @returns {void}
   */
  pauseForRemuxer(remuxer) {
    if (this.recorderPaused) return
    const recorder = this.recorder
    if (recorder === null) return
    this.recorderPaused = true
    this.queueStalls += 1
    this.debug('remux-backpressure pause')
    try {
      recorder.stdout.pause()
    } catch {
      /* 已经关了 */
    }
    let timer = setTimeout(() => this.guard('remux-stall', () => {
      timer = null
      if (this.remuxer === remuxer) {
        this.error = 'ffmpeg 2 秒未消费数据，已重建'
        this.closeRemuxer()
        /* 重新要一张 IDR：新 ffmpeg 从 SPS 开始才解得对。 */
        this.rekey()
      }
      this.resumeRecorder()
    }), REMUX_STALL_MS)
    timer.unref?.()
    remuxer.stdin.once('drain', () => this.guard('remux-drain', () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      this.resumeRecorder()
    }))
  }

  /** 排空后恢复读录屏流。 @returns {void} */
  resumeRecorder() {
    if (!this.recorderPaused) return
    this.recorderPaused = false
    const recorder = this.recorder
    if (recorder === null) return
    try {
      recorder.stdout.resume()
    } catch {
      /* 已经关了 */
    }
  }

  /**
   * 起 ffmpeg：裸流重排成分片 MP4。
   * @returns {void}
   */
  ensureRemuxer() {
    if (this.remuxer !== null) return
    this.error = ''
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      /* 千万不要加 -fflags nobuffer：它会让裸流输入一帧都进不来（实测 ffmpeg 只吐 moov）。
         40 ms 一片，画面一变就有一片推出去，静止时不产生流量。 */
      '-flags', 'low_delay',
      /* 裸 H.264 没有时间戳，默认会按 1200000fps 编时间轴，一片只有几毫秒、播起来像定格；
         用到达时间当时间戳，静止不动就不涨、动起来才走，正好对上真实节奏。 */
      '-use_wallclock_as_timestamps', '1',
      '-f', 'h264', '-i', 'pipe:0',
      /* 绝对时间戳太大，挪回从 0 起，前端才不用跟着跳到几小时的刻度上。 */
      '-copyts', '-start_at_zero',
      '-c', 'copy', '-frag_duration', '40000',
      '-movflags', 'empty_moov+default_base_moof',
      '-f', 'mp4', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.remuxer = child
    /* child.on('error') 接不到管道自身的 EPIPE：必须单独接管 stdin，否则异步 error 事件会打死宿主。 */
    child.stdin.on('error', (error) => this.guard('remux-stdin-error', () => {
      this.error = 'ffmpeg 管道断开：' + String(error?.message ?? error)
      if (this.remuxer === child) this.closeRemuxer()
    }))
    child.stdout.on('data', (chunk) => this.guard('feed-mp4', () => this.feedMp4(chunk)))
    child.stderr.on('data', (buf) => {
      const text = String(buf).trim()
      if (text !== '') this.error = text.slice(-300)
    })
    child.on('error', (error) => {
      if (this.remuxer === child) this.remuxer = null
      this.error = `ffmpeg 起不来：${String(error?.message ?? error)}`
    })
    child.on('exit', (code) => {
      if (this.remuxer === child) this.remuxer = null
      /* 我们主动 kill 时 code 是 null，不是故障。 */
    this.debug('ffmpeg-exit code=' + String(code) + ' stopping=' + String(this.stopping) + ' intentional=' + String(this.intentional))
    /* code=null 表示被信号杀掉，是我们自己的 kill，不是故障。 */
    if (code !== 0 && code !== null && this.error === '' && !this.stopping && !this.intentional) this.error = `ffmpeg 退出码 ${String(code)}`
    })
  }

  /** 收掉 JPEG 解码器。 @returns {void} */
  closeJpeg() {
    const child = this.jpegChild
    this.jpegChild = null
    this.jpeg = null
    this.jpegAt = 0
    this.jpegPending = Buffer.alloc(0)
    for (const waiter of [...this.jpegWaiters]) waiter(null)
    this.jpegWaiters.clear()
    if (child === null) return
    try {
      child.stdin.end()
      child.kill('SIGKILL')
    } catch {
      /* 已经退了 */
    }
  }

  /** 关掉 ffmpeg，等下一次录屏重开。 @returns {void} */
  closeRemuxer() {
    const child = this.remuxer
    this.remuxer = null
    this.init = null
    this.pending = Buffer.alloc(0)
    this.buffer = Buffer.alloc(0)
    this.initPending = Buffer.alloc(0)
    this.frag = Buffer.alloc(0)
    this.lastKeyChunks = []
    this.lastKeyBytes = 0
    if (child === null) return
    try {
      child.stdin.end()
      child.kill('SIGKILL')
    } catch {
      /* 已经退了 */
    }
  }

  /**
   * ffmpeg 的 fMP4 输出：第一段含 moov，后面按 moof 切；keyframe 之前的分片留一份给新观众。
   * @param {Buffer} chunk - 输出字节。
   * @returns {void}
   */
  feedMp4(chunk) {
    this.total += chunk.length
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    /* 按 ISO BMFF 的 box 边界切，不能靠搜 "moof" 字符串：mdat 里撞上这四个字节就会切歪。 */
    for (;;) {
      if (this.buffer.length < 8) return
      const size = this.buffer.readUInt32BE(0)
      const type = this.buffer.toString('latin1', 4, 8)
      if (size < 8) {
        /* size 0/1 的怪 box，丢掉前 8 字节免得卡死。 */
        this.buffer = this.buffer.subarray(8)
        continue
      }
      if (this.buffer.length < size) return
      const box = this.buffer.subarray(0, size)
      this.buffer = this.buffer.subarray(size)
      if (type === 'moov') {
        /* moov 才是初始化段：先发 INIT，再把之前攒着、还不能解码的分片一起发出去。 */
        this.init = this.initPending.length > 0 ? Buffer.concat([this.initPending, box]) : box
        this.initPending = Buffer.alloc(0)
        this.broadcast(packFrame(FRAME_INIT, this.init))
        if (this.frag.length > 0) {
          const pending = this.frag
          this.frag = Buffer.alloc(0)
          this.emitMedia(pending)
        }
      } else if (type === 'moof') {
        if (this.frag.length > 0) {
          const finished = this.frag
          if (this.init === null) {
            /* 初始化段还没到：分片先攒着，绝不先发 MEDIA，否则前端拿到解不了的一帧。 */
            this.frag = Buffer.concat([finished, box])
            continue
          }
          this.frag = box
          this.emitMedia(finished)
        } else {
          this.frag = box
        }
      } else if (this.frag.length > 0) {
        this.frag = Buffer.concat([this.frag, box])
      } else {
        this.initPending = Buffer.concat([this.initPending, box]).subarray(-8388608)
      }
    }
  }

  /**
   * 把分片推给观众，同时按 keyframe 维护一份缓存。
   * @param {Buffer} chunk - 分片字节。
   * @returns {void}
   */
  emitMedia(chunk) {
    this.framesSeen += 1
    this.lastAt = Date.now()
    const key = containsIdr(chunk)
    if (key) {
      this.lastKeyChunks = [chunk]
      this.lastKeyBytes = chunk.length
    } else if (this.lastKeyChunks.length > 0) {
      this.lastKeyChunks.push(chunk)
      this.lastKeyBytes += chunk.length
      /* 只缓存「一张 IDR 起头」的连续 GOP：超上限就整段丢掉等下一张，绝不从 GOP 中间续播。 */
      if (this.lastKeyBytes > MAX_GOP_BYTES) {
        this.lastKeyChunks = []
        this.lastKeyBytes = 0
      }
    }
    /* 先广播这一帧，再给等待的观众补前情，避免同一个关键帧投三遍。 */
    const promoted = key && this.waiting.size > 0 ? Array.from(this.waiting) : []
    if (promoted.length > 0) this.waiting.clear()
    this.broadcast(packFrame(FRAME_MEDIA, chunk))
    for (const sink of promoted) {
      this.sendPrelude(sink)
      this.clients.add(sink)
    }
  }

  /**
   * 推给所有观众，慢的直接丢掉（宁可掉帧也不堆内存）。
   * @param {Buffer} bytes - 已封包字节。
   * @returns {void}
   */
  broadcast(bytes) {
    for (const client of this.clients) {
      try {
        client(bytes)
      } catch {
        this.clients.delete(client)
      }
    }
  }

  /**
   * 新观众入场：先给初始化段 + 最近一个 keyframe 起的分片，再进直播。
   * @param {(bytes: Buffer) => void} sink - 写响应的函数。
   * @returns {() => void} 退订函数。
   */
  subscribe(sink) {
    this.start()
    if (this.init !== null && this.lastKeyChunks.length > 0) {
      this.sendPrelude(sink)
      this.clients.add(sink)
    } else {
      /* 手上没有能解码的起点，先挂着，下一张 IDR 到了再补，避免解码器起不来。 */
      this.waiting.add(sink)
      /* 设备只在开录时给一张 IDR，等下一张可能是几十秒；直接重开一次录屏换新 IDR。 */
      /* 刚起的录屏还没吐第一张 IDR 就别杀掉重开：等它自己出图。 */
      if (this.recorder !== null && this.restartTimer === null && Date.now() - this.startedAt > 700) this.rekey()
      this.sendPrelude(sink)
    }
    return () => {
      this.clients.delete(sink)
      this.waiting.delete(sink)
      if (this.clients.size === 0 && this.waiting.size === 0) this.scheduleIdleStop()
    }
  }

  /**
   * 补一份初始化段和关键帧起点给某个观众。
   * @param {(bytes: Buffer) => void} sink - 写响应的函数。
   * @returns {void}
   */
  sendPrelude(sink) {
    if (this.config !== null) {
      sink(packFrame(FRAME_META, Buffer.from(JSON.stringify({ codec: this.config.codec, width: this.config.width, height: this.config.height }))))
    }
    if (this.init === null) return
    sink(packFrame(FRAME_INIT, this.init))
    for (const chunk of this.lastKeyChunks) sink(packFrame(FRAME_MEDIA, chunk))
  }

  /** 没人看了就停，别占着设备编码器。幂等：重复调用、对象已销毁都不抛。 @returns {void} */
  stop() {
    /* 换代：之前所有 in-flight 的退出/重启回调从此作废，停止之后不会自己复活。 */
    this.generation = (Number(this.generation) || 0) + 1
    if (this.idleTimer != null) {
      this.guard('stop-idle-timer', () => clearTimeout(this.idleTimer))
      this.idleTimer = null
    }
    this.stopping = true
    if (this.restartTimer != null) {
      this.guard('stop-restart-timer', () => clearTimeout(this.restartTimer))
      this.restartTimer = null
    }
    /* 清理方法可能没注入/已被替换（历史事故就是这么打崩 host 的），每一步单独兜底。 */
    this.guard('stop-remuxer', () => this.closeRemuxer())
    this.guard('stop-jpeg', () => this.closeJpeg())
    const child = this.recorder ?? null
    this.recorder = null
    /* 本地杀进程不等于设备端停了：先按自己记下的 pid 收掉设备端录屏，否则下一次开流会撞上。 */
    this.guard('stop-device-recorder', () => this.killOwnRecorder())
    if (child !== null) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经退了 */
      }
    }
    this.intentional = true
    this.stopping = false
    this.init = null
    this.lastKeyChunks = []
    this.lastKeyBytes = 0
    this.waiting?.clear?.()
    this.config = null
    this.firstFrameAt = 0
  }

  /** 给 /state 用的快照。 @returns {any} 状态。 */
  info() {
    return {
      serial: this.serial,
      clients: this.clients.size,
      codec: this.config?.codec ?? '',
      width: this.config?.width ?? 0,
      height: this.config?.height ?? 0,
      bytes: this.bytes,
      mp4Bytes: this.total,
      frames: this.framesSeen,
      started: this.startedAt,
      sessions: this.sessions,
      lastAt: this.lastAt,
      firstFrameAt: this.firstFrameAt,
      error: this.error,
      jpegFrames: this.jpegSeq,
      jpegAt: this.jpegAt,
      jpegLive: this.jpegChild !== null,
      jpegBytes: this.jpeg === null ? 0 : this.jpeg.length,
      /* 诊断：队列保护触发次数与当前待写字节，涨得快就说明 ffmpeg 跟不上。 */
      queueDrops: this.queueDrops,
      queueStalls: this.queueStalls,
      jpegDrops: this.jpegDrops,
      remuxQueued: this.remuxer === null ? 0 : this.remuxer.stdin?.writableLength ?? 0,
      jpegQueued: this.jpegChild === null ? 0 : this.jpegChild.stdin?.writableLength ?? 0,
      generations: this.generation,
    }
  }
}
