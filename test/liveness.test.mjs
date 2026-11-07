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

import { LiveStream, frameLive, frameFresh, LIVE_STALE_MS } from '../stream.js'

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

check('/state 的 live 判据：最近一帧够新才算在动', () => {
  const now = 10_000_000
  const frame = Buffer.from([1])
  assert(frameLive(frame, now - 100, now) === true, '刚出的帧要算活')
  assert(frameLive(frame, now - LIVE_STALE_MS - 1, now) === false, '超过 2.5s 没新帧要算死')
  assert(frameLive(null, now - 100, now) === false, '没帧不能算活')
  assert(frameLive(frame, 0, now) === false, '没有时间戳不能算活')
  assert(frameFresh(now - 100, now) === true, 'JPEG 桥接帧新鲜也算活')
  assert(frameFresh(now - LIVE_STALE_MS - 1, now) === false, 'JPEG 桥接也按 2.5s 判死')
  assert(frameFresh(0, now) === false, '从没出过帧不能算活')
})

check('AVC 直连时没有 JPEG 子进程，也不会被 live 判死', () => {
  /* AVC 模式下 jpegState 一直是 off，但 mirror 每帧都在更新；live 只看帧的年龄。 */
  const stream = fresh()
  assert(stream.info().jpegState === 'off', 'AVC 模式 jpegState 应为 off')
  assert(frameLive(Buffer.from([1]), Date.now() - 50) === true, 'AVC 帧在动时必须报 live:true')
})

check('死掉的 JPEG 子进程会被收掉，不再被当成「还在跑」', () => {
  const stream = fresh()
  /* 模拟 exit 事件晚到：子进程已经死了，但 jpegChild 还挂着。 */
  const dead = { stdin: { end() {} }, kill() {}, exitCode: 1, signalCode: null, destroyed: false }
  stream.jpegChild = dead
  stream.jpegStartedAt = Date.now() - 30_000
  stream.jpegOpenAt = Date.now()
  assert(stream.jpegChildAlive() === false, 'exitCode 非 null 就该算死')
  const ok = stream.enableJpeg()
  assert(ok === false, '两秒节流窗口内先不重开')
  assert(stream.jpegChild === null, '死掉的子进程必须被摘掉')
  assert(stream.jpegStartedAt === 0, 'closeJpeg 要清掉起来时间')
  assert(stream.jpegOpenAt > 0, '开桥时间要留着当重建节流，不能清成 0')
})

check('还活着的 JPEG 子进程不会被误杀', () => {
  const stream = fresh()
  const live = { stdin: { end() {} }, kill() {} }
  stream.jpegChild = live
  stream.jpegOpenAt = Date.now()
  assert(stream.jpegChildAlive() === true, '没退出就该算活')
  assert(stream.enableJpeg() === true, '活着的子进程直接复用')
  assert(stream.jpegChild === live, '不能把活的重建掉')
})

console.log(`\nliveness 自检：${pass} 项通过，${fail} 项失败`)
if (fail > 0) process.exitCode = 1
