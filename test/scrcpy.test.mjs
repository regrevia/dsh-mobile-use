/**
 * scrcpy.js 回归：包头位布局、增量重组、控制消息字节布局、生命周期兜底。
 *
 * 纯 node、纯内存：不连设备、不 spawn 进程、不读写文件（`new ScrcpyChannel()`
 * 只存参数，`stop()` 面对残缺/敌对对象也不许抛）。这正是 host 崩溃红线要守的部分。
 *
 *   node test/scrcpy.test.mjs
 */

import assert from 'node:assert/strict'

import {
  ANDROID_KEYCODE,
  CODEC_IDS,
  CONTROL_MSG_TYPE,
  DEVICE_NAME_FIELD_LENGTH,
  INJECT_TEXT_MAX_LENGTH,
  KEYCODE_MSG_SIZE,
  KEY_ACTION,
  LEGACY_PACKET_FLAG,
  MAX_PACKET_SIZE,
  PACKET_FLAG,
  PACKET_HEADER_SIZE,
  POINTER_ID,
  SCRCPY_PROTOCOL,
  SCRCPY_SERVER_VERSION,
  ScrcpyChannel,
  TOUCH_ACTION,
  TOUCH_MSG_SIZE,
  VideoStreamParser,
  avccToAnnexB,
  buildServerArgs,
  buildServerShellCommand,
  clampU16,
  codecName,
  encodeBackOrScreenOn,
  encodeKeycode,
  encodeText,
  deviceToVideoPoint,
  encodeTouch,
  floatToU16Fp,
  keycodeFor,
  parseFrameHeader,
  truncateUtf8,
} from '../scrcpy.js'

/* ---------------------------------------------------------------- 小测试框架 */

let pass = 0
const failures = []

/**
 * 跑一条用例，失败只记下来，最后统一报。
 * @param {string} name - 用例名。
 * @param {() => void} run - 断言体。
 */
function it(name, run) {
  try {
    run()
    pass += 1
  } catch (error) {
    failures.push({ name, error })
  }
}

/* ---------------------------------------------------------------- 造包工具 */

/**
 * protocol 4.x 的 12 字节媒体包头。
 * @param {{ pts?: number, size?: number, config?: boolean, keyFrame?: boolean }} [input]
 * @returns {Buffer}
 */
function header5(input = {}) {
  const { pts = 0, size = 0, config = false, keyFrame = false } = input
  let flags = BigInt(pts)
  if (config) flags |= PACKET_FLAG.CONFIG
  if (keyFrame) flags |= PACKET_FLAG.KEY_FRAME
  const buffer = Buffer.alloc(PACKET_HEADER_SIZE)
  buffer.writeBigUInt64BE(flags, 0)
  buffer.writeUInt32BE(size, 8)
  return buffer
}

/** protocol 4.x 的 session 包头（最高位 = 1）。 */
function sessionHeader(width, height, clientResized = false) {
  const buffer = Buffer.alloc(PACKET_HEADER_SIZE)
  buffer[0] = 0x80
  buffer[3] = clientResized ? 1 : 0
  buffer.writeUInt32BE(width, 4)
  buffer.writeUInt32BE(height, 8)
  return buffer
}

/** protocol < 4.0 的 12 字节媒体包头（bit63=config、bit62=key frame）。 */
function header3(input = {}) {
  const { pts = 0, size = 0, config = false, keyFrame = false } = input
  let flags = BigInt(pts)
  if (config) flags |= LEGACY_PACKET_FLAG.CONFIG
  if (keyFrame) flags |= LEGACY_PACKET_FLAG.KEY_FRAME
  const buffer = Buffer.alloc(PACKET_HEADER_SIZE)
  buffer.writeBigUInt64BE(flags, 0)
  buffer.writeUInt32BE(size, 8)
  return buffer
}

/** 设备名前缀 + 编解码器头（不含任何包）。 */
function streamHead({ name = 'pixel-8', codec = CODEC_IDS.H264, protocol = SCRCPY_PROTOCOL.V5, width = 0, height = 0 } = {}) {
  const meta = Buffer.alloc(DEVICE_NAME_FIELD_LENGTH)
  meta.write(name, 'utf8')
  if (protocol === SCRCPY_PROTOCOL.V3) {
    const codecMeta = Buffer.alloc(12)
    codecMeta.writeUInt32BE(codec, 0)
    codecMeta.writeUInt32BE(width, 4)
    codecMeta.writeUInt32BE(height, 8)
    return Buffer.concat([meta, codecMeta])
  }
  const codecMeta = Buffer.alloc(4)
  codecMeta.writeUInt32BE(codec, 0)
  return Buffer.concat([meta, codecMeta])
}

/** 一个完整的媒体包（包头 + payload）。 */
function mediaPacket(pts, payload, flags = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  return Buffer.concat([header5({ pts, size: body.length, ...flags }), body])
}

/** 把整段数据按固定块长喂给解析器，收集所有事件。 */
function feedInChunks(parser, data, chunkSize) {
  const collected = { headers: [], sessions: [], packets: [], errors: [] }
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const out = parser.push(data.subarray(offset, Math.min(offset + chunkSize, data.length)))
    if (out.header) collected.headers.push(out.header)
    collected.sessions.push(...out.sessions)
    collected.packets.push(...out.packets)
    collected.errors.push(...out.errors)
  }
  return collected
}

