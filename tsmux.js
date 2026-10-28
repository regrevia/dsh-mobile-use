/**
 * 最小 MPEG-TS 封装：把「一帧裸 H.264 + 这一帧的真实时间戳」包成 TS 送进 ffmpeg。
 *
 * 为什么要自己封：裸 H.264 没有时间戳，ffmpeg 只能按读到的时刻打戳，而 scrcpy 的帧
 * 是一批一批到的，同一批会被打成一串几乎相同的时间戳，重封装出来的 MP4 时间轴就和
 * 真实节奏脱节（实测 5 秒采集能重封出 50 秒时间轴，浏览器里画面像定格）。
 * scrcpy 的每个视频包都带着设备端真实 PTS（微秒），封进 PES 就一条都不丢。
 *
 * 只做一路 H.264 视频流，不带 PCR（PCR_PID 用 0x1FFF 表示没有）。
 */

export const TS_PACKET_SIZE = 188
export const PAT_PID = 0x0000
export const PMT_PID = 0x1000
export const VIDEO_PID = 0x0100
const STREAM_TYPE_H264 = 0x1b
const PES_STREAM_ID_VIDEO = 0xe0
/** 33 位 90kHz 时间戳的最大值。 */
const PTS_MOD = 2 ** 33

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index << 24
    for (let bit = 0; bit < 8; bit += 1) value = (value & 0x80000000) !== 0 ? ((value << 1) ^ 0x04c11db7) >>> 0 : (value << 1) >>> 0
    table[index] = value >>> 0
  }
  return table
})()

/**
 * MPEG-2 段用的 CRC32（多项式 0x04C11DB7，不反转、不取反）。
 * @param {Buffer} data - 段内容（不含 CRC 本身）。
 * @returns {number} 32 位无符号 CRC。
 */
export function crc32Mpeg(data) {
  let crc = 0xffffffff
  for (const byte of data) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0
  return crc >>> 0
}

/**
 * 微秒 → 90kHz 的 33 位时间戳。
 * @param {number} ptsUs - 微秒时间戳。
 * @returns {number} 33 位时间戳。
 */
export function ptsFromUs(ptsUs) {
  const value = Number(ptsUs)
  if (!Number.isFinite(value)) return 0
  const ticks = Math.round((value * 9) / 100)
  const wrapped = ticks % PTS_MOD
  return wrapped < 0 ? wrapped + PTS_MOD : wrapped
}

/**
 * PAT：一个节目，指向 PMT。
 * @returns {Buffer} 段内容（含 CRC）。
 */
