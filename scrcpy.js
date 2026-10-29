/**
 * scrcpy-server 低延迟通道：视频流解析 + 控制注入编码 + 生命周期壳。
 *
 * 本轮**不接进插件**（没有任何现有文件 import 它），因此这里只放纯逻辑和显式
 * 调用的类：`import` 本模块不 spawn 进程、不起定时器、不读设备、不发网络请求；
 * 构造函数同样什么都不启动，只有显式 `start()` 才会碰设备。
 *
 * 协议依据（vendor/scrcpy-server = scrcpy v5.0.1，见 docs/scrcpy.md）：
 *  - 首个 socket 先发 64 字节设备名（UTF-8，NUL 填充）：
 *    server/.../device/DesktopConnection.java `DEVICE_NAME_FIELD_LENGTH = 64`
 *  - 视频 socket 再发 codec id（u32 BE，`h264`/`h265`/`av1` 的 ASCII）
 *  - 之后每个包 12 字节包头（app/src/demuxer.c）：
 *      header[0] & 0x80 → session packet（分辨率变化），header[4..11] = width/height
 *      否则 media packet：u64 BE = flags + PTS（bit62=config、bit61=key frame、
 *      低 61 位 = PTS 微秒），u32 BE = payload 长度
 *  - 控制消息字节布局：app/src/control_msg.c `sc_control_msg_serialize()`
 *  - scrcpy 2.x–3.x（protocol < 4.0）包头是另一套（bit63=config、bit62=key frame、
 *    低 62 位 PTS，codec 元数据 12 字节带 width/height）；本模块用
 *    `protocol: 'v3'` 显式切换，默认 'v5'。
 *
 * 已知未验证：与真机的 socket 握手（adb push → 端口监听 → app_process 启动 →
 * 视频/控制 socket 顺序）没在本轮联调过，见 docs/scrcpy.md 的「未验证」一节。
 */

import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { randomInt } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { guardCall } from './stream.js'

/* ============================================================
 * 常量
 * ==========================================================*/

/** vendor 里放的 scrcpy-server 版本（客户端与 server 版本必须匹配）。 */
export const SCRCPY_SERVER_VERSION = '5.0.1'

/** 设备名固定字段长度。 */
export const DEVICE_NAME_FIELD_LENGTH = 64

/** 媒体 / session 包头固定 12 字节。 */
export const PACKET_HEADER_SIZE = 12

/** 单包上限：超过即视为流已失步（默认 8 MiB，够 4K 关键帧）。 */
export const MAX_PACKET_SIZE = 8 * 1024 * 1024

/** 协议形态。v5 = scrcpy >= 4.0（protocol 4.x），v3 = 2.x–3.x。 */
export const SCRCPY_PROTOCOL = Object.freeze({ V3: 'v3', V5: 'v5' })

/** 视频 codec id（ASCII 打成的 u32）。 */
export const CODEC_IDS = Object.freeze({
  H264: 0x68323634, // "h264"
  H265: 0x68323635, // "h265"
  AV1: 0x00617631, //  "\0av1"
  VP8: 0x00767038, //  "\0vp8"
  VP9: 0x00767039, //  "\0vp9"
})

/** protocol >= 4.0 的包头标志位（session 也占最高位）。 */
export const PACKET_FLAG = Object.freeze({
  SESSION: 1n << 63n,
  CONFIG: 1n << 62n,
  KEY_FRAME: 1n << 61n,
  PTS_MASK: (1n << 61n) - 1n,
})

/** protocol < 4.0 的包头标志位。 */
export const LEGACY_PACKET_FLAG = Object.freeze({
  CONFIG: 1n << 63n,
  KEY_FRAME: 1n << 62n,
  PTS_MASK: (1n << 62n) - 1n,
})

/** app/src/control_msg.h `enum sc_control_msg_type`（顺序即数值）。 */
export const CONTROL_MSG_TYPE = Object.freeze({
  INJECT_KEYCODE: 0,
  INJECT_TEXT: 1,
  INJECT_TOUCH_EVENT: 2,
  INJECT_SCROLL_EVENT: 3,
  BACK_OR_SCREEN_ON: 4,
  EXPAND_NOTIFICATION_PANEL: 5,
  EXPAND_SETTINGS_PANEL: 6,
  COLLAPSE_PANELS: 7,
  GET_CLIPBOARD: 8,
  SET_CLIPBOARD: 9,
  SET_DISPLAY_POWER: 10,
  ROTATE_DEVICE: 11,
  UHID_CREATE: 12,
  UHID_INPUT: 13,
  UHID_DESTROY: 14,
  OPEN_HARD_KEYBOARD_SETTINGS: 15,
  START_APP: 16,
  RESET_VIDEO: 17,
  CAMERA_SET_TORCH: 18,
  CAMERA_ZOOM_IN: 19,
  CAMERA_ZOOM_OUT: 20,
  RESIZE_DISPLAY: 21,
  SCAN_FILE: 22,
})

/** android.view.MotionEvent 的 action（前 4 个是本模块实际用到的）。 */
export const TOUCH_ACTION = Object.freeze({
  DOWN: 0,
  UP: 1,
  MOVE: 2,
  CANCEL: 3,
  OUTSIDE: 4,
  POINTER_DOWN: 5,
  POINTER_UP: 6,
  HOVER_MOVE: 7,
  SCROLL: 8,
  HOVER_ENTER: 9,
  HOVER_EXIT: 10,
  BUTTON_PRESS: 11,
  BUTTON_RELEASE: 12,
})

/** android.view.KeyEvent 的 action。 */
export const KEY_ACTION = Object.freeze({ DOWN: 0, UP: 1, MULTI: 2 })

/** scrcpy 约定的特殊 pointerId（64 位全 1 往下数，见 control_msg.h）。 */
export const POINTER_ID = Object.freeze({
  MOUSE: BigInt('0xFFFFFFFFFFFFFFFF'),
  GENERIC_FINGER: BigInt('0xFFFFFFFFFFFFFFFE'),
  VIRTUAL_FINGER: BigInt('0xFFFFFFFFFFFFFFFD'),
})

/** 触控消息长度（control_msg.c：type + action + pointerId + pos + pressure + buttons）。 */
export const TOUCH_MSG_SIZE = 32

/** 按键消息长度。 */
export const KEYCODE_MSG_SIZE = 14

/** INJECT_TEXT 单条上限（control_msg.h `SC_CONTROL_MSG_INJECT_TEXT_MAX_LENGTH`）。 */
export const INJECT_TEXT_MAX_LENGTH = 300

/** 常用 Android keycode（完整表见 android.view.KeyEvent）。 */
export const ANDROID_KEYCODE = Object.freeze({
  HOME: 3,
  BACK: 4,
  CALL: 5,
  ENDCALL: 6,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  TAB: 61,
  SPACE: 62,
  ENTER: 66,
  DEL: 67,
  MINUS: 69,
  PLUS: 81,
  MENU: 82,
  ESCAPE: 111,
  APP_SWITCH: 187,
})