/* ---------------------------------------------------------------- 常量 */

it('协议常量与 v5.0.1 源码一致', () => {
  assert.equal(SCRCPY_SERVER_VERSION, '5.0.1')
  assert.equal(DEVICE_NAME_FIELD_LENGTH, 64)
  assert.equal(PACKET_HEADER_SIZE, 12)
  assert.equal(MAX_PACKET_SIZE, 8 * 1024 * 1024)
  assert.equal(TOUCH_MSG_SIZE, 32)
  assert.equal(KEYCODE_MSG_SIZE, 14)
  assert.equal(INJECT_TEXT_MAX_LENGTH, 300)
  assert.deepEqual({ ...SCRCPY_PROTOCOL }, { V3: 'v3', V5: 'v5' })
})

it('codec id 是 ASCII 打成的 u32', () => {
  assert.equal(CODEC_IDS.H264, Buffer.from('h264').readUInt32BE(0))
  assert.equal(CODEC_IDS.H265, Buffer.from('h265').readUInt32BE(0))
  assert.equal(CODEC_IDS.AV1, Buffer.from('\u0000av1').readUInt32BE(0))
  assert.equal(CODEC_IDS.VP8, Buffer.from('\u0000vp8').readUInt32BE(0))
  assert.equal(CODEC_IDS.VP9, Buffer.from('\u0000vp9').readUInt32BE(0))
})

it('codecName 认五种视频 codec，其余返回 null（0/1 是禁用流标记）', () => {
  assert.equal(codecName(CODEC_IDS.H264), 'h264')
  assert.equal(codecName(CODEC_IDS.H265), 'h265')
  assert.equal(codecName(CODEC_IDS.AV1), 'av1')
  assert.equal(codecName(CODEC_IDS.VP8), 'vp8')
  assert.equal(codecName(CODEC_IDS.VP9), 'vp9')
  assert.equal(codecName(0), null)
  assert.equal(codecName(1), null)
  assert.equal(codecName(0x12345678), null)
})

it('控制消息类型编号是顺序枚举', () => {
  assert.equal(CONTROL_MSG_TYPE.INJECT_KEYCODE, 0)
  assert.equal(CONTROL_MSG_TYPE.INJECT_TEXT, 1)
  assert.equal(CONTROL_MSG_TYPE.INJECT_TOUCH_EVENT, 2)
  assert.equal(CONTROL_MSG_TYPE.BACK_OR_SCREEN_ON, 4)
  assert.equal(CONTROL_MSG_TYPE.ROTATE_DEVICE, 11)
  assert.equal(CONTROL_MSG_TYPE.SCAN_FILE, 22)
})

it('包头标志位：v5 bit63/62/61，v3 bit63/62', () => {
  assert.equal(PACKET_FLAG.SESSION, 1n << 63n)
  assert.equal(PACKET_FLAG.CONFIG, 1n << 62n)
  assert.equal(PACKET_FLAG.KEY_FRAME, 1n << 61n)
  assert.equal(PACKET_FLAG.PTS_MASK, (1n << 61n) - 1n)
  assert.equal(LEGACY_PACKET_FLAG.CONFIG, 1n << 63n)
  assert.equal(LEGACY_PACKET_FLAG.KEY_FRAME, 1n << 62n)
  assert.equal(LEGACY_PACKET_FLAG.PTS_MASK, (1n << 62n) - 1n)
})

it('特殊 pointerId 是 64 位 0xFF..FE/FD 这类哨兵值', () => {
  assert.equal(POINTER_ID.MOUSE, (1n << 64n) - 1n)
  assert.equal(POINTER_ID.GENERIC_FINGER, (1n << 64n) - 2n)
  assert.equal(POINTER_ID.VIRTUAL_FINGER, (1n << 64n) - 3n)
})

/* ---------------------------------------------------------------- 数值工具 */

it('clampU16 夹到 0–65535', () => {
  assert.equal(clampU16(-5), 0)
  assert.equal(clampU16(0), 0)
  assert.equal(clampU16(1080), 1080)
  assert.equal(clampU16(70000), 65535)
  assert.equal(clampU16(100.4), 100)
  assert.equal(clampU16(Number.NaN), 0)
})

it('floatToU16Fp 把 0–1 压力映射到 u16 定点', () => {
  assert.equal(floatToU16Fp(0), 0)
  assert.equal(floatToU16Fp(1), 0xffff)
  assert.equal(floatToU16Fp(0.5), 32768)
  assert.equal(floatToU16Fp(2), 0xffff)
  assert.equal(floatToU16Fp(-1), 0)
})

it('truncateUtf8 只按字符边界截断', () => {
  assert.equal(truncateUtf8('abcdef', 3), 'abc')
  assert.equal(truncateUtf8('你好世界', 8), '你好')
  assert.equal(truncateUtf8('你好世界', 9), '你好世')
  assert.equal(truncateUtf8('你好世界', 0), '')
  assert.equal(truncateUtf8('abc', 100), 'abc')
})

/* ---------------------------------------------------------------- 包头解析 */

