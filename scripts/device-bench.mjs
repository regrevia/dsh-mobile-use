/**
 * 真机基线：不开宿主也能量出设备侧原语的开销，用来对比每次改动的快慢。
 * 默认只做读操作（dump / 读前台 / 等文字 / 滚动找字）；加 --write 才点屏。
 *   node scripts/device-bench.mjs [--serial 15ca9736] [--n 5] [--write]
 */
import { __internals } from '../index.js'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const times = Math.max(1, Math.min(20, Number(arg('n', 5)) || 5))
const write = argv.includes('--write')
const { resolveSerial, dumpState, foregroundActivity, waitFor, scrollToText, screenSize, selectNodes } = __internals
/* 内部原语都按序列号直连 `adb -s`：不传就自己选一台，跟宿主的选择规则一致。 */
const serial = await resolveSerial({ serial: arg('serial', process.env.ADB_SERIAL ?? '') })

const rows = []
const time = async (name, run) => {
  const began = performance.now()
  const value = await run()
  rows.push({ name, ms: Math.round(performance.now() - began), note: String(value ?? '').slice(0, 40) })
  return value
}

const sizes = await screenSize(serial)
await time('screenSize 缓存读', () => screenSize(serial).then((box) => `${box.width}x${box.height}`))
for (let index = 0; index < times; index += 1) {
  await time(`dumpState #${index + 1}`, async () => {
    const state = await dumpState(serial, { ocr: 'off' })
    return `${state.tree.kept}/${state.nodes.length} 节点 · ${state.activity}`
  })
}
for (let index = 0; index < Math.min(times, 3); index += 1) {
  await time(`foregroundActivity #${index + 1}`, () => foregroundActivity(serial))
}
const state = await dumpState(serial, { ocr: 'off' })
const sample = selectNodes(state, { clickable: true })[0] ?? state.nodes.find((node) => node.text)
if (sample && write) {
  await time('waitFor 已存在的文字', () => waitFor(serial, { text: (sample.text || sample.desc).slice(0, 4) }, 3000).then((r) => `${r.matched} ${r.elapsedMs}ms`))
}
await time('waitFor 等不到的文字', () => waitFor(serial, { text: '这段文字一定不存在dsh' }, 600).then((r) => `${r.matched} ${r.elapsedMs}ms`))
if (write) {
  await time('scrollToText 找当前屏的文字', () => scrollToText(serial, (sample?.text ?? '设置').slice(0, 3), 'up').then((node) => (node ? '找到' : '没找到')))
}
console.log(`设备 ${serial || '(默认)'} · 屏幕 ${sizes.width}x${sizes.height} · ${write ? '含写操作' : '只读'}`)
for (const row of rows) console.log(`${String(row.ms).padStart(5)}ms  ${row.name.padEnd(24, ' ')} ${row.note}`)
const dumpRows = rows.filter((row) => row.name.startsWith('dumpState')).map((row) => row.ms)
if (dumpRows.length > 0) {
  const avg = Math.round(dumpRows.reduce((sum, ms) => sum + ms, 0) / dumpRows.length)
  console.log(`dump 均值 ${avg}ms（${dumpRows.join('/')}）`)
}