/* ============================================================
 * 编码 / 解析用的小工具（纯函数）
 * ==========================================================*/

/** 夹到 u16 范围。 */
export function clampU16(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  if (number <= 0) return 0
  if (number >= 0xffff) return 0xffff
  return Math.round(number)
}

/** scrcpy 的 u16 定点压力值（0.0–1.0 → 0–65535）。 */
export function floatToU16Fp(pressure) {
  const number = Number(pressure)
  if (!Number.isFinite(number) || number <= 0) return 0
  if (number >= 1) return 0xffff
  return Math.round(number * 0xffff)
}

/** codec id → 名字；未知返回 null（0/1 是 scrcpy 的「禁用流」标记）。 */
export function codecName(codecId) {
  switch (codecId >>> 0) {
    case CODEC_IDS.H264:
      return 'h264'
    case CODEC_IDS.H265:
      return 'h265'
    case CODEC_IDS.AV1:
      return 'av1'
    case CODEC_IDS.VP8:
      return 'vp8'
    case CODEC_IDS.VP9:
      return 'vp9'
    default:
      return null
  }
}

/**
 * 按 UTF-8 边界截断到 maxBytes 以内（不会切坏多字节字符，等价于
 * scrcpy 的 sc_str_utf8_truncation_index）。
 */
export function truncateUtf8(text, maxBytes) {
  const source = String(text ?? '')
  const limit = Math.max(0, Math.floor(Number(maxBytes) || 0))
  if (Buffer.byteLength(source, 'utf8') <= limit) return source
  let used = 0
  let out = ''
  for (const char of source) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > limit) break
    used += size
    out += char
  }
  return out
}

/* ============================================================
 * 视频流解析
 * ==========================================================*/

/**
 * 解析 12 字节包头。
 * @param {Buffer} header
 * @param {{ protocol?: 'v3'|'v5' }} [options]
 * @returns {{ kind: 'media', pts: number, keyFrame: boolean, config: boolean, size: number }
 *          | { kind: 'session', width: number, height: number, clientResized: boolean }}
 */
export function parseFrameHeader(header, options = {}) {
  const protocol = options.protocol ?? SCRCPY_PROTOCOL.V5
  if (!Buffer.isBuffer(header) || header.length < PACKET_HEADER_SIZE) {
    throw new RangeError(`帧头需要 ${PACKET_HEADER_SIZE} 字节，实际 ${header?.length ?? 0}`)
  }

  // protocol >= 4.0：最高位=1 的是 session packet（换分辨率），不是媒体包。
  if (protocol === SCRCPY_PROTOCOL.V5 && (header[0] & 0x80) !== 0) {
    return {
      kind: 'session',
      width: header.readUInt32BE(4),
      height: header.readUInt32BE(8),
      clientResized: (header[3] & 1) === 1,
    }
  }

  const flags = header.readBigUInt64BE(0)
  const size = header.readUInt32BE(8)

  if (protocol === SCRCPY_PROTOCOL.V3) {
    return {
      kind: 'media',
      pts: Number(flags & LEGACY_PACKET_FLAG.PTS_MASK),
      keyFrame: (flags & LEGACY_PACKET_FLAG.KEY_FRAME) !== 0n,
      config: (flags & LEGACY_PACKET_FLAG.CONFIG) !== 0n,
      size,
    }
  }

  return {
    kind: 'media',
    pts: Number(flags & PACKET_FLAG.PTS_MASK),
    keyFrame: (flags & PACKET_FLAG.KEY_FRAME) !== 0n,
    config: (flags & PACKET_FLAG.CONFIG) !== 0n,
    size,
  }
}

/**
 * MediaCodec 吐出来的 H.264/H.265 是 AVCC（4 字节长度前缀的 NAL），
 * WebCodecs / 部分解码器要 Annex-B；这里只做格式转换，不解码。
 * @param {Buffer} data
 * @param {{ nalLengthSize?: number }} [options]
 * @returns {Buffer|null} 数据被截断时返回 null
 */
export function avccToAnnexB(data, options = {}) {
  if (!Buffer.isBuffer(data)) throw new TypeError('avccToAnnexB 需要 Buffer')
  const nalLengthSize = options.nalLengthSize ?? 4
  if (![1, 2, 3, 4].includes(nalLengthSize)) {
    throw new RangeError(`nalLengthSize 只能是 1–4，实际 ${nalLengthSize}`)
  }
  if (data.length === 0) return Buffer.alloc(0)

  const startCode = Buffer.from([0x00, 0x00, 0x00, 0x01])
  const parts = []
  let offset = 0
  while (offset < data.length) {
    if (offset + nalLengthSize > data.length) return null
    let nalSize = 0
    for (let index = 0; index < nalLengthSize; index += 1) {
      nalSize = nalSize * 256 + data[offset + index]
    }
    offset += nalLengthSize
    if (nalSize === 0) continue
    if (offset + nalSize > data.length) return null
    parts.push(startCode, data.subarray(offset, offset + nalSize))
    offset += nalSize
  }
  return Buffer.concat(parts)
}

/**
 * 增量视频流解析器：喂 socket 数据块，吐出「设备名/编解码器」「session（换分辨率）」
 * 和「媒体包」。不完整的数据留在内部缓冲，不吐半包；超过 maxPacketSize 的 size
 * 直接拒绝并标记需要 reset（流已失步，调用方应重连）。
 *
 * 开销说明：每次 push 会 `Buffer.concat` 一次。对 60fps / 几百 KB 的包量级没问题；
 * 真要榨带宽可以换成环形缓冲，接口不变。
 */
export class VideoStreamParser {
  constructor(options = {}) {
    const protocol = options.protocol ?? SCRCPY_PROTOCOL.V5
    if (protocol !== SCRCPY_PROTOCOL.V3 && protocol !== SCRCPY_PROTOCOL.V5) {
      throw new RangeError(`未知协议形态: ${protocol}`)
    }
    const maxPacketSize = options.maxPacketSize ?? MAX_PACKET_SIZE
    if (!Number.isFinite(maxPacketSize) || maxPacketSize <= 0) {
      throw new RangeError(`maxPacketSize 必须是正数，实际 ${maxPacketSize}`)
    }

    this.protocol = protocol
    this.maxPacketSize = Math.floor(maxPacketSize)
    this._buffer = Buffer.alloc(0)
    this._state = 'dummyByte'
    this._pending = null
    this._resetRequired = false
    this._headerEmitted = false
    this.info = {
      protocol,
      deviceName: null,
      codecId: null,
      codec: null,
      width: null,
      height: null,
      disabled: null,
    }
    this.stats = { bytes: 0, packets: 0, configPackets: 0, keyFrames: 0, sessions: 0, dropped: 0, width: null, height: null }
  }

  /** 'deviceName' | 'codecMeta' | 'header' | 'payload' */
  get state() {
    return this._state
  }

  /** 还压在内层缓冲里、等后续数据补齐的字节数。 */
  get buffered() {
    return this._buffer.length
  }