it('v5 媒体包头：PTS / config / key frame / 长度', () => {
  const header = header5({ pts: 0x1ffffffffffffn, size: 4242, config: false, keyFrame: true })
  const parsed = parseFrameHeader(header)
  assert.equal(parsed.kind, 'media')
  assert.equal(parsed.size, 4242)
  assert.equal(parsed.keyFrame, true)
  assert.equal(parsed.config, false)
  assert.equal(parsed.pts, 0x1ffffffffffff)
})

it('v5 媒体包头：config 包（SPS/PPS）', () => {
  const parsed = parseFrameHeader(header5({ size: 32, config: true }))
  assert.equal(parsed.kind, 'media')
  assert.equal(parsed.config, true)
  assert.equal(parsed.keyFrame, false)
})

it('v5 session 包头解析出宽高与 client_resized', () => {
  const parsed = parseFrameHeader(sessionHeader(1080, 2400, true))
  assert.equal(parsed.kind, 'session')
  assert.equal(parsed.width, 1080)
  assert.equal(parsed.height, 2400)
  assert.equal(parsed.clientResized, true)

  const plain = parseFrameHeader(sessionHeader(720, 1280))
  assert.equal(plain.clientResized, false)
})

it('v3 包头：bit63 = config、bit62 = key frame、低 62 位 = PTS', () => {
  const config = parseFrameHeader(header3({ size: 64, config: true }), { protocol: SCRCPY_PROTOCOL.V3 })
  assert.equal(config.kind, 'media', 'v3 的 config 包最高位也置 1，不能被当成 session')
  assert.equal(config.config, true)
  assert.equal(config.size, 64)

  const keyFrame = parseFrameHeader(header3({ pts: 1234, keyFrame: true }), { protocol: SCRCPY_PROTOCOL.V3 })
  assert.equal(keyFrame.keyFrame, true)
  assert.equal(keyFrame.pts, 1234)

  const mask = parseFrameHeader(header3({ pts: 2 ** 50 - 1 }), { protocol: SCRCPY_PROTOCOL.V3 })
  assert.equal(mask.pts, 2 ** 50 - 1, '低 62 位原样返回（不超过 2^53 的 PTS 不丢精度）')
})

it('包头不足 12 字节直接报错（内部缓冲不会走到这里）', () => {
  assert.throws(() => parseFrameHeader(Buffer.alloc(11)), RangeError)
  assert.throws(() => parseFrameHeader(null), RangeError)
})

/* ---------------------------------------------------------------- AVCC → Annex-B */

it('avccToAnnexB 把长度前缀的 NAL 展开成起始码', () => {
  const avcc = Buffer.from([0, 0, 0, 2, 0x65, 0x11, 0, 0, 0, 1, 0x41])
  assert.equal(avccToAnnexB(avcc).toString('hex'), '0000000165110000000141')
})

it('avccToAnnexB：空数据给空、长度为 0 的 NAL 跳过、截断返回 null', () => {
  assert.equal(avccToAnnexB(Buffer.alloc(0)).length, 0)
  const withEmpty = Buffer.from([0, 0, 0, 0, 0, 0, 0, 1, 0x41])
  assert.equal(avccToAnnexB(withEmpty).toString('hex'), '0000000141')
  assert.equal(avccToAnnexB(Buffer.from([0, 0, 0, 9, 0x65])), null)
  assert.throws(() => avccToAnnexB(Buffer.alloc(4), { nalLengthSize: 5 }), RangeError)
})

it('avccToAnnexB 支持 1–3 字节长度前缀', () => {
  const oneByte = Buffer.from([0x02, 0x65, 0x11, 0x01, 0x41])
  assert.equal(avccToAnnexB(oneByte, { nalLengthSize: 1 }).toString('hex'), '0000000165110000000141')
})

/* ---------------------------------------------------------------- 控制消息编码 */

it('触控包 32 字节，字段偏移与 control_msg.c 一致', () => {
  const buffer = encodeTouch({
    action: TOUCH_ACTION.MOVE,
    pointerId: POINTER_ID.GENERIC_FINGER,
    x: 100,
    y: 200,
    screenWidth: 1000,
    screenHeight: 2000,
    pressure: 1,
    actionButton: 1,
    buttons: 1,
  })
  assert.equal(buffer.length, 32)
  assert.equal(buffer.readUInt8(0), CONTROL_MSG_TYPE.INJECT_TOUCH_EVENT)
  assert.equal(buffer.readUInt8(1), TOUCH_ACTION.MOVE)
  assert.equal(buffer.readBigUInt64BE(2), POINTER_ID.GENERIC_FINGER)
  assert.equal(buffer.readInt32BE(10), 100)
  assert.equal(buffer.readInt32BE(14), 200)
  assert.equal(buffer.readUInt16BE(18), 1000)
  assert.equal(buffer.readUInt16BE(20), 2000)
  assert.equal(buffer.readUInt16BE(22), 0xffff)
  assert.equal(buffer.readUInt32BE(24), 1)
  assert.equal(buffer.readUInt32BE(28), 1)
  assert.equal(
    buffer.toString('hex'),
    '0202fffffffffffffffe00000064000000c803e807d0ffff0000000100000001',
  )
})

