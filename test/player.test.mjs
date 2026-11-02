/**
 * 播放页静态体检：PLAYER_HTML 是一段模板字符串里的 HTML+脚本，
 * 模板里写正则时 `\d` 会被吞成 `d`（线上表现为参数解析悄悄失效，页面不报错），
 * 这类错误只能靠编译一次内联脚本来拦。
 */
import assert from 'node:assert/strict'
import { PLAYER_HTML } from '../page.js'

let pass = 0
const failures = []

async function it(label, body) {
  try {
    await body()
    pass += 1
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failures.push({ label, error })
    console.log(`  ❌ ${label}`)
    console.log(`     ${String(error?.message ?? error).split('\n').join('\n     ')}`)
  }
}

const match = /<script>([\s\S]*?)<\/script>/.exec(PLAYER_HTML)

await it('播放页有内联脚本', () => {
  assert.ok(match !== null, 'PLAYER_HTML 里找不到 <script> 块')
})

await it('内联脚本能编译', () => {
  assert.ok(match !== null)
  new Function(match[1])
})

await it('模板字符串没有吞掉反斜杠转义', () => {
  assert.ok(!/\\[a-zA-Z]/.test(PLAYER_HTML), 'PLAYER_HTML 里出现 \\d 一类被吞的转义')
})

await it('avc 参数解析认 0/1/缺省', () => {
  const body = match?.[1] ?? ''
  const at = body.indexOf('var avcPref = (function () {')
  const end = body.indexOf('})()', at)
  assert.ok(at >= 0 && end > at, '找不到 avcPref 解析块')
  const snippet = body.slice(at, end + 4)
  const penv = new Function('window', snippet + '; return avcPref')
  const pick = (search) => penv({ location: { search } })
  assert.equal(pick('?serial=x'), 'auto', '不写 avc 时应为 auto')
  assert.equal(pick('?serial=x&avc=0'), 'off', 'avc=0 应关掉裸流')
  assert.equal(pick('?serial=x&avc=1'), 'on', 'avc=1 应强制裸流')
})

if (failures.length > 0) {
  console.log(`\n播放页体检失败 ${failures.length} 项`)
  process.exitCode = 1
} else {
  console.log(`\n播放页体检通过 ${pass} 项`)
}
