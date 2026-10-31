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

import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createTsMuxer } from './tsmux.js'

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
/** 分片里第一段解码时间（秒），用来量端到端延迟。@param {Buffer} chunk - moof+mdat。@param {number} timescale - mdhd 时间刻度。@returns {number} 秒，取不到就给 -1。 */
function readTfdt(chunk, timescale) {
  const at = chunk.indexOf(Buffer.from('tfdt'))
  if (at < 0 || at + 12 > chunk.length || !(timescale > 0)) return -1
  const version = chunk[at + 4]
  if (version === 1) {
    if (at + 20 > chunk.length) return -1
    return Number(chunk.readBigUInt64BE(at + 8)) / timescale
  }
  return chunk.readUInt32BE(at + 8) / timescale
}

/** 从 moov 里读 mdhd 时间刻度。@param {Buffer} init - 初始化段。@returns {number} 刻度，读不到就 90000。 */
function readTimescale(init) {
  for (let from = 0; from < init.length - 4; from += 1) {
    if (init[from] !== 0x6d || init[from + 1] !== 0x64 || init[from + 2] !== 0x68 || init[from + 3] !== 0x64) continue
    const p = from + 4
    const version = init[p]
    const scaleAt = version === 1 ? p + 20 : p + 12
    if (scaleAt + 4 <= init.length) {
      const value = init.readUInt32BE(scaleAt)
      if (value > 0) return value
    }
  }
  return 90000
}

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

/** 最后一个观众走后，采集链路再活这么久：侧栏重载/切页回来时能立刻出画面（实测 0.25 秒），
    而冷启动要重新推 server、等 IDR，实测 8~9 秒。静止画面时编码器本来就不产出流量，留 2 分钟不费资源。 */
/* 没人在看多久后收掉设备端采集。默认两分钟：重开侧栏是热的；调试/自测可用环境变量压到几秒。 */
const IDLE_GRACE_MS = Math.max(3000, Number(process.env.ADBM_IDLE_GRACE_MS ?? 120000) || 120000)
/* 走过一次视觉读的设备，把宽限拉长：隔几分钟再读一次屏不该再付 0.8–1.1s 的冷启。
   编码器与 ffmpeg 的空转成本是几十毫秒 CPU；ADBM_VISION_KEEPALIVE_MS=0 可关掉。 */
const VISION_KEEPALIVE_MS = Math.max(0, Number(process.env.ADBM_VISION_KEEPALIVE_MS ?? 600000) || 0)
/** 看门狗节拍、判定阈值、重建冷却：2 秒一拍，8 秒没初始化段就重建，15 秒内不重复重建。 */
const WATCH_TICK_MS = 2000
const WATCH_INIT_MS = 8000
/* 已经有初始化段、画面却不再出片：静态画面会真的不出片，所以先请一帧验证，
   请了还不来才判卡死。长跑时这条是「画面冻住」的唯一出路。 */
const WATCH_STALL_MS = 10000
/* 视觉路径专用：解码器活着但一帧都不出，说明设备端录制器已经死了（僵尸 ffmpeg）。
   冷调 screencap 要 500–900 ms，比等一次重建慢得多，所以这里主动修，而不是让视觉变慢。 */
const JPEG_STALL_MS = 6000
const JPEG_INIT_STALL_MS = 8000
const WATCH_COOLDOWN_MS = 15000
/** 主链路待写队列上限：ffmpeg 不读数据时，队列涨到这里就整条重建，绝不把宿主内存吃光。 */
const MAX_REMUX_QUEUE = 4 * 1024 * 1024
/** JPEG 是可选支路：落后超过这个量就丢掉重建，它没有资格拖慢采集。 */
const MAX_JPEG_QUEUE = 1024 * 1024