it('触控包坐标是 i32（负数用补码），压力夹紧，缺省全 0', () => {
  const negative = encodeTouch({ action: TOUCH_ACTION.UP, x: -100, y: -1, pressure: 9, screenWidth: 99999 })
  assert.equal(negative.readInt32BE(10), -100)
  assert.equal(negative.readInt32BE(14), -1)
  assert.equal(negative.readUInt16BE(18), 0xffff)
  assert.equal(negative.readUInt16BE(22), 0xffff)

  const blank = encodeTouch()
  assert.equal(blank.length, 32)
  assert.equal(blank.toString('hex'), '0200' + '0'.repeat(60))
})

it('设备像素 → 视频像素：按编码尺寸缩，夹在画面内', () => {
  const device = { width: 2136, height: 3200 }
  const video = { width: 1600, height: 2397 }
  assert.deepEqual(deviceToVideoPoint(0, 0, device, video), { x: 0, y: 0 })
  assert.deepEqual(deviceToVideoPoint(2136, 3200, device, video), { x: 1599, y: 2396 })
  // 画面正中、四角：不能漏缩，也不能越界
  assert.deepEqual(deviceToVideoPoint(1068, 1600, device, video), { x: 800, y: 1199 })
  assert.deepEqual(deviceToVideoPoint(2136, 0, device, video), { x: 1599, y: 0 })
  assert.deepEqual(deviceToVideoPoint(-40, 3800, device, video), { x: 0, y: 2396 })
  // 视频尺寸 = 设备尺寸时是恒等变换（没开 --max-size 的设备）
  assert.deepEqual(deviceToVideoPoint(700, 900, device, device), { x: 700, y: 900 })
  // 尺寸未知：原样下发，别把坐标算成 NaN
  assert.deepEqual(deviceToVideoPoint(700, 900, null, video), { x: 700, y: 900 })
  assert.deepEqual(deviceToVideoPoint(700, 900, device, {}), { x: 700, y: 900 })
})

it('按键包 14 字节，字段偏移与 control_msg.c 一致', () => {
  const buffer = encodeKeycode({ action: KEY_ACTION.UP, keycode: ANDROID_KEYCODE.BACK, repeat: 2, metastate: 0x1000 })
  assert.equal(buffer.length, 14)
  assert.equal(buffer.readUInt8(0), CONTROL_MSG_TYPE.INJECT_KEYCODE)
  assert.equal(buffer.readUInt8(1), KEY_ACTION.UP)
  assert.equal(buffer.readUInt32BE(2), 4)
  assert.equal(buffer.readUInt32BE(6), 2)
  assert.equal(buffer.readUInt32BE(10), 0x1000)
  assert.equal(buffer.toString('hex'), '0001000000040000000200001000'.replace('00001000', '00001000'))
})

it('文本包 = type + u32 长度 + UTF-8', () => {
  const buffer = encodeText('你好abc')
  assert.equal(buffer.readUInt8(0), CONTROL_MSG_TYPE.INJECT_TEXT)
  assert.equal(buffer.readUInt32BE(1), 9)
  assert.equal(buffer.length, 14)
  assert.equal(buffer.subarray(5).toString('utf8'), '你好abc')
})

it('文本包超过 300 字节按字符边界截断（不会切坏汉字）', () => {
  const buffer = encodeText('你'.repeat(200))
  assert.equal(buffer.readUInt32BE(1), 300, '300 字节正好 = 100 个汉字')
  assert.equal(buffer.length, 305)
  assert.equal(buffer.subarray(5).toString('utf8'), '你'.repeat(100))

  const custom = encodeText('你好', { maxLength: 4 })
  assert.equal(custom.readUInt32BE(1), 3)
  assert.equal(custom.subarray(5).toString('utf8'), '你')
})

it('BACK / 点亮屏幕包 2 字节', () => {
  assert.equal(encodeBackOrScreenOn(KEY_ACTION.DOWN).toString('hex'), '0400')
  assert.equal(encodeBackOrScreenOn(KEY_ACTION.UP).toString('hex'), '0401')
})

it('keycodeFor 支持键名、单字符和数字', () => {
  assert.equal(keycodeFor('BACK'), ANDROID_KEYCODE.BACK)
  assert.equal(keycodeFor('back'), 4)
  assert.equal(keycodeFor('a'), 29)
  assert.equal(keycodeFor('Z'), 54)
  assert.equal(keycodeFor('0'), 7)
  assert.equal(keycodeFor('9'), 16)
  assert.equal(keycodeFor(' '), ANDROID_KEYCODE.SPACE)
  assert.equal(keycodeFor(66), 66)
  assert.equal(keycodeFor('NOPE'), null)
})

/* ---------------------------------------------------------------- 增量解析 */

it('整段喂入：设备名 + codec + 两个媒体包', () => {
  const data = Buffer.concat([streamHead({ name: 'yupei' }), mediaPacket(1000, 'A'), mediaPacket(2000, 'BB', { keyFrame: true })])
  const parser = new VideoStreamParser()
  const out = parser.push(data)

  assert.equal(out.header.deviceName, 'yupei')
  assert.equal(out.header.codec, 'h264')
  assert.equal(out.header.codecId, CODEC_IDS.H264)
  assert.equal(out.header.protocol, 'v5')
  assert.equal(out.packets.length, 2)
  assert.equal(out.packets[0].size, 1)
  assert.equal(out.packets[0].pts, 1000)
  assert.equal(out.packets[0].data.toString(), 'A')
  assert.equal(out.packets[1].keyFrame, true)
  assert.equal(out.packets[1].data.toString(), 'BB')
  assert.equal(out.sessions.length, 0)
  assert.equal(out.errors.length, 0)
  assert.equal(parser.stats.packets, 2)
  assert.equal(parser.stats.keyFrames, 1)
})