  /** 流已失步，必须 reset() 或重建实例后重新连接。 */
  get resetRequired() {
    return this._resetRequired
  }

  /** 清空缓冲和状态（不动 info/stats，方便复用对象）。 */
  reset() {
    this._buffer = Buffer.alloc(0)
    this._state = 'dummyByte'
    this._pending = null
    this._resetRequired = false
    this._headerEmitted = false
    return true
  }

  /**
   * @param {Buffer|Uint8Array} chunk
   * @returns {{ header: object|null, sessions: object[], packets: object[], errors: object[] }}
   */
  push(chunk) {
    const out = { header: null, sessions: [], packets: [], errors: [] }
    if (!Buffer.isBuffer(chunk)) {
      if (chunk instanceof Uint8Array) chunk = Buffer.from(chunk)
      else throw new TypeError('push 需要 Buffer 或 Uint8Array')
    }
    if (chunk.length === 0) return out
    if (this._resetRequired) {
      out.errors.push({ code: 'reset-required' })
      return out
    }

    this.stats.bytes += chunk.length
    this._buffer = this._buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this._buffer, chunk])

    for (;;) {
      if (this._resetRequired) break

      if (this._state === 'dummyByte') {
        if (this._buffer.length < 1) break
        // scrcpy server 连上视频 socket 先发 1 字节哑数据（0x00）探活；设备名是 ASCII，不会撞。
        if (this._buffer[0] === 0) this._buffer = this._buffer.subarray(1)
        this._state = 'deviceName'
        continue
      }

      if (this._state === 'deviceName') {
        if (this._buffer.length < DEVICE_NAME_FIELD_LENGTH) break
        const raw = this._buffer.subarray(0, DEVICE_NAME_FIELD_LENGTH)
        const nul = raw.indexOf(0)
        this.info.deviceName = raw.toString('utf8', 0, nul === -1 ? raw.length : nul)
        this._buffer = this._buffer.subarray(DEVICE_NAME_FIELD_LENGTH)
        this._state = 'codecMeta'
        continue
      }

      if (this._state === 'codecMeta') {
        const need = this.protocol === SCRCPY_PROTOCOL.V3 ? 12 : 4
        if (this._buffer.length < need) break
        this._readCodecMeta(out)
        this._state = 'header'
        continue
      }

      if (this._state === 'header') {
        if (this._buffer.length < PACKET_HEADER_SIZE) break
        const header = this._buffer.subarray(0, PACKET_HEADER_SIZE)
        this._buffer = this._buffer.subarray(PACKET_HEADER_SIZE)
        let parsed
        try {
          parsed = parseFrameHeader(header, { protocol: this.protocol })
        } catch (error) {
          this.stats.dropped += 1
          out.errors.push({ code: 'bad-header', message: String(error?.message ?? error) })
          this._resetRequired = true
          break
        }
        if (parsed.kind === 'session') {
          this.info.width = parsed.width
          this.info.height = parsed.height
          this.stats.sessions += 1
          out.sessions.push(parsed)
          continue
        }
        if (!Number.isInteger(parsed.size) || parsed.size > this.maxPacketSize) {
          this.stats.dropped += 1
          out.errors.push({ code: 'oversize', size: parsed.size, limit: this.maxPacketSize })
          this._resetRequired = true
          break
        }
        this._pending = parsed
        this._state = 'payload'
        continue
      }

      if (this._state === 'payload') {
        const size = this._pending.size
        if (this._buffer.length < size) break
        const data = this._buffer.subarray(0, size)
        this._buffer = this._buffer.subarray(size)
        const packet = {
          data,
          size,
          pts: this._pending.pts,
          keyFrame: this._pending.keyFrame,
          config: this._pending.config,
        }
        this._pending = null
        this._state = 'header'
        this.stats.packets += 1
        if (packet.config) this.stats.configPackets += 1
        if (packet.keyFrame) this.stats.keyFrames += 1
        out.packets.push(packet)
        continue
      }

      break
    }

    if (!this._headerEmitted && this._state !== 'deviceName' && this._state !== 'codecMeta') {
      this._headerEmitted = true
      out.header = { ...this.info }
    }
    return out
  }

  _readCodecMeta(out) {
    const need = this.protocol === SCRCPY_PROTOCOL.V3 ? 12 : 4
    const codecId = this._buffer.readUInt32BE(0)
    this.info.codecId = codecId
    this.info.codec = codecName(codecId)
    if (this.protocol === SCRCPY_PROTOCOL.V3) {
      this.info.width = this._buffer.readUInt32BE(4)
      this.info.height = this._buffer.readUInt32BE(8)
    }
    this._buffer = this._buffer.subarray(need)

    if (codecId === 0) {
      this.info.disabled = 'explicit'
      out.errors.push({ code: 'stream-disabled', codecId })
    } else if (codecId === 1) {
      this.info.disabled = 'error'
      out.errors.push({ code: 'stream-disabled-error', codecId })
    } else if (this.info.codec === null) {
      out.errors.push({ code: 'unknown-codec', codecId })
    }
  }
}

/* ============================================================
 * 控制消息编码（纯函数，全部返回 Buffer）
 * ==========================================================*/

/**
 * 设备像素 → 视频像素（触控消息的坐标空间）。
 *
 * server 侧的 PositionMapper 是按**编码尺寸**建的：`PositionMapper.create(videoSize, transform, deviceSize)`，
 * 客户端消息里的 `screenWidth/screenHeight` 必须等于 videoSize，点位也必须是 videoSize 空间里的坐标；
 * 尺寸对不上 server 直接丢弃事件（"Ignore positional event generated for size …"），对得上就按 video→device
 * 矩阵再放大。所以设备尺寸 ≠ 视频尺寸时（`--max-size` 压缩）必须先缩一次，不能直接发设备坐标——
 * 否则每个点都被再放大 deviceW/videoW 倍，越高越偏右、越往下越偏下。
 * @param {number} x - 设备像素 x。
 * @param {number} y - 设备像素 y。
 * @param {{ width?: number, height?: number }} device - 设备屏幕尺寸。
 * @param {{ width?: number, height?: number }} video - 编码尺寸。
 * @returns {{ x: number, y: number }} 视频像素坐标（已夹到画面内）。
 */
export function deviceToVideoPoint(x, y, device, video) {
  const dw = Number(device?.width) || 0
  const dh = Number(device?.height) || 0
  const vw = Number(video?.width) || 0
  const vh = Number(video?.height) || 0
  const rawX = Math.round(Number(x) || 0)
  const rawY = Math.round(Number(y) || 0)
  if (!(dw > 0) || !(dh > 0) || !(vw > 0) || !(vh > 0)) return { x: rawX, y: rawY }
  const clamp = (value, max) => Math.max(0, Math.min(max, value))
  return {
    x: clamp(Math.round((rawX * vw) / dw), vw - 1),
    y: clamp(Math.round((rawY * vh) / dh), vh - 1),
  }
}

function writeUInt64(value, buffer, offset) {
  const bigint = typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value) || 0))
  buffer.writeBigUInt64BE(BigInt.asUintN(64, bigint), offset)
}

