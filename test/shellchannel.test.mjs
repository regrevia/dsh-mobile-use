/**
 * 回归：常驻 shell 不能被单条大输出打死。
 *
 * 背景：原来是 `execFile(adb … shell)`，Node 会给它攒一份内部 stdout 缓冲
 * （默认上限 1 MiB），到达上限就把子进程判死。我们自己已经有 MAX_SHELL_BUF
 * 截尾，不需要第二份；这条测试用一个假 adb 打超过 1 MiB，再确认同一个通道
 * 还能跑下一条命令。用 spawn 之前这条会失败。
 */

import { writeFileSync, chmodSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'dsh-shell-'))
const fakeAdb = join(dir, 'adb')
writeFileSync(fakeAdb, '#!/bin/sh\nexec /bin/sh\n')
chmodSync(fakeAdb, 0o755)
process.env.ADB = fakeAdb

const { __internals } = await import('../index.js')
const { shellOnce, killShell } = __internals

let pass = 0
let fail = 0
async function check(name, fn) {
  try {
    await fn()
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

console.log('=== 常驻 shell 通道 ===')

await check('单条 2 MiB 输出之后通道仍然可用', async () => {
  const big = await shellOnce('fake', "head -c 2097152 /dev/zero | tr '\\0' a", 30_000)
  assert(big.ok === true, `大输出命令应该成功，实际 code=${big.code}`)
  assert(big.out.length >= 2_000_000, `输出应不少于 2 MB，实际 ${big.out.length}`)
  const next = await shellOnce('fake', 'printf hello', 10_000)
  assert(next.ok === true, `后续命令应该成功，实际 code=${next.code}`)
  assert(next.out.includes('hello'), `后续命令输出丢了：${next.out.slice(0, 80)}`)
})

await check('多设备常驻 shell 合计不超全局预算', async () => {
  const { shellBufStats } = __internals
  killShell('fake')
  const serials = ['qa1', 'qa2', 'qa3', 'qa4']
  let peak = 0
  const poll = setInterval(() => {
    const stats = shellBufStats()
    if (stats.bytes > peak) peak = stats.bytes
  }, 10)
  const results = await Promise.all(
    serials.map((serial) => shellOnce(serial, "head -c 8388608 /dev/zero | tr '\\0' a", 90_000)),
  )
  clearInterval(poll)
  for (const [index, result] of results.entries()) {
    assert(result.ok === true, `${serials[index]} 大输出应成功，实际 code=${result.code}`)
  }
  assert(peak > 0, '并发写的时候合计不该是 0')
  assert(peak <= shellBufStats().cap, `并发峰值 ${peak} 应 ≤ 上限 ${shellBufStats().cap}`)
  const echo = await shellOnce('qa4', 'printf hi', 10_000)
  assert(echo.ok === true, `被挤之后通道仍应可用，实际 code=${echo.code}`)
  assert(echo.out.includes('hi'), `被挤之后输出丢了：${echo.out.slice(0, 40)}`)
  /* 每条命令读完就清自己的缓冲，所以跑完合计应该归零；漏清就会一直涨。 */
  assert(shellBufStats().bytes === 0, `命令跑完合计应归零，实际 ${shellBufStats().bytes}`)
  for (const serial of serials) killShell(serial)
  const after = shellBufStats()
  assert(after.channels === 0, `killShell 后不应残留通道：${after.channels}`)
  assert(after.bytes === 0, `killShell 后预算应归零：${after.bytes}`)
})

await check('超时返回不确定而不是硬失败', async () => {
  const slow = await shellOnce('fake', 'sleep 5', 300)
  assert(slow.ok === false, '应该失败')
  assert(slow.code === null, `超时应该 code=null，实际 ${slow.code}`)
  assert(slow.uncertain === true, '超时应该标记 uncertain（设备可能已经执行）')
  killShell('fake')
})

killShell('fake')
console.log(`shellchannel.test.mjs：${pass} 项通过，${fail} 项失败`)
process.exit(fail > 0 ? 1 : 0)