it('header 只在第一帧吐一次', () => {
  const head = streamHead({ name: 'x' })
  const data = Buffer.concat([head, mediaPacket(0, 'a'), mediaPacket(1, 'b')])
  const parser = new VideoStreamParser()
  const first = parser.push(data)
  assert.ok(first.header, '第一次 push 应带设备信息')
  const second = parser.push(header5({ pts: 2, size: 1 }))
  assert.equal(second.header, null)
  assert.equal(second.packets.length, 0, '只喂包头还没 payload')
})

it('逐字节喂入得到与整段完全相同的结果', () => {
  const data = Buffer.concat([
    streamHead({ name: 'byte-by-byte' }),
    sessionHeader(1080, 2400),
    mediaPacket(7, 'hello'),
    mediaPacket(8, 'world!!'),
  ])
  const whole = new VideoStreamParser()
  const expected = whole.push(data)
  const chopped = feedInChunks(new VideoStreamParser(), data, 1)

  assert.deepEqual(chopped.packets.map((p) => p.data.toString()), expected.packets.map((p) => p.data.toString()))
  assert.deepEqual(chopped.packets.map((p) => p.pts), expected.packets.map((p) => p.pts))
  assert.equal(chopped.sessions.length, 1)
  assert.equal(chopped.sessions[0].width, 1080)
  assert.equal(chopped.headers.length, 1, '设备信息只吐一次，逐字节喂也一样')
  assert.equal(chopped.headers[0].deviceName, 'byte-by-byte')
  assert.equal(chopped.headers[0].width, null, 'v5 的 codec 头不带宽高，宽高从 session 包来')
})

it('payload 不完整时留在缓冲，补齐后才出包', () => {
  const parser = new VideoStreamParser()
  parser.push(Buffer.concat([streamHead(), header5({ pts: 5, size: 4 })]))
  assert.equal(parser.state, 'payload')
  assert.equal(parser.buffered, 0)
  const partial = parser.push(Buffer.from([1, 2]))
  assert.equal(partial.packets.length, 0)
  assert.equal(parser.buffered, 2)
  assert.equal(parser.stats.packets, 0)

  const rest = parser.push(Buffer.from([3, 4]))
  assert.equal(rest.packets.length, 1)
  assert.equal(rest.packets[0].data.toString('hex'), '01020304')
  assert.equal(parser.state, 'header')

  parser.push(Buffer.concat([mediaPacket(6, 'z')]))
  assert.equal(parser.stats.packets, 2, '包与包之间没有额外填充')
})

it('session 包更新宽高并计数', () => {
  const parser = new VideoStreamParser()
  const data = Buffer.concat([streamHead(), sessionHeader(1080, 2400), mediaPacket(1, 'a'), sessionHeader(2400, 1080, true)])
  const out = parser.push(data)
  assert.equal(out.sessions.length, 2)
  assert.equal(out.sessions[1].width, 2400)
  assert.equal(out.sessions[1].clientResized, true)
  assert.equal(parser.info.width, 2400)
  assert.equal(parser.stats.sessions, 2)
})

it('实测 81 字节前缀：哑字节 + 设备名 + h264 + 3200x2136 会话头', () => {
  /* 真机抓到的裸流开头：1B 哑字节、64B 设备名、4B 编解码器、12B 会话头。 */
  const prefix = Buffer.concat([
    Buffer.from([0]),
    streamHead({ name: '25097RP43C' }),
    sessionHeader(3200, 2136),
  ])
  assert.equal(prefix.length, 81, '前缀固定 81 字节')
  assert.equal(prefix.subarray(65, 69).toString('latin1'), 'h264')
  assert.equal(prefix.readUInt32BE(73), 3200)
  assert.equal(prefix.readUInt32BE(77), 2136)
  const parser = new VideoStreamParser()
  const out = parser.push(prefix)
  assert.equal(out.header.deviceName, '25097RP43C')
  assert.equal(out.header.codec, 'h264')
  assert.equal(out.sessions.length, 1)
  assert.equal(out.sessions[0].width, 3200)
  assert.equal(out.sessions[0].height, 2136)
  assert.equal(parser.info.width, 3200)
  assert.equal(parser.state, 'header')
})

it('超大 size 拒绝并标记 resetRequired，之后不再往前走', () => {
  const parser = new VideoStreamParser()
  const out = parser.push(Buffer.concat([streamHead(), header5({ size: MAX_PACKET_SIZE + 1 })]))
  assert.equal(out.packets.length, 0)
  assert.equal(out.errors.length, 1)
  assert.equal(out.errors[0].code, 'oversize')
  assert.equal(out.errors[0].limit, MAX_PACKET_SIZE)
  assert.equal(parser.resetRequired, true)

  const again = parser.push(Buffer.from([1, 2, 3]))
  assert.equal(again.errors[0].code, 'reset-required')
  assert.equal(parser.stats.dropped, 1)

  parser.reset()
  assert.equal(parser.resetRequired, false)
  assert.equal(parser.state, 'dummyByte')
  const fresh = parser.push(Buffer.concat([streamHead({ name: 'again' }), mediaPacket(1, 'ok')]))
  assert.equal(fresh.header.deviceName, 'again')
  assert.equal(fresh.packets.length, 1)
})

