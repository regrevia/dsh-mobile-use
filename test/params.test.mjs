/* 静态守卫：每个工具声明在 parameters 里的参数都必须被 execute 读过。
   声明了却没人读 = 模型照文档传了，行为静默不变，最难查的那类不一致。 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = fs.readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf8')
let pass = 0
let fail = 0
const it = (label, run) => {
  try { run(); pass++; console.log(`  ✅ ${label}`) } catch (error) { fail++; console.log(`  ❌ ${label}\n     ${error.message}`) }
}

const tools = [...src.matchAll(/name: '(adb_[a-z_]+)'/g)].map((m) => ({ name: m[1], at: m.index }))

function declaredParams(segment) {
  const pAt = segment.indexOf('parameters: {')
  if (pAt < 0) return []
  const start = segment.indexOf('properties: {', pAt)
  if (start < 0) return []
  const open = segment.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let j = open; j < segment.length; j++) {
    if (segment[j] === '{') depth++
    else if (segment[j] === '}') { depth--; if (depth === 0) { end = j; break } }
  }
  if (end < 0) return []
  const body = segment.slice(open, end)
  const keys = []
  let d = 0
  for (const line of body.split('\n')) {
    const m = /^ {8}([a-z_]+): \{/.exec(line)
    if (m && d === 1) keys.push(m[1])
    for (const ch of line) { if (ch === '{') d++; else if (ch === '}') d-- }
  }
  return keys
}

it('每个工具声明的参数都被读过（没有静默失效的开关）', () => {
  const dead = []
  for (let i = 0; i < tools.length; i++) {
    const segment = src.slice(tools[i].at, tools[i + 1]?.at ?? src.length)
    const unused = declaredParams(segment).filter((key) => key !== 'serial' && !new RegExp(`args\\.${key}\\b`).test(segment))
    if (unused.length > 0) dead.push(`${tools[i].name}: ${unused.join(', ')}`)
  }
  if (dead.length > 0) throw new Error(`声明了却没人读：\n     ${dead.join('\n     ')}`)
  if (tools.length < 20) throw new Error(`只认出 ${tools.length} 个工具，解析多半坏了`)
})

console.log(`\n${pass} 项通过`)
if (fail > 0) process.exit(1)