/** GOP 缓存字节上限：超过就整段丢掉等下一张 IDR，保证新观众永远从 IDR 起播。 */
const MAX_GOP_BYTES = 4 * 1024 * 1024
/** 每个流最多挂多少个观众（正在看的 + 等关键帧的合计）：超出直接拒绝，Set 不许无界长。 */
const MAX_SUBSCRIBERS = 12
/** 每个流最多挂多少个等 JPEG 的请求：轮询页面一多就会排成无界队列。 */
const MAX_JPEG_WAITERS = 48
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
    /* 尺寸不写死：第一次开录按设备真实分辨率算（长边封顶 2400，保持比例），
       这样 OCR 能在推流帧上认字，不必再花 ~680ms 抓原图。 */
    this.width = options.width ?? 0
    this.height = options.height ?? 0
    this.sizeFixed = this.width > 0 && this.height > 0
    this.sizeAt = 0
    this.bitrateFixed = options.bitrate !== undefined
    this.bitrate = options.bitrate ?? 8_000_000
    /* 分片时长决定转封装的缓冲深度：10 ms 一片，拖动能到 60 fps；调大更省开销但画面更"钝"。 */
    const frag = Number(options.fragmentMs)
    this.fragMs = Number.isFinite(frag) ? Math.min(200, Math.max(10, Math.round(frag))) : 10
    this.recorder = null
    /* 设备端 pid 文件名：停止时只按这个 pid 精确收尾，绝不 pkill 别人在录的屏。 */
    this.recorderPidFile = ''
    /* 本插件在这台设备上的录屏 pid 文件前缀，收尾时按它横扫。 */
    this.recorderPidPrefix = `/data/local/tmp/dsh-mobile-use-stream-${String(this.serial).replace(/[^\w.-]/g, '_')}-`
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
    this.idleArmedAt = 0
    this.idleGrace = IDLE_GRACE_MS
    this.lastViewerAt = 0
    this.firstFrameAt = 0
    this.bytes = 0
    /* 送进 ffmpeg 的是自己封的 MPEG-TS：裸 H.264 没时间戳，ffmpeg 只能按读到那一刻打戳，
       而 scrcpy 的帧成批到达，同一批戳几乎一样，重封出来的时间轴会失真（实测 5 s 采集能拉成 50 s）。
       每个视频包自带设备端真实 PTS，封进 PES 就不丢。 */
    this.tsMux = createTsMuxer()
    this.lastPtsUs = 0
    this.ptsOriginUs = 0
    this.framesSeen = 0
    this.lastAt = 0
    /** 最新的 JPEG 帧（桥接器解出来的）。 @type {Buffer|null} */
    this.jpeg = null
    this.jpegAt = 0
    this.jpegSeq = 0
    this.jpegChild = null
    /** 这一代 JPEG 解码器的起表时间：从没出过帧时按它判死，避免刚起就重建。 */
    this.jpegStartedAt = 0
    this.jpegPending = Buffer.alloc(0)
    this.jpegWaiters = new Set()
    /* 配额拒绝计数：看诊断就知道是不是被上限挡过（不是静默截断）。 */
    this.subscriberRejects = 0
    this.jpegWaiterRejects = 0
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
    /** 可选的低延迟采集源（scrcpy 通道）：返回 null 就退回 screenrecord。 */
    this.sourceReady = typeof options.sourceReady === 'function' ? options.sourceReady : null
    /* 采集源可能还在建（scrcpy 连上要 1~2s）：给它一次异步等待的机会，别急着起 screenrecord。 */
    this.sourceWait = typeof options.sourceWait === 'function' ? options.sourceWait : null
    /* 采集源当前状态；通道还在连时继续等，别急着退回录屏。 */
    this.sourceState = typeof options.sourceState === 'function' ? options.sourceState : null
    this.sourceWaitAt = 0
    /* 通道接上却不出帧时先冷一会儿，别每 1.5 秒重挂一次。 */
    this.scrcpyHoldUntil = 0
    /** 正在用的 scrcpy 通道。 @type {any} */
    this.scrcpy = null
    /** scrcpy 监听器，拆除时按引用移除。 @type {any} */
    this.scrcpyBound = null
    /* scrcpy 起不来的兜底计时器：到点没帧就退回 screenrecord。 */
    this.scrcpyTimer = null
    this.frameRetryTimer = null
    /* 有观众但迟迟拿不到初始化段：黑屏自我修复用的看门狗。 */
    this.viewerSince = 0
    this.revivedAt = 0
    this.watchTimer = null
    this.initAt = 0
    /** 本对象创建的所有定时器：stop() 按这个集合逐个取消，漏一个就是一条停不掉的复活路。 @type {Set<any>} */
    this.timers = new Set()
    /** stop() 重入计数：清理过程中再次被调（closed 回调、退出回调）直接返回，不重复拆。 */
    this.stopDepth = 0
    /** 最近一次 stop() 的时间戳，给 /state 和她人排查用。 */
    this.closedAt = 0
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
      '-vf', 'fps=15,scale=1400:1400:force_original_aspect_ratio=decrease',
      /* mjpeg 复用器会把 20 KB 级的帧攒在 avio 缓冲里，不加这个要等进程退出才吐一帧。 */
      '-flush_packets', '1',
      '-fps_mode', 'passthrough',
      '-f', 'mjpeg', '-q:v', '7',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.jpegChild = child
    this.jpegStartedAt = Date.now()
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
    /* 配额：轮询端一多，等帧队列就是无界数组；满了立刻给 null（调用方会重试），不排队。 */
    if (this.jpegWaiters.size >= MAX_JPEG_WAITERS) {
      this.jpegWaiterRejects += 1
      return Promise.resolve(null)
    }
    return new Promise((resolve) => {
      let done = false
      let timer = null
      const finish = (value) => {
        if (done) return
        done = true
        this.jpegWaiters.delete(finish)
        if (timer !== null) {
          clearTimeout(timer)
          this.forgetTimer(timer)
        }
        resolve(value)
      }
      this.jpegWaiters.add(finish)
      /* 代际校验：等帧的定时器可能在 stop() 之后才到期（已取消的 timer 仍可能已入队）。 */
      const gen = this.generation
      timer = this.trackTimer(setTimeout(() => {
        this.forgetTimer(timer)
        if (gen !== this.generation) {
          finish(null)
          return
        }
        finish(this.jpeg !== null && Date.now() - this.jpegAt < 2500 ? this.jpeg : null)
      }, Math.max(120, ms)))
      timer.unref?.()
    })
  }

  /** 桥接帧是不是新鲜的（拿来判断该不该回退到 screencap）。 @returns {boolean} 新鲜为 true。 */
  jpegFresh() {
    return this.jpeg !== null && Date.now() - this.jpegAt < 1200
  }

  /** 观众都走了：留一段宽限再停，重开侧栏就不用重新起流。 @returns {void} */
  /**
   * 有人读过帧：把停止宽限拉长到 keepalive，下次视觉读免冷启。
   * @param {number} [ms] - 宽限毫秒数。
   * @returns {void}
   */
  keepWarm(ms = VISION_KEEPALIVE_MS) {
    if (ms <= this.idleGrace) return
    this.idleGrace = ms
    if (this.idleTimer === null) this.scheduleIdleStop()
  }

  scheduleIdleStop(delayMs = this.idleGrace ?? IDLE_GRACE_MS) {
    if (this.idleTimer !== null) return
    if (this.idleArmedAt === 0) this.idleArmedAt = Date.now()
    /* 代际校验：已取消但已入队的回调仍会跑一次，换过代就不许它再动状态。 */
    const gen = this.generation
    this.idleTimer = this.trackTimer(setTimeout(() => this.guard('idle-stop', () => {
      this.forgetTimer(this.idleTimer)
      this.idleTimer = null
      this.idleArmedAt = 0
      if (gen !== this.generation) return
      if (this.clients.size > 0 || this.waiting.size > 0) return
      /* 只看帧的人每隔一秒来一次，取帧时间戳会被不断刷新；差多少补多少，不重复排满宽限。 */
      /* 镜像那边还有常连观看者（/live）时不能停：它不走 clients，只靠这个回调说话。 */
      if (typeof this.stillWanted === 'function' && this.stillWanted()) {
        this.scheduleIdleStop()
        return
      }
      /* 宽限从「最后一次有人看」起算；jpegWantedAt 只有走 /frame 才会被刷新，
         单靠它会让 left 永远等于满宽限，于是反复重排、空闲流永远不释放（实测 132 秒后还在推）。 */
      const now = Date.now()
      const lastSeen = Math.max(
        Number(this.jpegWantedAt) || 0,
        Number(this.lastViewerAt) || 0,
        Number(this.idleArmedAt) || 0,
      )
      const left = (this.idleGrace ?? IDLE_GRACE_MS) - (now - lastSeen)
      if (left > 250) {
        this.scheduleIdleStop(left)
        return
      }
      this.stop()
    }), Math.max(0, delayMs)))
    this.idleTimer.unref?.()
  }

  /** 有人在看才开始录，没人看一会儿就停，省设备电和带宽。 @returns {void} */
  start() {
    if (this.stopping || this.spawning) return
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.forgetTimer(this.idleTimer)
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
  /**
   * 要设备端重发一帧关键帧（走 scrcpy 控制消息，不重建链路）。
   * 静止画面下编码器不出帧，面板打开后会一直黑；主动要一帧比反复重建采集链路省得多。
   * @returns {boolean} 是否真的发了请求
   */
  requestFrame() {
    const source = this.scrcpy
    if (source === null || this.stopping) return false
    let sent = false
    this.guard('request-frame', () => {
      if (typeof source.requestKeyFrame === 'function') sent = source.requestKeyFrame() === true
    })
    if (sent) this.frameReqAt = Date.now()
    this.debug('requestFrame ' + (sent ? 'ok' : 'skip'))
    return sent
  }

  rekey() {
    if (this.stopping) return
    /* scrcpy 采集源没有「重启录屏换 IDR」这条路：只清转封装，等它自己下一个关键帧。 */
    if (this.scrcpy !== null) {
      this.init = null
      this.lastKeyChunks = []
      this.lastKeyBytes = 0
      this.closeRemuxer()
      /* 新 ffmpeg 要从 SPS/PPS 起步：把通道缓存的参数集再喂一遍。 */
      this.guard('scrcpy-rekey-prelude', () => {
        const warm = this.scrcpy?.prelude
        if (Buffer.isBuffer(warm) && warm.length > 0) this.feedRaw(warm)
      })
      return
    }
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
   * 收尾时横扫本插件留下的所有录屏 pid 文件（换源/重建会换来换去，只杀最后一只就会漏）。
   * 仍然逐个核对进程名是 screenrecord，绝不动别人的录屏。
   * @returns {void}
   */
  sweepOwnRecorders() {
    /* pid 文件靠不住：adb 子进程先退出时会把文件删掉，设备端的 screenrecord 还活着。
       所以按命令行里的 dsh-mobile-use-stream- 标记认领壳进程，再按 PPID 收它的子进程。 */
    const marker = `dsh-mobile-use-stream-${String(this.serial).replace(/[^\w.-]/g, '_')}-`
    const script = `w=$(ps -A -o PID,ARGS 2>/dev/null | grep -F '${marker}' | grep -v grep | awk '{print $1}'); `
      + `for p in $w; do k=$(ps -A -o PID,PPID 2>/dev/null | awk -v P="$p" '$2==P{print $1}'); `
      + `for c in $k; do kill -9 "$c" 2>/dev/null; echo swept:$c; done; kill -9 "$p" 2>/dev/null; done; `
      + `x=$(ps -A -o PID,ARGS 2>/dev/null | grep 'screenrecord --output-format=h264' | grep -v grep | grep -F -- '--time-limit=${RECORD_LIMIT}' | awk '{print $1}'); for c in $x; do kill -9 "$c" 2>/dev/null; echo swept-orphan:$c; done; ` + `rm -f ${this.recorderPidPrefix}*.pid 2>/dev/null; echo sweep-done`
    try {
      const child = spawn(this.adbPath, ['-s', this.serial, 'shell', script], { stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      child.stdout?.on('data', (chunk) => { out = (out + String(chunk)).slice(-200) })
      child.on('exit', () => this.debug('sweep ' + (out.trim() || 'no-reply')))
      child.on('error', () => this.debug('sweep spawn-error'))
      child.unref?.()
    } catch {
      this.debug('sweep threw')
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

  /**
   * 登记一个定时器：所有者就是本对象，取消入口是 clearTimers() / stop()。
   * 定时器一律进集合，不许有「起了就没人记得」的裸 setTimeout。
   * @param {any} timer - setTimeout/setInterval 的返回值。
   * @returns {any} 同一个 timer，方便 `this.xTimer = this.trackTimer(setTimeout(...))`。
   */
  trackTimer(timer) {
    if (!(this.timers instanceof Set)) this.timers = new Set()
    if (timer != null) this.timers.add(timer)
    return timer
  }

  /** 摘掉一个已经自己结束的定时器（不取消，只清账）。 @param {any} timer - 定时器。 @returns {void} */
  forgetTimer(timer) {
    this.timers?.delete?.(timer)
  }

  /** 取消并清空所有登记在案的定时器：stop() 的第一批动作。 @returns {number} 取消了几个。 */
  clearTimers() {
    const timers = this.timers
    if (!(timers instanceof Set)) return 0
    let count = 0
    for (const timer of [...timers]) {
      /* 有 unref 的 timer 和 interval 用同一个 clearTimeout 也能取消，但分开调更明确。 */
      this.guard('clear-timer', () => clearTimeout(timer))
      count += 1
    }
    timers.clear()
    return count
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

  /* 开录前定一次尺寸：按当前朝向的显示尺寸等比缩到长边 2400，长边不足就不放大。
     必须用 `cur=WxH`（当前朝向）而不是 `wm size`（物理端口）：横屏时按物理竖屏尺寸录，
     编码器会把横向画面整条塞进竖屏画布，帧里 60% 是黑边、文字被压成一半高。
     同步跑一条 adb（~150ms），缓存 90s；转了屏最迟 90s 或下次重开录屏时跟上。失败退回 720x1280。 */
  ensureSize() {
    if (this.sizeFixed && Date.now() - this.sizeAt < 90_000) return
    this.sizeFixed = true
    this.sizeAt = Date.now()
    let w = 0
    let h = 0
    try {
      const out = execFileSync(this.adbPath, ['-s', this.serial, 'shell', "wm size; dumpsys window displays | grep -m1 -oE 'cur=[0-9]+x[0-9]+'"], { timeout: 6000, encoding: 'utf8' })
      const cur = /cur=(\d+)x(\d+)/.exec(String(out))
      const hit = cur ?? /(\d+)\s*x\s*(\d+)/.exec(String(out))
      if (hit !== null) {
        w = Number(hit[1])
        h = Number(hit[2])
      }
    } catch (error) {
      this.debug('display size failed ' + String(error?.message ?? error).slice(0, 60))
    }
    if (!(w > 8 && h > 8)) {
      this.width = 720
      this.height = 1280
      return
    }
    const long = Math.max(w, h)
    const scale = Math.min(1, 2400 / long)
    const nw = Math.max(2, Math.round((w * scale) / 2) * 2)
    const nh = Math.max(2, Math.round((h * scale) / 2) * 2)
    this.width = nw
    this.height = nh
    if (!this.bitrateFixed && nw * nh > 720 * 1280 * 2) this.bitrate = 12_000_000
  }

  spawnRecorder() {
    if (this.stopping) return
    /* 有 scrcpy 通道就直接吃它的 H.264：连续出帧、延迟低，不用设备端再开一个编码器。 */
    if (this.sourceWait !== null && Date.now() - this.sourceWaitAt > 8000) {
      /* 等采集源就绪：超时/起不来就照旧起 screenrecord，下一轮 spawn 再试。 */
      const gen = this.generation
      const beganAt = Date.now()
      const attempt = () => {
        Promise.resolve(this.sourceWait(4000))
          .then((source) => {
            this.guard('scrcpy-wait-done', () => {
              if (this.stopping || this.generation !== gen || this.scrcpy !== null) return
              if (source !== null && source !== undefined && this.attachScrcpy(source)) return
              /* 通道还在连就别掉到录屏：那会先出一张 720p 再切回来，用户看到的是十几秒的等待。 */
              const state = this.sourceState === null ? 'idle' : this.sourceState()
              /* 只要通道不是明确失败就继续等：冷启动时 adb 正忙着推 server，
                 4 秒等不到很正常，这时候掉到录屏会把编码器抢走，反而让 scrcpy 彻底起不来。 */
              if (state !== 'failed' && Date.now() - beganAt < 12000) {
                this.guard('scrcpy-wait-again', () => { attempt() })
                return
              }
              this.sourceWaitAt = Date.now()
              this.spawnRecorder()
            })
          })
          .catch(() => {
            this.guard('scrcpy-wait-fail', () => {
              if (this.stopping || this.generation !== gen || this.scrcpy !== null) return
              this.sourceWaitAt = Date.now()
              this.spawnRecorder()
            })
          })
      }
      this.guard('scrcpy-wait', () => { attempt() })
      return
    }
    /* 上一个模块实例（重载、探针、旧会话）留下的 screenrecord 会一直占着设备唯一的编码器，
       新推流拿到的是一张永久空白的 h264 流：表现为热身永远不结束。开录前清一次孤儿进程。 */
    if (!this.deviceSwept) {
      this.deviceSwept = true
      try {
        execFileSync(this.adbPath, ['-s', this.serial, 'shell', 'pkill -f screenrecord'], { timeout: 4000, stdio: 'ignore' })
      } catch (error) {
        this.debug('sweep-screenrecord failed ' + String(error?.message ?? error).slice(0, 80))
      }
    }
    this.ensureSize()
    const source = this.pickSource()
    if (source !== null && this.attachScrcpy(source)) return
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

  /**
   * 把 scrcpy 通道接成采集源：视频包原样喂给同一条转封装链（ffmpeg → fMP4 → 前端）。
   * @param {any} source - 已就绪的 scrcpy 通道。
   * @returns {boolean} 接上为 true。
   */
  /**
   * 同步问一下采集源；冷期里一律当没有（避免通道不产帧时反复重挂）。
   * @returns {any | null} 就绪的通道。
   */
  pickSource() {
    if (Date.now() < this.scrcpyHoldUntil) return null
    if (this.sourceReady === null) return null
    /* 注意：guard() 只负责兜住异常、不返回值，取通道必须直接调。 */
    try {
      const source = this.sourceReady()
      return source === undefined ? null : source
    } catch (error) {
      this.debug('scrcpy-source 异常: ' + String(error?.message ?? error))
      return null
    }
  }

  attachScrcpy(source) {
    if (this.stopping || source === null || typeof source.on !== 'function') return false
    this.sessions += 1
    this.recorderPaused = false
    this.scrcpy = source
    const gen = this.generation
    let fed = 0
    /* liveFed 只数真从设备来的包：prelude 回放也算 fed，用它判断「有没有出画面」会被骗，
       首帧探测一上来就以为有帧，静止画面就永远黑着。 */
    let liveFed = 0
    const attachAt = Date.now()
    this.fedCount = 0
    const onPacket = (packet) => this.guard('scrcpy-packet', () => {
      if (gen !== this.generation || this.stopping || this.scrcpy !== source) return
      const data = packet?.data
      if (!Buffer.isBuffer(data) || data.length === 0) return
      fed += 1
      liveFed += 1
      this.fedCount += 1
      if (liveFed === 1) {
        this.firstPacketAt = Date.now()
        this.debug('scrcpy 首包 +' + String(Date.now() - attachAt) + 'ms')
      }
      this.frameTries = 0
      if (this.frameRetryTimer !== null) {
        clearTimeout(this.frameRetryTimer)
        this.forgetTimer(this.frameRetryTimer)
        this.frameRetryTimer = null
      }
      if (this.scrcpyTimer !== null) {
        clearTimeout(this.scrcpyTimer)
        this.forgetTimer(this.scrcpyTimer)
        this.scrcpyTimer = null
      }
      this.feedRaw(data, packet?.pts)
    })
    const onGone = () => this.guard('scrcpy-gone', () => {
      this.debug('scrcpy 通道断开 gen=' + String(gen))
      if (gen !== this.generation) return
      this.detachScrcpy()
      if (this.stopping) return
      this.closeRemuxer()
      if (this.clients.size > 0 || this.waiting.size > 0) this.scheduleRestart()
    })
    try {
      source.on('video-packet', onPacket)
      source.once?.('closed', onGone)
    } catch {
      this.scrcpy = null
      return false
    }
    this.scrcpyBound = { source, onPacket, onGone }
    /* 后来的消费者错过了开头的 SPS/PPS 和 IDR：补喂缓存的一份，否则 ffmpeg 只会报 dimensions not set、观众一直黑屏。 */
    this.guard('scrcpy-prelude', () => {
      const warm = Buffer.isBuffer(source.replay) ? source.replay : source.prelude
      if (Buffer.isBuffer(warm) && warm.length > 0) {
        fed += 1
        this.fedCount += 1
        this.feedRaw(warm)
      }
    })
    /* 静止画面下 server 起流后可能一张都不发：主动要一帧，观众才有画面可看。
       控制通道可能比视频通道晚连上，所以头两秒重试几次，拿到包就停。 */
    this.guard('scrcpy-request-frame', () => {
      if (fed === 0) this.requestFrame()
    })
    let tries = 0
    const askAgain = () => {
      this.forgetTimer(this.frameRetryTimer)
      this.frameRetryTimer = null
      if (gen !== this.generation || this.stopping || this.scrcpy !== source || fed > 0) return
      tries += 1
      this.requestFrame()
      if (tries < 3) {
        this.frameRetryTimer = this.trackTimer(setTimeout(askAgain, 700))
        this.frameRetryTimer.unref?.()
      }
    }
    this.frameRetryTimer = this.trackTimer(setTimeout(askAgain, 500))
    this.frameRetryTimer.unref?.()
    /* 通道可能「连着但不出帧」。注意静止画面本来就不出帧，所以不能一没包就判死：
       先用控制消息请它出一帧，请不到（控制通道不可写 / 请了几次仍然没包）才退回 screenrecord。 */
    let probes = 0
    let blind = 0
    const probeFirstFrame = () => {
      this.forgetTimer(this.scrcpyTimer)
      this.scrcpyTimer = null
      /* 停的条件是「已经能从这条流解出 moov」，不是「收到过包」：
         server 起流时先发一个只有 SPS/PPS 的配置包，liveFed 立刻变 1，但一帧画面都没有，
         照旧按 liveFed 停探针，就会一直等到编码器下一次碰巧出帧（实测 5~7 秒）。 */
      if (gen !== this.generation || this.stopping || this.init !== null || this.scrcpy === null) return
      probes += 1
      const asked = this.requestFrame()
      if (!asked) blind += 1
      if (probes >= 3 && blind === probes) {
        this.debug('scrcpy 控制通道不可用，退回 screenrecord')
        this.scrcpyHoldUntil = Date.now() + 8000
        this.detachScrcpy()
        if (this.clients.size > 0 || this.waiting.size > 0) this.spawnRecorder()
        return
      }
      if (probes < 8) {
        this.scrcpyTimer = this.trackTimer(setTimeout(probeFirstFrame, 700))
        this.scrcpyTimer.unref?.()
        return
      }
      /* 请了 8 次还是不出帧：先换一条 scrcpy 通道（设备端 server 可能是死的、socket 半开），
         换不到才退回 screenrecord。之前直接掉到 screenrecord，那条路出一帧都难，
         于是整条链路在「重建 → 还是黑 → 再重建」里空转，冷启动永远起不来。 */
      this.debug('scrcpy 请帧无效，重接通道')
      this.scrcpyHoldUntil = Date.now() + 1500
      this.detachScrcpy()
      if (this.clients.size > 0 || this.waiting.size > 0) this.guard('reprobe-source', () => {
        /* 延迟重接：必须进 timers 集合，否则 stop() 之后它还会把新链路拉起来。 */
        const reprobe = this.trackTimer(setTimeout(() => {
          this.forgetTimer(reprobe)
          this.guard('reprobe-spawn', () => {
            if (this.stopping || gen !== this.generation) return
            this.scrcpyHoldUntil = 0
            this.spawnRecorder()
          })
        }, 1500))
        reprobe.unref?.()
      })
    }
    /* 冷启动时 scrcpy 还在往设备推 server、编码器还没起，太早请帧没人接：
       第一次放到 2.5 秒，之后每秒再请一次，共 4 次（约 6 秒）。 */
    this.scrcpyTimer = this.trackTimer(setTimeout(probeFirstFrame, 800))
    this.scrcpyTimer.unref?.()
    this.debug('scrcpy 采集源已接上 gen=' + String(gen))
    return true
  }

  /** 拆掉 scrcpy 采集源（幂等，不碰通道本身的开关）。 @returns {void} */
  detachScrcpy() {
    const bound = this.scrcpyBound
    this.scrcpy = null
    this.scrcpyBound = null
    if (this.scrcpyTimer !== null) {
      this.guard('scrcpy-timer-clear', () => clearTimeout(this.scrcpyTimer))
      this.forgetTimer(this.scrcpyTimer)
      this.scrcpyTimer = null
    }
    if (this.frameRetryTimer !== null) {
      this.guard('frame-timer-clear', () => clearTimeout(this.frameRetryTimer))
      this.forgetTimer(this.frameRetryTimer)
      this.frameRetryTimer = null
    }
    if (bound === null) return
    this.guard('scrcpy-detach', () => {
      bound.source?.removeListener?.('video-packet', bound.onPacket)
      bound.source?.removeListener?.('closed', bound.onGone)
    })
  }

  /** 到点自动续上，避免中断超过半秒。 @returns {void} */
  scheduleRestart() {
    if (this.stopping || this.restartTimer !== null) return
    if (this.clients.size === 0 && this.waiting.size === 0) return
    const gen = this.generation
    this.restartTimer = this.trackTimer(setTimeout(() => this.guard('restart', () => {
      this.forgetTimer(this.restartTimer)
      this.restartTimer = null
      /* 代际校验：换成这一代的 stop() 已经跑过后，这个迟到回调不许再起新录屏。 */
      if (gen !== this.generation) return
      if (!this.stopping && (this.clients.size > 0 || this.waiting.size > 0)) {
        /* 上一轮可能是被 SIGKILL 的 adb：先按自己的 pid 清掉设备端残留，再开新录屏。 */
        this.killOwnRecorder()
        this.spawnRecorder()
      }
    }), 120))
    this.restartTimer.unref?.()
  }

  /** 有裸流分片就交给 ffmpeg；顺手记录编码参数。 @param {Buffer} chunk - 裸 H.264。 @returns {void} */
  feedRaw(chunk, ptsUs = null) {
    this.bytes += chunk.length
    this.lastAt = Date.now()
    if (this.firstFrameAt === 0) this.firstFrameAt = this.lastAt
    if (this.config === null) {
      /* SPS 可能被切在两个分片之间，攒一段再解析。注意不能在拼接后就截尾：
         冷启动第一块就是整段 replay（几 MB），SPS/PPS 在最前面，一截尾就把它们丢了，
         于是 config 永远是 null、客户端收不到 meta.codec，画面全黑。 */
      const merged = this.prelude.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.prelude, chunk])
      const config = parseAvcConfig(merged)
      this.prelude = merged.length > 4 * 1024 * 1024 ? merged.subarray(-2 * 1024 * 1024) : merged
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
      /* 时间戳来源每段 ffmpeg 只认一种：scrcpy 给的是设备开机微秒（实测 2 亿多毫秒，远大于
         任何主机时间），screenrecord 回退路径没有逐帧时间，只能按到达时刻算；两者混用会让
         一端永远「更小」，于是每帧都被压成 +16 ms 的固定步长，时间轴整段失真。
         closeRemuxer() 会清空 ptsOriginUs，切换采集源时重新起算。 */
      let stamp
      if (ptsUs === null || ptsUs === undefined) {
        const now = Date.now() * 1000
        if (this.ptsOriginUs === 0) this.ptsOriginUs = now
        stamp = now - this.ptsOriginUs
      } else {
        const real = Number(ptsUs) || 0
        if (real > 0) {
          if (this.ptsOriginUs === 0) this.ptsOriginUs = real
          stamp = real - this.ptsOriginUs
        } else {
          /* 参数集、会话包的 pts 是 0：不推进时间轴，跟着上一帧走。 */
          stamp = this.lastPtsUs
        }
      }
      if (stamp <= this.lastPtsUs) stamp = this.lastPtsUs + 16000
      this.lastPtsUs = stamp
      const muxed = this.tsMux.push(chunk, stamp)
      if (muxed.length > 0 && mp4In.write(muxed) === false) this.pauseForRemuxer(remuxer)
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
    /* 代际校验：这一代 stop 之后，卡死判定和 drain 回调都不许再动状态。 */
    const gen = this.generation
    let timer = this.trackTimer(setTimeout(() => this.guard('remux-stall', () => {
      this.forgetTimer(timer)
      timer = null
      if (gen !== this.generation) return
      if (this.remuxer === remuxer) {
        this.error = 'ffmpeg 2 秒未消费数据，已重建'
        this.closeRemuxer()
        /* 重新要一张 IDR：新 ffmpeg 从 SPS 开始才解得对。 */
        this.rekey()
      }
      this.resumeRecorder()
    }), REMUX_STALL_MS))
    timer.unref?.()
    remuxer.stdin.once('drain', () => this.guard('remux-drain', () => {
      if (timer !== null) {
        clearTimeout(timer)
        this.forgetTimer(timer)
        timer = null
      }
      if (gen !== this.generation) return
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
      /* 输入是我们自己封的 MPEG-TS：每一帧的 PTS 来自设备端，ffmpeg 不用再猜时间。
         别再改回 -f h264 + -use_wallclock_as_timestamps：那条路把到达时刻当帧时刻，
         成批到达的帧会被戳成一串近似相同的时间戳，时间轴失真、前端缓冲只有几十毫秒。 */
      /* ffmpeg 默认要攒 5MB / 5 秒才认出流（probesize+analyzeduration）：静止画面下就是
         5 秒黑屏。我们的 TS 是自己封的，第一包就带 SPS/PPS，给它 32KB / 0 秒足够认流。 */
      '-probesize', '32000', '-analyzeduration', '0',
      '-f', 'mpegts', '-i', 'pipe:0',
      '-c', 'copy', '-frag_duration', String(this.fragMs * 1000),
      '-movflags', 'empty_moov+default_base_moof',
      /* 每片写完立刻吐出去，别等内部缓冲攒满：一攒就是几十到上百毫秒的显示延迟。 */
      '-flush_packets', '1', '-max_delay', '0',
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

  /**
   * 黑屏自愈：有观众却超过 8 秒还没拿到 moov，说明采集这条链已经死了（设备端残留、管道断了、
   * 通道连着不出帧）。重建前先按自己的 pid 收掉设备端录屏，再换一条新链路。
   * 只盯「没有初始化段」这一种：静止画面本来就不产帧，不能按帧龄判死。
   * @returns {void}
   */
  checkHealth() {
    if (this.stopping) return
    const viewers = this.clients.size + this.waiting.size
    if (viewers === 0) {
      this.viewerSince = 0
      this.revivedAt = 0
      /* 走视觉的人不进 clients/waiting：镜像没开、只用 adb_ocr/adb_look 时观众数就是 0。
         这种情况下面那段判死完全跑不到，于是「宿主 ffmpeg 活着、设备 screenrecord 已死」
         会一直装健康——每次视觉读都回退 screencap（实测 531–893 ms），长会话里越来越慢。
         真机实测过的现场：ffmpeg 跑了 8 分钟、CPU 55 s、jpegFresh() 恒 false。
         只在确实还想看帧（宽限内读过）时修，空闲的流不许被修活。 */
      if (this.jpegChild === null || this.stopping) return
      const wanted = Number(this.jpegWantedAt) || 0
      if (wanted === 0 || Date.now() - wanted >= (this.idleGrace ?? IDLE_GRACE_MS)) return
      if (this.revivedAt !== 0 && Date.now() - this.revivedAt < WATCH_COOLDOWN_MS) return
      const started = Number(this.jpegStartedAt) || 0
      const lastFrame = Number(this.jpegAt) || 0
      const stale = lastFrame > 0 ? Date.now() - lastFrame : (started > 0 ? Date.now() - started : 0)
      const limit = lastFrame > 0 ? JPEG_STALL_MS : JPEG_INIT_STALL_MS
      if (stale < limit) return
      this.revivedAt = Date.now()
      this.debug('看门狗：JPEG 桥接 ' + String(Math.round(stale / 1000)) + ' 秒没有新帧，重建采集链路')
      this.reviveSource()
      return
    }
    if (this.init !== null) {
      this.viewerSince = Date.now()
      const lastAt = Number(this.lastAt) || 0
      if (lastAt === 0 || Date.now() - lastAt < WATCH_STALL_MS) {
        this.revivedAt = 0
        this.stallTries = 0
        return
      }
      if (this.revivedAt !== 0 && Date.now() - this.revivedAt < WATCH_COOLDOWN_MS) return
      /* 第一次判停顿只请一帧：静态画面本来就不出片，请帧回来的片就是活着的证据。 */
      if ((Number(this.stallTries) || 0) === 0) {
        this.stallTries = 1
        if (this.requestFrame()) return
      }
      this.stallTries = 0
      this.revivedAt = Date.now()
      this.debug('看门狗：' + String(Math.round(WATCH_STALL_MS / 1000)) + ' 秒没有新分片，重建采集链路')
      this.reviveSource()
      return
    }
    if (this.viewerSince === 0) {
      this.viewerSince = Date.now()
      return
    }
    if (Date.now() - this.viewerSince < WATCH_INIT_MS) return
    if (this.revivedAt !== 0 && Date.now() - this.revivedAt < WATCH_COOLDOWN_MS) return
    /* 先要一帧：静止画面本来就不出帧，为这个重建整条链路是白烧设备。 */
    if (this.scrcpy !== null) {
      const tries = Number(this.frameTries) || 0
      if (tries === 0) {
        this.frameTries = 1
        if (this.requestFrame()) return
      }
    }
    this.revivedAt = Date.now()
    this.viewerSince = Date.now()
    this.debug('看门狗：' + String(Math.round(WATCH_INIT_MS / 1000)) + ' 秒没有初始化段，重建采集链路')
    this.reviveSource()
  }

  /** 起一个 2 秒的看门狗；没人看的时候它自己空转，不碰设备。 @returns {void} */
  armWatch() {
    if (this.watchTimer !== null) return
    /* 看门狗是独立故障域：换代之后它必须自己停，不能替新一代判死。 */
    const gen = this.generation
    this.watchTimer = this.trackTimer(setInterval(() => this.guard('watchdog', () => {
      if (gen !== this.generation || this.stopping) {
        this.guard('watchdog-stale', () => clearInterval(this.watchTimer))
        this.forgetTimer(this.watchTimer)
        this.watchTimer = null
        return
      }
      this.checkHealth()
    }), WATCH_TICK_MS))
    this.watchTimer.unref?.()
  }

  /**
   * 整条采集链路重建：本地进程、转封装、scrcpy 绑定都拆掉再起一份，
   * 不能让「连着但不出帧」的通道一直挂着。
   * @returns {void}
   */
  reviveSource() {
    if (this.stopping) return
    this.error = '采集卡住，已自动重建'
    this.intentional = true
    const child = this.recorder
    this.recorder = null
    this.guard('revive-kill-own', () => this.killOwnRecorder())
    this.guard('revive-detach', () => this.detachScrcpy())
    this.init = null
    this.initAt = 0
    this.lastKeyChunks = []
    this.lastKeyBytes = 0
    this.scrcpyHoldUntil = 0
    this.sourceWaitAt = 0
    this.guard('revive-close-remuxer', () => this.closeRemuxer())
    if (child !== null) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经退了 */
      }
    }
    this.guard('revive-spawn', () => {
      /* 先试 scrcpy：设备端 server 还活着时它能立刻给一张 IDR，screenrecord 要从零起编码器。
         之前这里直接 spawnRecorder，一次看门狗就把整条链路永久钉在回退路径上。 */
      if (Date.now() - this.sourceWaitAt > 8000) {
        const source = this.pickSource()
        if (source !== null && this.attachScrcpy(source)) return
      }
      this.spawnRecorder()
    })
  }

  /** 关掉 ffmpeg，等下一次录屏重开。 @returns {void} */
  closeRemuxer() {
    const child = this.remuxer
    this.remuxer = null
    this.init = null
    this.initAt = 0
    this.pending = Buffer.alloc(0)
    this.buffer = Buffer.alloc(0)
    this.initPending = Buffer.alloc(0)
    this.frag = Buffer.alloc(0)
    this.lastKeyChunks = []
    this.lastKeyBytes = 0
    this.tsMux.reset()
    this.lastPtsUs = 0
    this.ptsOriginUs = 0
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
        this.debug('moov 就绪 +' + String(Date.now() - (Number(this.firstPacketAt) || Date.now())) + 'ms（自首包）')
        this.initAt = Date.now()
        this.timescale = readTimescale(box)
        this.initPending = Buffer.alloc(0)
        this.broadcast(packFrame(FRAME_INIT, this.init))
        /* 还在等 IDR 的观众也先收初始化段：他们缺的只是解码起点，不是解码器配置，
           等下一张 IDR 再一起补，黑屏会多好几秒。 */
        for (const sink of this.waiting) {
          try {
            sink(packFrame(FRAME_INIT, this.init))
            sink.__initSent = true
          } catch {
            this.waiting.delete(sink)
          }
        }
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
    /* 代际校验：stop() 之后残留在管道里的最后一帧不许再往已拆掉的客户端里灌。 */
    if (this.stopping) return
    this.framesSeen += 1
    this.lastAt = Date.now()
    this.stallTries = 0
    const pts = readTfdt(chunk, this.timescale ?? 90000)
    if (pts >= 0) {
      this.lastPts = pts
      /* 宿主时钟 ↔ 分片 PTS 的换算基准：同一份 ffmpeg 会跨多次订阅复用，PTS 从 ffmpeg
         启动那刻算起，跟 startedAt 不是同一个原点。拿它才能算出真实的端到端延迟。 */
      this.ptsOriginMs = Date.now() - pts * 1000
    }
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
    if (promoted.length > 0) {
      this.waiting.clear()
      this.debug('关键帧到达，放行 ' + String(promoted.length) + ' 人')
    }
    this.broadcast(packFrame(FRAME_MEDIA, chunk))
    /* 新观众进场：scrcpy 在静止画面上不出帧，光回放 INIT 等于给一张黑图。
       不管是冷启动（还没 moov）还是热重连（有 moov、但画面停住），都要请一帧，
       1.2 秒内最多一次，避免每次重连都轰设备。 */
    if (this.scrcpy !== null && (this.init === null || Date.now() - (Number(this.lastAt) || 0) > 400) && Date.now() - (Number(this.frameReqAt) || 0) > 1200) this.requestFrame()
    for (const sink of promoted) {
      /* 已经在新观众进场时统一请过帧，这里不再重复。 */
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
   * 请设备给一张 IDR。scrcpy 在静止画面上可以几十秒不出关键帧，
   * 而新观众必须有 IDR 才能解码，所以每个「该有画面了」的节点都走这里，900ms 内只发一次。
   * @param {string} why - 触发原因，写进调试日志。
   * @returns {void}
   */
  askKeyFrame(why) {
    if (this.scrcpy === null) return
    if (Date.now() - (Number(this.frameReqAt) || 0) < 900) return
    this.guard('ask-keyframe', () => {
      this.debug('请关键帧：' + why)
      this.requestFrame()
    })
  }

  /**
   * 新观众入场：先给初始化段 + 最近一个 keyframe 起的分片，再进直播。
   * @param {(bytes: Buffer) => void} sink - 写响应的函数。
   * @returns {() => void} 退订函数。
   */
  subscribe(sink) {
    if (typeof sink !== 'function') throw new TypeError('subscribe: sink 必须是函数')
    /* 配额：每个流最多 MAX_SUBSCRIBERS 个观众。超了直接拒绝（/stream 那边转成断开），
       clients / waiting 两个 Set 不许跟着请求数无界长。 */
    if (this.clients.size + this.waiting.size >= MAX_SUBSCRIBERS) {
      this.subscriberRejects += 1
      throw new Error(`订阅数已达上限 ${String(MAX_SUBSCRIBERS)}`)
    }
    this.start()
    const gen = this.generation
    this.debug('观众订阅 init=' + String(this.init !== null) + ' 源=' + String(this.scrcpy !== null) + ' 客户端=' + String(this.clients.size) + '/' + String(this.waiting.size))
    this.lastViewerAt = Date.now()
    if (this.viewerSince === 0) this.viewerSince = Date.now()
    this.armWatch()
    if (this.init !== null && this.lastKeyChunks.length > 0) {
      this.sendPrelude(sink)
      this.clients.add(sink)
    } else {
      /* 手上没有能解码的起点，先挂着，下一张 IDR 到了再补，避免解码器起不来。 */
      this.waiting.add(sink)
      this.debug('观众等关键帧 init=' + String(this.init !== null) + ' keyChunks=' + String(this.lastKeyChunks.length) + ' 源=' + String(this.scrcpy !== null))
      /* 等着也是等：直接请设备给一张。静止画面下不请，可能就是几十秒黑屏。 */
      this.askKeyFrame('观众等首帧')
      /* 设备只在开录时给一张 IDR，等下一张可能是几十秒；直接重开一次录屏换新 IDR。 */
      /* 刚起的录屏还没吐第一张 IDR 就别杀掉重开：等它自己出图。 */
      if (this.recorder !== null && this.restartTimer === null && Date.now() - this.startedAt > 700) this.rekey()
      this.sendPrelude(sink)
    }
    /* 退订是取消入口：幂等（重复调用不重复记「最后一个观众走了」），也按代际作废。 */
    let released = false
    return () => {
      if (released) return
      released = true
      this.clients.delete(sink)
      this.waiting.delete(sink)
      this.lastViewerAt = Date.now()
      if (gen !== this.generation) return
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
    /* moov 一到就先给过初始化段的观众不要再收一次：重复 INIT 会让前端重建 MediaSource、
       清空已缓冲的画面，看起来就是「忽然闪一下」。 */
    if (sink.__initSent !== true) {
      sink(packFrame(FRAME_INIT, this.init))
      sink.__initSent = true
    }
    for (const chunk of this.lastKeyChunks) sink(packFrame(FRAME_MEDIA, chunk))
  }

  /** 没人看了就停，别占着设备编码器。幂等：重复调用、对象已销毁都不抛。 @returns {void} */
  stop() {
    /* 幂等：stop 期间又被调（closed 回调、子进程 exit 回调）直接返回，不重复拆、不重复换代。
       stopDepth 在 finally 里复位，所以顺序的第二次 stop() 仍然是完整的一次收尾。 */
    if (this.stopDepth > 0) return
    this.stopDepth += 1
    try {
      /* 第 1 步永远是「作废这一代」：先置 stopping、再换 generation，之后所有 in-flight 的
         退出/重启/定时器回调都会被代际校验挡住，停止之后不会自己复活。 */
      this.stopping = true
      this.generation = (Number(this.generation) || 0) + 1
      this.viewerSince = 0
      this.revivedAt = 0
      this.closedAt = Date.now()
      /* 所有登记在案的定时器统一取消：它们的所有者就是本对象，取消入口就是这里。 */
      this.guard('stop-timers', () => this.clearTimers())
      this.watchTimer = null
      this.idleTimer = null
      this.restartTimer = null
      this.scrcpyTimer = null
      this.frameRetryTimer = null
      /* 清理方法可能没注入/已被替换（历史事故就是这么打崩 host 的），每一步单独兜底。 */
      this.guard('stop-scrcpy', () => this.detachScrcpy())
      this.guard('stop-remuxer', () => this.closeRemuxer())
      this.guard('stop-jpeg', () => this.closeJpeg())
      const child = this.recorder ?? null
      this.recorder = null
      /* 本地杀进程不等于设备端停了：先按自己记下的 pid 收掉设备端录屏，否则下一次开流会撞上。 */
      this.guard('stop-sweep-recorders', () => this.sweepOwnRecorders())
      this.guard('stop-device-recorder', () => this.killOwnRecorder())
      if (child !== null) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* 已经退了 */
        }
      }
      this.intentional = true
      this.init = null
      this.lastKeyChunks = []
      this.lastKeyBytes = 0
      this.waiting?.clear?.()
      this.config = null
      this.firstFrameAt = 0
    } finally {
      /* stopping 兼作「正在收尾」标志：收完必须复位，否则空闲回收之后 start() 再也起不来。 */
      this.stopping = false
      this.stopDepth -= 1
    }
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
      initReady: this.init !== null,
      waiting: this.waiting.size,
      gop: this.lastKeyChunks.length,
      framesSeen: this.framesSeen,
      initAt: this.initAt,
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
      /* 资源账：登记在案的定时器数、被配额挡下的订阅/等帧请求数、最近一次收尾时间。 */
      timers: this.timers instanceof Set ? this.timers.size : 0,
      subscriberRejects: this.subscriberRejects,
      jpegWaiterRejects: this.jpegWaiterRejects,
      closedAt: this.closedAt,
      /* 最近一片的解码时间与它距现在的秒数：两个数一起看就是整条链路的延迟。 */
      lastPts: this.lastPts ?? null,
      /* 端到端延迟的测量口径：Date.now() - (ptsOriginMs + mediaTime*1000)。 */
      ptsOriginMs: this.ptsOriginMs ?? null,
      ptsAgeMs: this.lastPts === null || this.lastPts === undefined ? null : Math.round(Date.now() - this.startedAt - this.lastPts * 1000),
      capture: this.scrcpy !== null ? 'scrcpy' : (this.recorder !== null ? 'screenrecord' : 'idle'),
    }
  }
}