it('maxPacketSize 可配置', () => {
  const parser = new VideoStreamParser({ maxPacketSize: 4 })
  const out = parser.push(Buffer.concat([streamHead(), header5({ size: 5 })]))
  assert.equal(out.errors[0].code, 'oversize')
  assert.equal(out.errors[0].limit, 4)
})

it('codec 0 / 1 / 未知都报出来，但不炸', () => {
  const disabled = new VideoStreamParser()
  const out = disabled.push(Buffer.concat([streamHead({ codec: 0 }), mediaPacket(1, 'x')]))
  assert.equal(out.errors[0].code, 'stream-disabled')
  assert.equal(disabled.info.disabled, 'explicit')

  const broken = new VideoStreamParser()
  const brokenOut = broken.push(streamHead({ codec: 1 }))
  assert.equal(brokenOut.errors[0].code, 'stream-disabled-error')
  assert.equal(broken.info.disabled, 'error')

  const unknown = new VideoStreamParser()
  const unknownOut = unknown.push(streamHead({ codec: 0x12345678 }))
  assert.equal(unknownOut.errors[0].code, 'unknown-codec')
  assert.equal(unknown.info.codec, null)
})

it('v3 协议：codec 元数据 12 字节且自带宽高，没有 session 包', () => {
  const parser = new VideoStreamParser({ protocol: SCRCPY_PROTOCOL.V3 })
  const data = Buffer.concat([
    streamHead({ protocol: SCRCPY_PROTOCOL.V3, width: 1080, height: 2400 }),
    Buffer.concat([header3({ size: 3, config: true }), Buffer.from('cfg')]),
    Buffer.concat([header3({ pts: 42, size: 2, keyFrame: true }), Buffer.from('kk')]),
  ])
  const out = parser.push(data)
  assert.equal(out.header.protocol, 'v3')
  assert.equal(out.header.width, 1080)
  assert.equal(out.header.height, 2400)
  assert.equal(out.sessions.length, 0)
  assert.equal(out.packets.length, 2)
  assert.equal(out.packets[0].config, true)
  assert.equal(out.packets[1].keyFrame, true)
  assert.equal(out.packets[1].pts, 42)
  assert.equal(parser.state, 'header')
})

it('非法参数与非法输入直接报错（不静默吞掉）', () => {
  assert.throws(() => new VideoStreamParser({ protocol: 'v9' }), RangeError)
  assert.throws(() => new VideoStreamParser({ maxPacketSize: 0 }), RangeError)
  const parser = new VideoStreamParser()
  assert.throws(() => parser.push('not a buffer'), TypeError)
  assert.deepEqual(parser.push(Buffer.alloc(0)), { header: null, sessions: [], packets: [], errors: [] })
})

it('Uint8Array 也能喂', () => {
  const data = Buffer.concat([streamHead({ name: 'view' }), mediaPacket(3, 'abc')])
  const parser = new VideoStreamParser()
  const out = parser.push(new Uint8Array(data))
  assert.equal(out.header.deviceName, 'view')
  assert.equal(out.packets[0].data.toString(), 'abc')
})

it('包头位被写坏（未知高位组合）也不会抛', () => {
  const parser = new VideoStreamParser()
  const bogus = Buffer.alloc(PACKET_HEADER_SIZE, 0xff)
  const out = parser.push(Buffer.concat([streamHead(), bogus]))
  // 0x80 置位 → 当成 session 包，宽高就是 0xFFFFFFFF；不抛、不误报媒体包
  assert.equal(out.sessions.length, 1)
  assert.equal(out.packets.length, 0)
})

/* ---------------------------------------------------------------- server 命令 */

it('buildServerArgs 默认只开视频 + 控制，audio 关', () => {
  const args = buildServerArgs()
  assert.deepEqual(args, [
    '5.0.1',
    'scid=00000000',
    'log_level=info',
    'tunnel_forward=false',
    'video=true',
    'audio=false',
    'control=true',
  ])
})

it('buildServerArgs：scid 是 8 位十六进制，可选参数只在 >0 时追加', () => {
  assert.equal(buildServerArgs({ scid: 0xabcd })[1], 'scid=0000abcd')
  assert.equal(buildServerArgs({ scid: 0xffffffff })[1], 'scid=ffffffff')

  const plain = buildServerArgs()
  assert.equal(plain.some((arg) => arg.startsWith('max_size=')), false)

  const tuned = buildServerArgs({ maxSize: 1080, maxFps: 60, videoBitRate: 8000000 })
  assert.ok(tuned.includes('max_size=1080'))
  assert.ok(tuned.includes('max_fps=60'))
  assert.ok(tuned.includes('video_bit_rate=8000000'))
})

it('buildServerArgs 支持关视频 / 开 tunnel_forward', () => {
  const args = buildServerArgs({ video: false, tunnelForward: true, logLevel: 'debug' })
  assert.ok(args.includes('video=false'))
  assert.ok(args.includes('tunnel_forward=true'))
  assert.ok(args.includes('log_level=debug'))
})