export function buildPatSection() {
  const body = Buffer.from([
    0x00, 0xb0, 0x0d, // table_id / section_length = 13
    0x00, 0x01, // transport_stream_id
    0xc1, // version 0, current_next 1
    0x00, 0x00, // section_number / last_section_number
    0x00, 0x01, // program_number 1
    0xe0 | ((PMT_PID >> 8) & 0x1f), PMT_PID & 0xff,
  ])
  const crc = crc32Mpeg(body)
  return Buffer.concat([body, Buffer.from([(crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff])])
}

/**
 * PMT：一路 H.264 视频，无 PCR。
 * @returns {Buffer} 段内容（含 CRC）。
 */
export function buildPmtSection() {
  const body = Buffer.from([
    0x02, 0xb0, 0x12, // table_id / section_length = 18
    0x00, 0x01, // program_number
    0xc1, 0x00, 0x00, // version / section_number / last_section_number
    0x1f, 0xff, // PCR_PID = 0x1FFF（没有 PCR）
    0xf0, 0x00, // program_info_length = 0
    STREAM_TYPE_H264,
    0xe0 | ((VIDEO_PID >> 8) & 0x1f), VIDEO_PID & 0xff,
    0xf0, 0x00, // ES_info_length = 0
  ])
  const crc = crc32Mpeg(body)
  return Buffer.concat([body, Buffer.from([(crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff])])
}

/**
 * 把一个 PSI 段切成 TS 包（首包带 pointer_field=0）。
 * @param {number} pid - 目标 PID。
 * @param {Buffer} section - 段内容。
 * @param {number} counter - 起始连续计数。
 * @returns {Buffer} 188 的整数倍。
 */
function packetizeSection(pid, section, counter) {
  const packets = []
  let offset = 0
  let index = 0
  while (offset < section.length || index === 0) {
    const header = Buffer.from([0x47, (index === 0 ? 0x40 : 0x00) | ((pid >> 8) & 0x1f), pid & 0xff, 0x10 | ((counter + index) & 0x0f)])
    const room = TS_PACKET_SIZE - 4 - (index === 0 ? 1 : 0)
    const take = Math.min(room, section.length - offset)
    const body = Buffer.alloc(TS_PACKET_SIZE - 4, 0xff)
    let cursor = 0
    if (index === 0) {
      body[0] = 0x00
      cursor = 1
    }
    section.copy(body, cursor, offset, offset + take)
    offset += take
    packets.push(Buffer.concat([header, body]))
    index += 1
  }
  return Buffer.concat(packets)
}

/**
 * 一帧裸 H.264 → 一个 PES 包（带 PTS）→ 若干 TS 包。
 * @param {Buffer} frame - Annex-B 裸 H.264（一个访问单元）。
 * @param {number} pts - 33 位 90kHz 时间戳。
 * @param {number} counter - 起始连续计数。
 * @returns {Buffer} 188 的整数倍。
 */
function packetizePes(frame, pts, counter) {
  /* PES 头固定 14 字节：6 字节起始码/长度 + flags1 + flags2 + header_data_length + 5 字节 PTS。
     这里少写一个字节，解复用器就会把帧头当 stuffing 吃掉，表现为「SPS/PPS 丢失、解不出画面」。 */
  const pesHeader = Buffer.alloc(14)
  pesHeader[0] = 0x00
  pesHeader[1] = 0x00
  pesHeader[2] = 0x01
  pesHeader[3] = PES_STREAM_ID_VIDEO
  /* 视频 PES 长度允许 0（不限长）：帧可能比 65535 大。 */
  pesHeader[4] = 0x00
  pesHeader[5] = 0x00
  pesHeader[6] = 0x80 // '10' + 不加密 + data_alignment_indicator
  pesHeader[7] = 0x80 // 只有 PTS
  pesHeader[8] = 0x05 // PES 头长度 = 5
  pesHeader[9] = 0x21 | (((pts >>> 30) & 0x07) << 1) | 0x01
  pesHeader[10] = (pts >>> 22) & 0xff
  pesHeader[11] = (((pts >>> 15) & 0x7f) << 1) | 0x01
  pesHeader[12] = (pts >>> 7) & 0xff
  pesHeader[13] = ((pts & 0x7f) << 1) | 0x01
  const payload = Buffer.concat([pesHeader, frame])
  const packets = []
  let offset = 0
  let index = 0
  const total = payload.length
  while (offset < total) {
    const remaining = total - offset
    const header = Buffer.from([0x47, (index === 0 ? 0x40 : 0x00) | ((VIDEO_PID >> 8) & 0x1f), VIDEO_PID & 0xff, 0x10 | ((counter + index) & 0x0f)])
    if (remaining >= TS_PACKET_SIZE - 4) {
      packets.push(Buffer.concat([header, payload.subarray(offset, offset + TS_PACKET_SIZE - 4)]))
      offset += TS_PACKET_SIZE - 4
    } else {
      /* 尾巴用自适应域填充：不要用 0xFF 填充载荷，否则解复用器会把它当垃圾 NAL。 */
      const pad = TS_PACKET_SIZE - 4 - remaining
      header[3] = 0x30 | ((counter + index) & 0x0f)
      const adaptation = Buffer.alloc(pad, 0xff)
      adaptation[0] = pad - 1
      if (pad > 1) adaptation[1] = 0x00
      packets.push(Buffer.concat([header, adaptation, payload.subarray(offset)]))
      offset = total
    }
    index += 1
  }
  return Buffer.concat(packets)
}

/**
 * 建一个 TS 封装器：第一次 push 前先吐 PAT/PMT，之后每帧一个 PES。
 * 连续计数器和首包标记都在内部维护；`reset()` 用于 ffmpeg 重建后从头再来。
 * @returns {{ push: (frame: Buffer, ptsUs: number) => Buffer, reset: () => void }}
 */
export function createTsMuxer() {
  let videoCounter = 0
  let psiCounter = 0
  let started = false
  const push = (frame, ptsUs) => {
    if (!Buffer.isBuffer(frame) || frame.length === 0) return Buffer.alloc(0)
    const parts = []
    if (!started) {
      started = true
      const pat = packetizeSection(PAT_PID, buildPatSection(), psiCounter)
      psiCounter = (psiCounter + Math.ceil(pat.length / TS_PACKET_SIZE)) & 0x0f
      const pmt = packetizeSection(PMT_PID, buildPmtSection(), psiCounter)
      psiCounter = (psiCounter + Math.ceil(pmt.length / TS_PACKET_SIZE)) & 0x0f
      parts.push(pat, pmt)
    }
    const pes = packetizePes(frame, ptsFromUs(ptsUs), videoCounter)
    videoCounter = (videoCounter + Math.ceil(pes.length / TS_PACKET_SIZE)) & 0x0f
    parts.push(pes)
    return parts.length === 1 ? parts[0] : Buffer.concat(parts)
  }
  const reset = () => {
    videoCounter = 0
    psiCounter = 0
    started = false
  }
  return { push, reset }
}
