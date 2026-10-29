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