/**
 * 触控事件（32 字节）。
 * @param {{
 *   action?: number, pointerId?: number|bigint, x?: number, y?: number,
 *   screenWidth?: number, screenHeight?: number, pressure?: number,
 *   actionButton?: number, buttons?: number,
 * }} [input]
 */
export function encodeTouch(input = {}) {
  const action = input.action ?? TOUCH_ACTION.DOWN
  const buffer = Buffer.alloc(TOUCH_MSG_SIZE)
  buffer.writeUInt8(CONTROL_MSG_TYPE.INJECT_TOUCH_EVENT, 0)
  buffer.writeUInt8((Number(action) || 0) & 0xff, 1)
  writeUInt64(input.pointerId ?? 0, buffer, 2)
  buffer.writeInt32BE(Math.trunc(Number(input.x) || 0), 10)
  buffer.writeInt32BE(Math.trunc(Number(input.y) || 0), 14)
  buffer.writeUInt16BE(clampU16(input.screenWidth ?? input.width ?? 0), 18)
  buffer.writeUInt16BE(clampU16(input.screenHeight ?? input.height ?? 0), 20)
  buffer.writeUInt16BE(floatToU16Fp(input.pressure ?? 0), 22)
  buffer.writeUInt32BE((Number(input.actionButton) || 0) >>> 0, 24)
  buffer.writeUInt32BE((Number(input.buttons) || 0) >>> 0, 28)
  return buffer
}

/**
 * 按键事件（14 字节）。
 * @param {{ action?: number, keycode?: number, repeat?: number, metastate?: number }} [input]
 */
export function encodeKeycode(input = {}) {
  const buffer = Buffer.alloc(KEYCODE_MSG_SIZE)
  buffer.writeUInt8(CONTROL_MSG_TYPE.INJECT_KEYCODE, 0)
  buffer.writeUInt8((Number(input.action ?? KEY_ACTION.DOWN) || 0) & 0xff, 1)
  buffer.writeUInt32BE((Number(input.keycode) || 0) >>> 0, 2)
  buffer.writeUInt32BE((Number(input.repeat) || 0) >>> 0, 6)
  buffer.writeUInt32BE((Number(input.metastate) || 0) >>> 0, 10)
  return buffer
}

/**
 * 文本注入：type(1) + 长度(4, BE) + UTF-8 正文（超过上限按字符边界截断）。
 * @param {string} text
 * @param {{ maxLength?: number }} [options]
 */
export function encodeText(text, options = {}) {
  const maxLength = options.maxLength ?? INJECT_TEXT_MAX_LENGTH
  const payload = Buffer.from(truncateUtf8(text, maxLength), 'utf8')
  const buffer = Buffer.alloc(5 + payload.length)
  buffer.writeUInt8(CONTROL_MSG_TYPE.INJECT_TEXT, 0)
  buffer.writeUInt32BE(payload.length, 1)
  payload.copy(buffer, 5)
  return buffer
}

/** BACK 键 / 点亮屏幕（2 字节）。 */
export function encodeBackOrScreenOn(action = KEY_ACTION.DOWN) {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt8(CONTROL_MSG_TYPE.BACK_OR_SCREEN_ON, 0)
  buffer.writeUInt8((Number(action) || 0) & 0xff, 1)
  return buffer
}

/**
 * 名字 / 单字符 → Android keycode。接受 ANDROID_KEYCODE 里的键名、单个
 * ASCII 字母数字，或直接给数字（原样返回）。
 * @returns {number|null}
 */
export function keycodeFor(key) {
  if (typeof key === 'number') return Number.isInteger(key) ? key : null
  if (typeof key === 'bigint') return Number(key)
  const name = String(key ?? '').toUpperCase()
  if (Object.prototype.hasOwnProperty.call(ANDROID_KEYCODE, name)) return ANDROID_KEYCODE[name]
  if (name.length === 1) {
    const code = name.charCodeAt(0)
    if (code >= 48 && code <= 57) return 7 + (code - 48) // KEYCODE_0 = 7
    if (code >= 65 && code <= 90) return 29 + (code - 65) // KEYCODE_A = 29
    if (name === ' ') return ANDROID_KEYCODE.SPACE
  }
  return null
}

/* ============================================================
 * scrcpy-server 启动命令（纯函数，便于文档/测试核对）
 * ==========================================================*/

/* 用插件自己的文件名，别和别的 scrcpy 工具抢 /data/local/tmp/scrcpy-server.jar：
   同机共存时互相覆盖会让「跳过推送」的尺寸判断失真。 */
const DEFAULT_DEVICE_SERVER_PATH = '/data/local/tmp/dsh-mobile-use-scrcpy-server.jar'