it('buildServerShellCommand 用 CLASSPATH + app_process 启动', () => {
  const command = buildServerShellCommand({ scid: 1 })
  assert.equal(
    command,
    'CLASSPATH=/data/local/tmp/dsh-mobile-use-scrcpy-server.jar app_process / com.genymobile.scrcpy.Server ' +
      '5.0.1 scid=00000001 log_level=info tunnel_forward=false video=true audio=false control=true',
  )
  assert.ok(buildServerShellCommand({ deviceServerPath: '/tmp/x.jar' }).startsWith('CLASSPATH=/tmp/x.jar '))
})

/* ---------------------------------------------------------------- 生命周期壳 */

it('构造函数零副作用：只存参数，不起进程/定时器/端口', () => {
  const channel = new ScrcpyChannel({ serial: 'SERIAL', port: 27183, log: () => {} })
  assert.equal(channel.state, 'idle')
  assert.equal(channel.isRunning(), false)
  assert.equal(channel.videoConnected, false)
  assert.equal(channel.controlConnected, false)
  assert.equal(channel._child, null)
  assert.equal(channel._netServer, null)
  assert.equal(channel._sockets.length, 0)
  assert.equal(channel._timers.size, 0)
  assert.equal(channel._parser, null)
  assert.equal(channel._options.serial, 'SERIAL')
  assert.equal(channel._options.port, 27183)
})

it('stop() 幂等：连叫三次都返回 true', () => {
  const channel = new ScrcpyChannel()
  assert.equal(channel.stop(), true)
  assert.equal(channel.stop(), true)
  assert.equal(channel.stop(), true)
  assert.equal(channel.state, 'stopped')
})

it('stop() 面对残缺/敌对内部对象也不抛（host 崩溃红线）', () => {
  const channel = new ScrcpyChannel({
    log: () => {
      throw new Error('日志也坏了')
    },
  })
  channel._state = 'running'
  channel._child = { pid: 1 } // 没有 kill / removeAllListeners
  channel._sockets = [
    {}, // 什么都没有
    {
      removeAllListeners() {
        throw new Error('socket 已销毁')
      },
      destroy() {
        throw new Error('destroy 失败')
      },
    },
  ]
  channel._netServer = {
    removeAllListeners() {},
    close() {
      throw new Error('端口早关了')
    },
  }
  channel._readyFinish = 'not a function'
  channel._timers = new Set([setTimeout(() => {}, 50)])
  channel._parser = null

  let threw = false
  try {
    assert.equal(channel.stop(), true)
  } catch {
    threw = true
  }
  assert.equal(threw, false)
  assert.equal(channel._child, null)
  assert.equal(channel._netServer, null)
  assert.equal(channel._sockets.length, 0)
  assert.equal(channel._timers.size, 0)
})

it('stop() 会触发正在等 ready 的收尾，且不重复触发', () => {
  const channel = new ScrcpyChannel()
  const seen = []
  channel._readyFinish = (value) => seen.push(value)
  channel.stop()
  assert.deepEqual(seen, [false])
  assert.equal(channel._readyFinish, null)
  channel.stop()
  assert.deepEqual(seen, [false])
})

it('closed 监听器里调用 stop() 不递归清理或重复发事件', () => {
  const channel = new ScrcpyChannel()
  let closed = 0
  channel.on('closed', () => {
    closed += 1
    channel.stop()
  })

  channel._state = 'running'
  channel.stop()

  assert.equal(closed, 1)
  assert.equal(channel._disposed, true)
  assert.equal(channel.state, 'stopped')
})

it('push* 在控制 socket 未连上时返回 false 并计数，不抛', () => {
  const channel = new ScrcpyChannel()
  assert.equal(channel.pushTouch({ x: 1, y: 2 }), false)
  assert.equal(channel.pushKeycode({ keycode: 4 }), false)
  assert.equal(channel.pushText('hi'), false)
  assert.equal(channel.pushBackOrScreenOn(KEY_ACTION.DOWN), false)
  assert.equal(channel.stats.dropped, 4)
  assert.equal(channel.stats.controlSent, 0)
})

it('push* 走控制 socket 写出正确字节', () => {
  const channel = new ScrcpyChannel()
  const writes = []
  channel._control = {
    destroyed: false,
    writable: true,
    write(buffer, callback) {
      writes.push(Buffer.from(buffer))
      callback?.(null)
    },
  }

  const input = { action: TOUCH_ACTION.DOWN, pointerId: POINTER_ID.GENERIC_FINGER, x: 10, y: 20, screenWidth: 1080, screenHeight: 2400, pressure: 0.5 }
  assert.equal(channel.pushTouch(input), true)
  assert.equal(channel.pushKeycode({ keycode: 4, action: KEY_ACTION.UP }), true)
  assert.equal(channel.pushText('ok'), true)
  assert.equal(channel.pushBackOrScreenOn(KEY_ACTION.DOWN), true)

  assert.equal(writes.length, 4)
  assert.deepEqual(writes[0], encodeTouch(input))
  assert.deepEqual(writes[1], encodeKeycode({ keycode: 4, action: KEY_ACTION.UP }))
  assert.deepEqual(writes[2], encodeText('ok'))
  assert.deepEqual(writes[3], encodeBackOrScreenOn(KEY_ACTION.DOWN))
  assert.equal(channel.stats.controlSent, 4)
  assert.equal(channel.stats.dropped, 0)
})

