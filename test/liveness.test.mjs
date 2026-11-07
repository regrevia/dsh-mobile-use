/**
 * 回归：死掉的推流不许报活。
 *
 * 背景（2026-11-06 真机）：JPEG 桥接 EPIPE 之后 jpegChild 变 null，但旧帧与旧 error 还留在
 * 对象上，/state 一直是 live:true + err:"JPEG 管道断开：write EPIPE"，宿主却没有 ffmpeg、
 * 设备也没有 scrcpy——排查时分不清「画面在动」和「早就死了」。这里固定四件事：
 *   1. child 为 null 且带 JPEG 错误 ⇒ dead，alive=false（/state 据此不再报 live:true）；
 *   2. child 为 null 且无错误 ⇒ off，alive=false（没开，不是活着）；
 *   3. child 在、刚出过帧 ⇒ live；刚起还没帧 ⇒ starting，两者 alive=true；
 *   4. 真收到帧会把上一代的 JPEG 故障记录清掉（自愈），不留旧错。
 */

import { LiveStream } from '../stream.js'

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    pass += 1
    console.log(`  ✅ ${name}`)
  } catch (error) {
    fail += 1
    console.log(`  ❌ ${name}: ${error?.message ?? error}`)
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}
function fresh() {
  return new LiveStream({ serial: 'liveness-test', adb: '/nonexistent/adb' })
}
/* 假的 ffmpeg 子进程：只让 closeJpeg 能安全地 end/kill。 */
function fakeChild() {
  return { stdin: { end() {} }, kill() {} }
}

console.log('=== 推流存活判定 ===')

check('管道断了：dead，alive=false，保留错误原因', () => {
  const stream = fresh()
  stream.error = 'JPEG 管道断开：write EPIPE'
  const info = stream.info()
  assert(info.jpegState === 'dead', `应判 dead，实际 ${info.jpegState}`)
  assert(info.alive === false, '死流不能报 alive=true')
  assert(info.error.includes('EPIPE'), '故障原因要留着')
  assert(info.jpegLive === false, 'jpegLive 保持原义')
})

check('没开：off，alive=false', () => {
  const info = fresh().info()
  assert(info.jpegState === 'off', `应判 off，实际 ${info.jpegState}`)
  assert(info.alive === false, '没开不能报 alive=true')
})

check('在出帧：live，alive=true', () => {
  const stream = fresh()
  stream.jpegChild = fakeChild()
  stream.jpegStartedAt = Date.now()
  stream.jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  stream.jpegAt = Date.now()
  const info = stream.info()
  assert(info.jpegState === 'live', `应判 live，实际 ${info.jpegState}`)
  assert(info.alive === true, '在出帧要报 alive=true')
})

check('刚起还没帧：starting，alive=true（不能一上来就判死）', () => {
  const stream = fresh()
  stream.jpegChild = fakeChild()
  stream.jpegStartedAt = Date.now()
  const info = stream.info()
  assert(info.jpegState === 'starting', `应判 starting，实际 ${info.jpegState}`)
  assert(info.alive === true, '启动窗口内要算活')
})

check('起了但一直没帧超时：stalled，alive=false', () => {
  const stream = fresh()
  stream.jpegChild = fakeChild()
  stream.jpegStartedAt = Date.now() - 60_000
  const info = stream.info()
  assert(info.jpegState === 'stalled', `应判 stalled，实际 ${info.jpegState}`)
  assert(info.alive === false, '卡死不算活')
})

check('真收到帧会清掉上一代的 JPEG 故障（自愈）', () => {
  const stream = fresh()
  stream.error = 'JPEG 桥接退出码 1'
  stream.feedJpeg(Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]))
  assert(stream.error === '', `旧故障应被清掉，实际 ${stream.error}`)
  assert(stream.jpegSeq === 1, '应该切出 1 帧')
})

check('不碰别的故障：设备错误不会被当成 JPEG 故障清掉', () => {
  const stream = fresh()
  stream.error = 'adb: device offline'
  stream.feedJpeg(Buffer.from([0xff, 0xd8, 0x02, 0xff, 0xd9]))
  assert(stream.error === 'adb: device offline', '非 JPEG 故障必须保留')
})

check('closeJpeg 之后立刻是 off/dead，不再假装在线', () => {
  const stream = fresh()
  stream.jpegChild = fakeChild()
  stream.jpegStartedAt = Date.now()
  stream.jpegAt = Date.now()
  stream.closeJpeg()
  const info = stream.info()
  assert(info.jpegLive === false, 'closeJpeg 之后 jpegLive 应为 false')
  assert(info.alive === false, 'closeJpeg 之后不能报 alive=true')
})

console.log(`\nliveness 自检：${pass} 项通过，${fail} 项失败`)
if (fail > 0) process.exitCode = 1