function shellQuote(value) {
  const text = String(value)
  return /^[\w./:=@%+-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`
}

/**
 * scrcpy-server 的启动参数（`com.genymobile.scrcpy.Server` 之后的那串）。
 * @param {{ version?: string, scid?: number, logLevel?: string, tunnelForward?: boolean,
 *           video?: boolean, audio?: boolean, control?: boolean, maxSize?: number,
 *           maxFps?: number, videoBitRate?: number }} [options]
 * @returns {string[]}
 */
export function buildServerArgs(options = {}) {
  const {
    version = SCRCPY_SERVER_VERSION,
    scid = 0,
    logLevel = 'info',
    tunnelForward = false,
    video = true,
    audio = false,
    control = true,
    maxSize = 0,
    maxFps = 0,
    videoBitRate = 0,
  } = options

  const args = [
    String(version),
    `scid=${(Number(scid) >>> 0).toString(16).padStart(8, '0')}`,
    `log_level=${logLevel}`,
    `tunnel_forward=${tunnelForward}`,
    `video=${Boolean(video)}`,
    `audio=${Boolean(audio)}`,
    `control=${Boolean(control)}`,
  ]
  if (maxSize > 0) args.push(`max_size=${Math.floor(maxSize)}`)
  if (maxFps > 0) args.push(`max_fps=${maxFps}`)
  if (videoBitRate > 0) args.push(`video_bit_rate=${Math.floor(videoBitRate)}`)
  return args
}

/**
 * 完整的 device 端 shell 命令（不包含 `adb -s xxx shell` 前缀）。
 * @param {{ deviceServerPath?: string } & Parameters<typeof buildServerArgs>[0]} [options]
 * @returns {string}
 */
export function buildServerShellCommand(options = {}) {
  const deviceServerPath = options.deviceServerPath ?? DEFAULT_DEVICE_SERVER_PATH
  const args = buildServerArgs(options).map(shellQuote).join(' ')
  return `CLASSPATH=${shellQuote(deviceServerPath)} app_process / com.genymobile.scrcpy.Server ${args}`
}

/* ============================================================
 * ScrcpyChannel：生命周期壳
 * ==========================================================*/

const DEFAULT_SERVER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'scrcpy-server')

const DEFAULT_OPTIONS = {
  serial: '',
  adbPath: 'adb',
  serverPath: DEFAULT_SERVER_PATH,
  deviceServerPath: DEFAULT_DEVICE_SERVER_PATH,
  serverVersion: SCRCPY_SERVER_VERSION,
  protocol: SCRCPY_PROTOCOL.V5,
  host: '127.0.0.1',
  port: 27183,
  pushServer: true,
  video: true,
  control: true,
  /* 编码分辨率与帧率：不改时按设备原生分辨率 + 不限帧，3200x2136 一帧 6.8 MP，
     设备编码器忙不过来就直接变成操作延迟。侧栏画布只有几百像素宽，压到长边 1600 足够清晰。 */
  maxSize: 1600,
  maxFps: 0,
  videoBitRate: 8_000_000,
  logLevel: 'info',
  readyTimeoutMs: 15000,
  commandTimeoutMs: 20000,
  scid: 0,
}

/**
 * 一条 scrcpy 通道：push server → adb forward 端口 → 起 app_process →
 * 收视频 socket（解析）/ 控制 socket（注入）。
 *
 * 生命周期约定：
 *  - 构造函数零副作用，new 完什么都不发生；
 *  - `start()` 永远 resolve（失败返回 false，不 reject，内部已兜底）；
 *  - `stop()` 幂等，重复调用、清理对象缺方法、监听器已销毁都不抛；
 *  - 所有定时器 / socket / 子进程回调都过 `guardCall`，异常不会冒到 host 顶层。
 *
 * 事件（监听器里抛异常不会传播出来）：
 *  'video-header'  { deviceName, codec, codecId, width, height, protocol }
 *    注意：协议 v5 的宽高在第一个 session 包里才确定，这个事件可能是 null；要尺寸读
 *    `channel.info`（活对象）或等 'video-session'。
 *  'video-session' { width, height, clientResized }
 *  'video-packet'  { data, size, pts, keyFrame, config }
 *  'ready' | 'closed'
 */
export class ScrcpyChannel extends EventEmitter {
  constructor(options = {}) {
    super()
    this._options = { ...DEFAULT_OPTIONS, ...options }
    this._logFn = typeof options.log === 'function' ? options.log : null
    this._logSafe = (note) => {
      try {
        this._logFn?.(note)
      } catch {
        /* 日志失败不能变成新异常 */
      }
    }

    this._state = 'idle'
    this._stopped = false
    this._disposed = false
    this._scid = 0
    this._netServer = null
    this._sockets = []
    this._video = null
    this._control = null
    this._child = null
    this._timers = new Set()
    this._parser = null
    this._readyFinish = null
    this._headerEmitted = false

    this.stats = {
      videoBytes: 0,
      packets: 0,
      configPackets: 0,
      sessions: 0,
      controlSent: 0,
      dropped: 0,
    }
    /* 最近的 SPS/PPS：后来才接上的消费者（ffmpeg/新客户端）要靠它解出画面。 */
    this.configChunks = []
    /* 最近一个 IDR 起的 GOP：静态画面时编码器不出新帧，后来接上的人靠它立刻有画面。 */
    this.gopChunks = []
    this.gopBytes = 0
  }

  get state() {
    return this._state
  }

  get videoConnected() {
    return Boolean(this._video)
  }

  /** 视频头信息（设备名/编码/尺寸）；还没收到是 null。 @returns {any} 信息。 */
  get info() {
    return this._parser === null ? null : this._parser.info
  }

  get controlConnected() {
    return Boolean(this._control)
  }

  isRunning() {
    return this._state === 'running'
  }

  /** 写一行诊断日志（日志回调本身失败也不抛）。 */
  _log(note) {
    this._logSafe(String(note))
  }

  _guard(where, run) {
    return guardCall(this._logSafe, where, run)
  }

  /** emit 的兜底：监听器抛异常不许冒到调用方（host 会因为未捕获异常退出 1）。 */
  emitSafe(event, payload) {
    return this._guard(`emit ${event}`, () => {
      this.emit(event, payload)
    })
  }

  _adbBaseArgs() {
    const serial = this._options.serial
    return serial ? ['-s', String(serial)] : []
  }

  /**
   * 启动通道。
   * @returns {Promise<boolean>} 失败返回 false（不 reject）
   */
  async start() {
    if (this._state !== 'idle') {
      this._log(`start 跳过：当前状态 ${this._state}`)
      return false
    }
    this._state = 'starting'
    this._stopped = false
    this._disposed = false
    this._scid = (Number(this._options.scid) || randomInt(1, 0x7fffffff)) >>> 0
    this._parser = new VideoStreamParser({
      protocol: this._options.protocol,
      maxPacketSize: this._options.maxPacketSize ?? MAX_PACKET_SIZE,
    })
    this._log(`scrcpy 通道启动: scid=${this._scid.toString(16)} port=${this._options.port}`)

    try {
      /* 上一轮被丢弃的通道可能把设备端 server 留在那儿占着编码器（新 server 拿到
         header 后立刻断，表现为「连上就掉」的抖动）。本站的 jar 路径是插件独占的，
         起新进程前先清干净，绝不误伤别的 scrcpy 会话。 */
      await this._reapOwnServers()
      if (!(await this._pushServer())) return this._fail('推送 scrcpy-server 失败')
      if (this._stopped) return false
      if (!this._spawnServer()) return this._fail('启动 scrcpy-server 失败')
      if (this._stopped) return false
      if (!(await this._forward())) return this._fail('adb forward 建立失败')
      if (this._stopped) return false
      if (!(await this._connectBoth())) return this._fail('连接 scrcpy 视频 / 控制 socket 失败')
      if (this._stopped) return false
      const ready = this._isReady()
      if (this._stopped) return false
      if (!ready) return this._fail('等待 scrcpy socket 超时')
      this._state = 'running'
      this._videoRedials = 0
      this._log('scrcpy 通道已就绪')
      this.emitSafe('ready')
      return true
    } catch (error) {
      this._log(`start 异常: ${String(error?.stack ?? error).slice(0, 400)}`)
      this.stop()
      return false
    }
  }

  /** 失败统一收口：日志 + 清理，返回 false。 */
  _fail(message) {
    this._log(message)
    this.stop()
    return false
  }

  async _pushServer() {
    if (!this._options.pushServer) return true
    /* 设备上已经有同尺寸的 server 就直接用：每次冷启动都 push 一遍要多花 300~600ms，
       而这段时间里用户看到的就是「点了没反应」。尺寸不同才重推（版本变了 jar 大小必变）。 */
    if (process.env.ADBM_FORCE_PUSH !== '1') {
      try {
        const local = await stat(this._options.serverPath)
        const remote = await this._runCommand([
          ...this._adbBaseArgs(), 'shell', `stat -c %s ${String(this._options.deviceServerPath)} 2>/dev/null`,
        ])
        const size = Number(String(remote.stdout ?? '').trim())
        if (remote.ok && Number.isFinite(size) && size === local.size) {
          this._log('设备端已有同版本 scrcpy-server，跳过推送')
          return true
        }
      } catch {
        /* 查不到就照旧推，别为了省时间把启动搞坏 */
      }
    }
    const result = await this._runCommand([
      ...this._adbBaseArgs(),
      'push',
      String(this._options.serverPath),
      String(this._options.deviceServerPath),
    ])
    if (!result.ok) {
      const detail = result.error?.message ?? result.stderr ?? `exit=${result.code}`
      this._log(`adb push 失败: ${String(detail).trim().slice(0, 200)}`)
      return false
    }
    this._log(`已推送 scrcpy-server → ${this._options.deviceServerPath}`)
    return true
  }

  /**
   * 建 forward 隧道。tunnel_forward=true 时是**设备端监听**：server 在
   * `localabstract:scrcpy_<scid hex>` 上 accept，本机用 adb forward 把本地端口转过去再连。
   */
  async _forward() {
    const port = String(this._options.port)
    /* 上一轮可能留下同端口的 forward，旧隧道会先 accept 再断，先摘掉再加。 */
    await this._runCommand([...this._adbBaseArgs(), 'forward', '--remove', `tcp:${port}`]).catch(() => null)
    const name = `localabstract:scrcpy_${this._scid.toString(16).padStart(8, '0')}`
    const result = await this._runCommand([...this._adbBaseArgs(), 'forward', `tcp:${port}`, name])
    if (!result.ok) {
      const detail = result.error?.message ?? result.stderr ?? `exit=${result.code}`
      this._log(`adb forward 失败: ${String(detail).trim().slice(0, 200)}`)
      return false
    }
    this._log(`adb forward tcp:${port} → ${name}`)
    return true
  }

  /** 连两次：先视频后控制（scrcpy 的 socket 顺序就是这样），失败重试到 ready 超时。 */
  async _connectBoth() {
    const timeoutMs = Number(this._options.readyTimeoutMs) > 0 ? Number(this._options.readyTimeoutMs) : 10000
    const deadline = Date.now() + timeoutMs
    const wanted = this._options.control ? 2 : 1
    for (let index = 0; index < wanted; index += 1) {
      let socket = null
      let lastError = ''
      while (!socket && !this._stopped && Date.now() < deadline) {
        socket = await this._dial()
        if (!socket) {
          lastError = 'connect 失败'
          await new Promise((resolveWait) => setTimeout(resolveWait, 120))
        }
      }
      if (!socket) {
        this._log(`第 ${index + 1} 个 socket 连接失败（${lastError}）`)
        return false
      }
      this._attachSocket(socket)
    }
    return this._isReady()
  }

  _dial() {
    return new Promise((resolveDial) => {
      let settled = false
      let probeTimer = null
      const finish = (value) => {
        if (settled) return
        settled = true
        if (probeTimer) clearTimeout(probeTimer)
        resolveDial(value)
      }
      try {
        const socket = connect({ host: this._options.host, port: this._options.port })
        socket.setNoDelay?.(true)
        const bail = (why) => {
          this._guard('dial bail', () => {
            if (why) this._log(`socket 未就绪: ${why}`)
            socket.destroy?.()
            finish(null)
          })
        }
        socket.on('error', (error) => {
          this._guard('dial error', () => bail(error?.message ?? String(error)))
        })
        socket.once('close', () => {
          this._guard('dial close', () => bail(''))
        })
        socket.once('connect', () => {
          this._guard('dial ok', () => {
            /* adb forward 的 tcp 可能先 accept 再断（设备端 abstract socket 还没建好），
               所以先观察一小段，活着才算真连上。 */
            probeTimer = setTimeout(() => {
              this._guard('dial probe', () => {
                if (socket.destroyed) finish(null)
                else finish(socket)
              })
            }, 90)
            probeTimer.unref?.()
            this._timers.add(probeTimer)
          })
        })
      } catch (error) {
        this._log(`socket 连接异常: ${error?.message ?? error}`)
        finish(null)
      }
    })
  }

  /** 把一个已连上的 socket 记账并接到视频 / 控制通道上。 */
  _attachSocket(socket) {
    this._sockets.push(socket)
    socket.on('error', (error) => {
      this._guard('socket error', () => this._log(`socket 错误: ${error?.message ?? error}`))
    })
    socket.setNoDelay?.(true)
    if (!this._video) {
      this._attachVideo(socket)
    } else if (this._options.control && !this._control) {
      this._attachControl(socket)
    } else {
      this._guard('多余 socket', () => {
        this._log('收到多余的 socket，已关闭')
        socket.destroy?.()
      })
    }
  }

  _spawnServer() {
    let ok = false
    this._guard('spawn server', () => {
      const command = buildServerShellCommand({
        deviceServerPath: this._options.deviceServerPath,
        version: this._options.serverVersion,
        scid: this._scid,
        logLevel: this._options.logLevel,
        tunnelForward: true, // forward 拓扑：本机 adb forward 监听，设备连回本机
        video: this._options.video,
        audio: false,
        control: this._options.control,
        /* 这三项必须显式传：漏传时 buildServerArgs 用默认 0，等于按原生分辨率不限帧编码，
           3200x2136 每帧 6.8 MP 把设备编码器压满，操作延迟直接翻倍。 */
        maxSize: this._options.maxSize,
        maxFps: this._options.maxFps,
        videoBitRate: this._options.videoBitRate,
      })
      const args = [...this._adbBaseArgs(), 'shell', command]
      const child = spawn(this._options.adbPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      this._child = child

      child.on('error', (error) => {
        this._guard('server error', () => this._onChildGone(`error: ${error?.message ?? error}`))
      })
      child.on('exit', (code, signal) => {
        this._guard('server exit', () => this._onChildGone(`exit code=${code} signal=${signal}`))
      })
      if (child.stdout) {
        child.stdout.on('data', (chunk) => {
          this._guard('server stdout', () => this._log(`server: ${chunk.toString().trim().slice(0, 200)}`))
        })
        child.stdout.on('error', (error) => {
          this._guard('server stdout error', () => this._log(`server stdout 错误: ${error?.message ?? error}`))
        })
      }
      if (child.stderr) {
        child.stderr.on('data', (chunk) => {
          this._guard('server stderr', () => this._log(`server: ${chunk.toString().trim().slice(0, 200)}`))
        })
        child.stderr.on('error', (error) => {
          this._guard('server stderr error', () => this._log(`server stderr 错误: ${error?.message ?? error}`))
        })
      }
      ok = true
    })
    return ok
  }

  _onChildGone(reason) {
    if (this._stopped) {
      this._log(`scrcpy-server 已退出（${reason}）`)
      return
    }
    this._log(`scrcpy-server 意外退出: ${reason}`)
    this._fail('scrcpy-server 意外退出')
  }

  _isReady() {
    if (!this._video) return false
    if (this._options.control && !this._control) return false
    return true
  }

  _waitReady() {
    return new Promise((resolveReady) => {
      let settled = false
      let timer = null
      const finish = (value) => {
        if (settled) return
        settled = true
        if (timer) {
          clearTimeout(timer)
          this._timers.delete(timer)
        }
        this._readyFinish = null
        resolveReady(value)
      }
      this._readyFinish = finish

      if (this._isReady()) {
        finish(true)
        return
      }

      const timeoutMs = Number(this._options.readyTimeoutMs)
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          this._timers.delete(timer)
          this._guard('ready timeout', () => {
            this._log('等待视频 / 控制 socket 超时')
            finish(false)
          })
        }, timeoutMs)
        timer.unref?.()
        this._timers.add(timer)
      }
    })
  }

  _onConnection(socket) {
    this._attachSocket(socket)
    if (this._isReady() && typeof this._readyFinish === 'function') {
      this._guard('ready', () => this._readyFinish(true))
    }
  }

  _attachVideo(socket) {
    this._video = socket
    this._videoBytes = 0
    this._videoAttachAt = Date.now()
    this._log('视频 socket 已连接')
    socket.on('data', (chunk) => {
      this._videoBytes += chunk.length
      this._guard('video data', () => this._onVideoData(chunk))
    })
    socket.on('close', () => {
      this._guard('video close', () => {
        this._video = null
        if (this._state !== 'running') return
        /* adb forward 的旧隧道会先 accept 再断：这种 socket 连上时 0 字节、几十毫秒就没。
           它不是「server 死了」，重建整条链路要多花 1~3 秒，重拨一次更便宜。 */
        const transient = this._videoBytes === 0
          && Date.now() - this._videoAttachAt < 2000
          && this._videoRedials < 3
          && this._stopped !== true
        if (transient) {
          this._videoRedials += 1
          this._log(`视频 socket 刚连上就断（0 字节），重拨第 ${this._videoRedials} 次`)
          const timer = setTimeout(() => {
            this._guard('video redial', () => this._redialVideo())
          }, 120)
          timer.unref?.()
          return
        }
        this._log('视频 socket 已关闭')
        this.emitSafe('closed')
      })
    })
  }

  /** 重拨视频 socket：失败累计到 3 次才判定整条通道失效。 */
  _redialVideo() {
    if (this._stopped === true || this._state !== 'running') return
    Promise.resolve()
      .then(() => this._dial())
      .then((socket) => {
        this._guard('video redial done', () => {
          if (this._stopped === true || this._state !== 'running') {
            socket?.destroy?.()
            return
          }
          if (socket !== null && socket !== undefined) {
            this._attachSocket(socket)
            return
          }
          if (this._videoRedials < 3) {
            this._videoRedials += 1
            const timer = setTimeout(() => {
              this._guard('video redial again', () => this._redialVideo())
            }, 200)
            timer.unref?.()
            return
          }
          this._fail('视频 socket 重拨 3 次都失败')
        })
      })
      .catch((error) => {
        this._guard('video redial catch', () => {
          this._fail(`视频 socket 重拨异常: ${error?.message ?? error}`)
        })
      })
  }

  _attachControl(socket) {
    this._control = socket
    this._log('控制 socket 已连接')
    socket.on('close', () => {
      this._guard('control close', () => {
        this._control = null
        this._log('控制 socket 已关闭')
      })
    })
  }

  _onVideoData(chunk) {
    if (!this._parser) return
    this.stats.videoBytes += chunk.length
    const events = this._parser.push(chunk)
    if (events.header) {
      this.stats.width = events.header.width
      this.stats.height = events.header.height
      this._log(
        `视频流: device=${events.header.deviceName || '?'} codec=${events.header.codec || '?'} ` +
          `${events.header.width ?? '?'}x${events.header.height ?? '?'}`,
      )
      this.emitSafe('video-header', events.header)
    }
    for (const session of events.sessions) {
      this.stats.sessions += 1
      this.stats.width = session.width
      this.stats.height = session.height
      this.emitSafe('video-session', session)
    }
    for (const packet of events.packets) {
      this.stats.packets += 1
      if (Buffer.isBuffer(packet.data) && packet.data.length > 0) {
        if (packet.keyFrame) {
          this.gopChunks = [Buffer.from(packet.data)]
          this.gopBytes = packet.data.length
        } else if (this.gopChunks.length > 0) {
          if (this.gopBytes + packet.data.length <= 4 * 1024 * 1024) {
            this.gopChunks.push(Buffer.from(packet.data))
            this.gopBytes += packet.data.length
          } else {
            /* 超过上限就整段丢掉，等下一张 IDR，绝不从 GOP 中间续。 */
            this.gopChunks = []
            this.gopBytes = 0
          }
        }
      }
      if (packet.config) {
        this.stats.configPackets += 1
        if (Buffer.isBuffer(packet.data) && packet.data.length > 0) {
          this.configChunks.push(Buffer.from(packet.data))
          let total = 0
          for (const chunk of this.configChunks) total += chunk.length
          while (this.configChunks.length > 1 && total > 65536) total -= this.configChunks.shift().length
        }
      }
      this.emitSafe('video-packet', packet)
    }
    for (const error of events.errors) {
      this._log(`视频流异常: ${JSON.stringify(error)}`)
    }
  }

  /** 参数集 + 最近一个 GOP 的原始流；后来接上的消费者喂这一份就能立刻解码。 @returns {Buffer | null} */
  get replay() {
    const parts = []
    if (Array.isArray(this.configChunks)) parts.push(...this.configChunks)
    if (Array.isArray(this.gopChunks)) parts.push(...this.gopChunks)
    if (parts.length === 0) return null
    let total = 0
    for (const part of parts) total += part.length
    if (total === 0) return null
    return Buffer.concat(parts)
  }

  /** 最近一次 SPS/PPS（含 Annex-B 起始码）；还没有就是 null。 @returns {Buffer | null} */
  get prelude() {
    if (!Array.isArray(this.configChunks) || this.configChunks.length === 0) return null
    return Buffer.concat(this.configChunks)
  }

  /**
   * 发一条控制消息（编码也一起兜底）。
   * @returns {boolean} 是否真的写进了 socket
   */
  _send(build, where) {
    let sent = false
    this._guard(where, () => {
      const socket = this._control
      if (!socket || socket.destroyed || socket.writable === false) {
        this.stats.dropped += 1
        return
      }
      const buffer = build()
      socket.write(buffer, (error) => {
        if (error) {
          this._guard(`${where}:write`, () => this._log(`控制消息写入失败: ${error?.message ?? error}`))
        }
      })
      this.stats.controlSent += 1
      sent = true
    })
    return sent
  }

  /**
   * 注入触控（DOWN/UP/MOVE 都走这里，一个 socket 写包，不经过 `adb shell input`）。
   * @param {Parameters<typeof encodeTouch>[0]} input
   * @returns {boolean}
   */
  pushTouch(input = {}) {
    return this._send(() => encodeTouch(input), 'pushTouch')
  }

  /**
   * 要设备端立刻重发一帧关键帧（`RESET_VIDEO`，scrcpy 3.x 控制消息 17）。
   * 静止画面下编码器不产帧：面板刚打开时只能干等下一次界面变化，看起来就是黑屏；
   * 这条消息让 server 重置视频编码，立刻给一张新的 IDR。
   * @returns {boolean} 控制通道是否真的可写
   */
  requestKeyFrame() {
    return this._send(() => Buffer.from([CONTROL_MSG_TYPE.RESET_VIDEO]), 'requestKeyFrame')
  }

  /**
   * 注入按键。
   * @param {Parameters<typeof encodeKeycode>[0]} input
   * @returns {boolean}
   */
  pushKeycode(input = {}) {
    return this._send(() => encodeKeycode(input), 'pushKeycode')
  }

  /**
   * 注入文本（UTF-8，长度前缀）。
   * @param {string} text
   * @param {{ maxLength?: number }} [options]
   * @returns {boolean}
   */
  pushText(text, options = {}) {
    return this._send(() => encodeText(text, options), 'pushText')
  }

  /**
   * 返回键 / 点亮屏幕。
   * @param {number} [action]
   * @returns {boolean}
   */
  pushBackOrScreenOn(action = KEY_ACTION.DOWN) {
    return this._send(() => encodeBackOrScreenOn(action), 'pushBackOrScreenOn')
  }

  /**
   * 跑一条 adb 命令（带超时）。永远 resolve：失败给 `ok: false`，不 reject。
   * @param {string[]} args
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<{ ok: boolean, code: number, stdout: string, stderr: string, error?: Error }>}
   */
  _runCommand(args, options = {}) {
    const timeoutMs = options.timeoutMs ?? this._options.commandTimeoutMs
    return new Promise((resolveCommand) => {
      let settled = false
      let timer = null
      const finish = (result) => {
        if (settled) return
        settled = true
        if (timer) {
          clearTimeout(timer)
          this._timers.delete(timer)
        }
        resolveCommand(result)
      }

      let child = null
      try {
        child = spawn(this._options.adbPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        finish({ ok: false, code: -1, stdout: '', stderr: '', error })
        return
      }

      const stdout = []
      const stderr = []
      child.stdout?.on('data', (chunk) => {
        this._guard('adb stdout', () => stdout.push(chunk))
      })
      child.stderr?.on('data', (chunk) => {
        this._guard('adb stderr', () => stderr.push(chunk))
      })
      child.on('error', (error) => {
        this._guard('adb error', () => finish({ ok: false, code: -1, stdout: '', stderr: '', error }))
      })
      child.on('exit', (code) => {
        this._guard('adb exit', () => {
          finish({
            ok: code === 0,
            code: typeof code === 'number' ? code : -1,
            stdout: Buffer.concat(stdout).toString(),
            stderr: Buffer.concat(stderr).toString(),
          })
        })
      })

      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          this._timers.delete(timer)
          this._guard('adb timeout', () => {
            try {
              child.kill('SIGKILL')
            } catch {
              /* 进程可能已经没了 */
            }
            finish({
              ok: false,
              code: -1,
              stdout: Buffer.concat(stdout).toString(),
              stderr: Buffer.concat(stderr).toString(),
              error: new Error(`adb 命令超时（${timeoutMs}ms）`),
            })
          })
        }, timeoutMs)
        timer.unref?.()
        this._timers.add(timer)
      }
    })
  }

  /**
   * 关通道。幂等：重复调用、内部对象已被销毁、清理方法缺失都返回 true 不抛。
   * @returns {boolean}
   */
  stop() {
    const wasActive = this._state !== 'idle' && this._state !== 'stopped'
    this._stopped = true
    this._state = 'stopped'
    this._guard('stop', () => this._dispose())
    if (wasActive) this._log('scrcpy 通道已关闭')
    return true
  }

  /**
   * 收掉设备端这一次起起来的 scrcpy-server 进程。
   * adb forward 删掉不会杀死它：服务进程会一直占着编码器，下一次启动就撞车（实测表现为
   * 「换源后没有帧」）。按 scid 精确定位，绝不误伤别的 scrcpy 会话。
   * @returns {void}
   */
  /** 清掉设备上跑着本站 jar 的残留 server（只认插件独占路径）。 */
  async _reapOwnServers() {
    try {
      await this._runCommand([
        ...this._adbBaseArgs(),
        'shell',
        "pkill -9 -f 'dsh-mobile-use-scrcpy-server.jar' 2>/dev/null; echo ok",
      ], { timeoutMs: 2000 })
    } catch {
      /* 清不掉就照旧起，别为了收尾把启动搞坏 */
    }
  }

  _killDeviceServer() {
    const hex = (this._scid >>> 0).toString(16).padStart(8, '0')
    const tag = `scid=${hex}`
    const script = `pkill -9 -f '${tag}' 2>/dev/null; ps -A -o PID,ARGS 2>/dev/null | grep -F '${tag}' | grep -v grep | awk '{print $1}' | while read r; do kill -9 "$r" 2>/dev/null; done; echo ok`
    this._guard('kill device server', () => {
      void this._runCommand([...this._adbBaseArgs(), 'shell', script], { timeoutMs: 3000 })
    })
  }

  _dispose() {
    /* `closed` listeners may call stop() to reap the device-side server.
       Mark disposal before emitting `closed`, otherwise stop -> closed -> stop
       recursively starts more adb commands until the host exhausts the stack. */
    if (this._disposed) return
    this._disposed = true

    // 0) 收掉设备端的服务进程：只删 forward 会留下僵尸，占着编码器
    this._killDeviceServer()

    // 0) 收掉 forward 隧道（失败也不影响收尾，回调已 guard）
    this._guard('dispose forward', () => {
      const port = String(this._options.port)
      void this._runCommand([...this._adbBaseArgs(), 'forward', '--remove', `tcp:${port}`], { timeoutMs: 2000 })
    })

    // 1) 让还在等 ready 的 start() 立刻收尾
    const finishReady = this._readyFinish
    this._readyFinish = null
    if (typeof finishReady === 'function') {
      try {
        finishReady(false)
      } catch {
        /* 已经 settled */
      }
    }

    // 2) 定时器
    for (const timer of this._timers) {
      try {
        clearTimeout(timer)
      } catch {
        /* 已经触发过 */
      }
    }
    this._timers.clear()

    // 3) socket（先摘监听器再 destroy，避免 close 回调里再进来）
    const sockets = this._sockets
    this._sockets = []
    this._video = null
    this._control = null
    for (const socket of sockets) {
      this._guard('dispose socket', () => {
        socket?.removeAllListeners?.()
        socket?.destroy?.()
      })
    }

    // 4) 监听端口
    const server = this._netServer
    this._netServer = null
    if (server) {
      this._guard('dispose server', () => {
        server.removeAllListeners?.()
        server.close?.()
      })
    }

    // 5) 子进程
    const child = this._child
    this._child = null
    if (child) {
      this._guard('dispose child', () => {
        child.removeAllListeners?.()
        child.stdin?.destroy?.()
        child.stdout?.destroy?.()
        child.stderr?.destroy?.()
        child.kill?.('SIGKILL')
      })
    }

    // 6) 解析器
    this._parser = null
    this._headerEmitted = false
    this.emitSafe('closed')
  }
}

export default ScrcpyChannel