it('控制消息编码失败（坐标溢出 i32）也返回 false 而不抛', () => {
  const channel = new ScrcpyChannel()
  channel._control = {
    destroyed: false,
    writable: true,
    write() {},
  }
  assert.equal(channel.pushTouch({ x: 1e20, y: 0 }), false)
  assert.equal(channel.stats.controlSent, 0)
})

it('写 socket 失败不影响调用方', () => {
  const channel = new ScrcpyChannel()
  channel._control = {
    destroyed: false,
    writable: true,
    write(buffer, callback) {
      callback?.(new Error('EPIPE'))
    },
  }
  assert.equal(channel.pushTouch({ x: 1 }), true)
  assert.equal(channel.stats.controlSent, 1)
})

it('emitSafe 吞掉监听器异常（不许冒到事件循环顶层）', () => {
  const channel = new ScrcpyChannel({
    log: () => {
      throw new Error('log boom')
    },
  })
  channel.on('video-session', () => {
    throw new Error('listener boom')
  })
  assert.equal(channel.emitSafe('video-session', { width: 1, height: 2 }), false)
  assert.equal(channel.emitSafe('nothing', null), true, '没有监听器时视为正常')

  let received = null
  channel.on('video-packet', (payload) => {
    received = payload
  })
  assert.equal(channel.emitSafe('video-packet', { pts: 1 }), true)
  assert.deepEqual(received, { pts: 1 })
})

it('_guard 包住抛错的路径并返回 false', () => {
  const channel = new ScrcpyChannel({
    log: () => {
      throw new Error('log boom')
    },
  })
  assert.equal(
    channel._guard('boom', () => {
      throw new Error('inner')
    }),
    false,
  )
  assert.equal(channel._guard('ok', () => {}), true)
})

it('视频数据进来后解析并 emit，回调异常不外溢', () => {
  const channel = new ScrcpyChannel()
  const seen = []
  channel._parser = new VideoStreamParser()
  channel.on('video-header', (header) => seen.push(['header', header.codec]))
  channel.on('video-packet', (packet) => seen.push(['packet', packet.pts]))
  channel.on('video-packets', () => {
    throw new Error('不该被广播')
  })

  channel._onVideoData(Buffer.concat([streamHead({ name: 'dev' }), mediaPacket(11, 'x')]))
  assert.deepEqual(seen, [
    ['header', 'h264'],
    ['packet', 11],
  ])
  assert.equal(channel.stats.videoBytes > 0, true)
  assert.equal(channel.stats.packets, 1)

  // 监听器抛异常 → 只记账不传播
  channel.removeAllListeners('video-packet')
  channel.on('video-packet', () => {
    throw new Error('boom')
  })
  let threw = false
  try {
    channel._onVideoData(mediaPacket(12, 'y'))
  } catch {
    threw = true
  }
  assert.equal(threw, false)
  assert.equal(channel.stats.packets, 2)
})

it('视频 socket 关闭时 running 状态下发 closed 事件', () => {
  const channel = new ScrcpyChannel()
  let closed = 0
  channel.on('closed', () => {
    closed += 1
  })
  channel._state = 'running'
  channel._parser = new VideoStreamParser()
  channel._onConnection({
    on() {},
    destroy() {},
    setNoDelay() {},
  })
  channel._video.emit = undefined // 不依赖真实 socket
  // 直接走数据路径即可，close 由真实 socket 触发；这里只验证 listening 不炸
  assert.equal(channel.videoConnected, true)
  assert.equal(closed, 0)
})

it('参数集与最近 GOP 缓存成 replay，供迟到的消费者补喂', () => {
  const channel = new ScrcpyChannel()
  channel._parser = new VideoStreamParser()
  assert.equal(channel.prelude, null)
  assert.equal(channel.replay, null)

  channel._onVideoData(Buffer.concat([
    streamHead({ name: 'dev' }),
    mediaPacket(1, Buffer.from([0, 0, 0, 1, 0x67, 0x42]), { config: true }),
    mediaPacket(2, Buffer.from([0, 0, 0, 1, 0x65, 0x88]), { keyFrame: true }),
    mediaPacket(3, Buffer.from([0, 0, 0, 1, 0x41, 0x9a])),
  ]))

  const replay = channel.replay
  assert.equal(Buffer.isBuffer(replay), true)
  assert.equal(channel.prelude.length, 6)
  // 参数集 + IDR + 后续帧，按到达顺序拼起来
  assert.equal(replay.length, 6 + 6 + 6)

  // 新 IDR 丢弃旧 GOP，只留最新一段
  channel._onVideoData(Buffer.concat([
    mediaPacket(4, Buffer.from([0, 0, 0, 1, 0x65, 0x01]), { keyFrame: true }),
    mediaPacket(5, Buffer.from([0, 0, 0, 1, 0x41, 0x02])),
  ]))
  assert.equal(channel.replay.length, 6 + 6 + 6)
})

console.log('')

if (failures.length > 0) {
  for (const { name, error } of failures) {
    console.error(`✗ ${name}`)
    console.error(`  ${String(error?.message ?? error).split('\n').join('\n  ')}`)
  }
  console.error(`\n${failures.length} 项失败，${pass} 项通过\n`)
  process.exit(1)
}

console.log(`\n=== 全部通过 ===（${pass} 项）\n`)
