/**
 * 定时器兜底扫描：宿主不隔离插件异常，定时器回调里任何一个 TypeError 都会冒到顶层，
 * 整个 DSH 以 1 退出（2026-10-27 `this.killStale` 两次事故就是空闲回收定时器 → stop()）。
 * 规则：host 侧所有节拍器/回收定时器的回调都要经过 guard()，单拍出错只记日志。
 */
import { readFileSync } from 'node:fs'

/** 以 this 成员形式挂出去的定时器（节拍器与空闲/续录回收）。 */
const PATTERN = /this\.(timer|pushTimer|idleTimer|restartTimer)\s*=\s*(?:setInterval|setTimeout)\(/g

/** 从注册点往后看多远算「同一个回调」。 */
const WINDOW = 160

/** 找出没走 guard 的定时器注册。 @param {string} source - 文件源码。 @returns {string[]} 违规点。 */
function unguarded(source) {
  const bad = []
  for (const m of source.matchAll(PATTERN)) {
    const tail = source.slice(m.index, m.index + WINDOW)
    if (!tail.includes('guard(')) bad.push(source.slice(m.index, m.index + 60).split('\n')[0])
  }
  return bad
}

let failures = 0
const it = (label, run) => {
  try {
    run()
    console.log(`  ✅ ${label}`)
  } catch (error) {
    failures += 1
    console.log(`  ❌ ${label}\n     ${String(error?.message ?? error)}`)
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

for (const file of ['stream.js', 'mirror.js']) {
  it(`${file}：定时器回调都经过 guard`, () => {
    const bad = unguarded(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))
    assert(bad.length === 0, `未兜底的定时器：${bad.join(' | ')}`)
  })
}

it('自检：没兜底的定时器会被抓出来', () => {
  const fake = 'this.idleTimer = setTimeout(() => { this.stop() }, 20000)'
  assert(unguarded(fake).length === 1, '扫描放过了一个裸定时器')
})

it('自检：兜底后的定时器不误报', () => {
  const fake = "this.idleTimer = setTimeout(() => guard('idle-stop', () => { this.stop() }), 20000)"
  assert(unguarded(fake).length === 0, '兜底写法被误判')
})

if (failures > 0) {
  console.log(`=== ${failures} 项失败 ===`)
  process.exitCode = 1
} else {
  console.log('=== 全部通过 ===')
}
