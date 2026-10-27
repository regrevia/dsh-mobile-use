/**
 * 悬空 this 调用扫描：rename 后残留 `this.oldName()` 会让插件在回调里抛 TypeError，
 * 而宿主不隔离插件异常 —— 一次空转定时器就能打死整个 DSH（2026-10-27 的 killStale 事故）。
 * 只做一件事：文件里每个 `this.foo(` 都要能找到定义（方法简写或 this.foo = 赋值）。
 */
import { readFileSync } from 'node:fs'

const FILES = ['stream.js', 'mirror.js', 'index.js', 'client.js']

/** 从源码里收集「哪些名字在这份文件里是可调用的 this 成员」。 */
function knownMembers(source) {
  const names = new Set()
  /* this.foo = ... 的赋值（含 this.foo = function / 箭头函数）。 */
  for (const m of source.matchAll(/this\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) names.add(m[1])
  /* 方法简写 / 类字段箭头函数：行首缩进后的 `foo(...) {` 或 `foo = (...) =>`。 */
  for (const m of source.matchAll(/^\s{2,}(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) names.add(m[1])
  for (const m of source.matchAll(/^\s{2,}([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/gm)) names.add(m[1])
  /* 对象字面量里的方法（route 表这类）也给过。 */
  for (const m of source.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function|\()/g)) names.add(m[1])
  return names
}

/** 常见内置/外部注入成员，不要求在文件内定义。 */
const BUILTIN = new Set([
  'constructor', 'then', 'catch', 'finally', 'apply', 'call', 'bind', 'toString', 'valueOf',
  'hasOwnProperty', 'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'map', 'filter',
  'forEach', 'find', 'findIndex', 'some', 'every', 'reduce', 'join', 'split', 'trim',
  'replace', 'includes', 'startsWith', 'endsWith', 'padStart', 'padEnd', 'toFixed',
  'getTime', 'toISOString', 'keys', 'values', 'entries', 'set', 'get', 'delete', 'has',
  'clear', 'add', 'size', 'length', 'emit', 'on', 'once', 'off', 'removeListener', 'end',
  'write', 'pipe', 'read', 'kill', 'ref', 'unref', 'stdin', 'stdout', 'stderr',
])

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

for (const file of FILES) {
  it(`${file}：this.* 调用都有定义`, () => {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    const known = knownMembers(source)
    const dangling = new Set()
    for (const m of source.matchAll(/this\.([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[1]
      if (known.has(name) || BUILTIN.has(name)) continue
      dangling.add(name)
    }
    assert(dangling.size === 0, `悬空调用：${[...dangling].join(', ')}（改名后残留会让插件回调抛 TypeError，host 直接退出）`)
  })
}

/* 自检：故意造一份带残留调用的源码，确认扫描器抓得到，别写成永远绿的摆设。 */
it('扫描器能抓到悬空调用（自检）', () => {
  const broken = 'class A {\n  killOwn() {}\n  stop() {\n    if (this.n > 0) this.killStale()\n  }\n}\n'
  const known = knownMembers(broken)
  const dangling = [...broken.matchAll(/this\.([A-Za-z_$][\w$]*)\s*\(/g)]
    .map((m) => m[1])
    .filter((name) => !known.has(name) && !BUILTIN.has(name))
  assert(dangling.includes('killStale'), '扫描器没抓到 killStale，说明这个测试本身失效了')
})

console.log(failures === 0 ? `\n=== 全部通过 ===` : `\n=== ${failures} 项失败 ===`)
process.exitCode = failures === 0 ? 0 : 1
