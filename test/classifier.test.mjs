/**
 * 重试分类器测试：写命令绝不能自动重放。
 * 从 index.js 里切出这段纯函数单独跑，不改动插件、不连设备。
 */
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const start = source.indexOf('/** 只读命令的首词')
const end = source.indexOf(' * 失败结果的给用户看的说法')
if (start < 0 || end < 0) {
  console.error('❌ 找不到 isWriteCommand 所在片段（index.js 结构变了，需要同步改测试）')
  process.exit(1)
}
const raw = source.slice(start, end)
/* 切片按关键字定位，尾部会带上一个没闭合的注释头：先截掉最后一个 `/*`，再清掉完整注释块。 */
const tail = raw.lastIndexOf('/*')
const chunk = (tail > 0 ? raw.slice(0, tail) : raw).replace(/\/\*\*[\s\S]*?\*\//g, '')
let isWriteCommand
try {
  isWriteCommand = new Function(`${chunk}\nreturn isWriteCommand`)()
} catch (error) {
  console.error(`❌ 分类器片段无法求值：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

let failed = 0
const check = (cmd, want) => {
  const got = isWriteCommand(cmd)
  if (got !== want) {
    failed += 1
    console.error(`❌ ${JSON.stringify(cmd)} → ${got ? '写' : '只读'}，期望 ${want ? '写' : '只读'}`)
  }
}

/* 只读：失败可以直接重跑。 */
check('cat /proc/net/unix', false)
check('dumpsys activity top', false)
check('getprop ro.product.model', false)
check('wm size', false)
check('logcat -d -t 50', false)
check('ps -A | grep screenrecord', false)
check('date', false)
check('echo hello', false)

/* 写：超时后可能已经生效，重放会重复操作。 */
check('input tap 500 800', true)
check('echo changed > /sdcard/dsh/probe.txt', true)
check('cat /sdcard/a > /sdcard/b', true)
check('logcat -c', true)
check('logcat -b all -c', true)
check('wm size 720x1280', true)
check('wm density 320', true)
check('date -s 202601011200', true)
check('find /sdcard/Download -name "*.log" -delete', true)
check('sed -i s/a/b/ /sdcard/x', true)
check('rm -rf /sdcard/dsh', true)
check('su -c "input keyevent 3"', true)
check('sh -c "pm clear com.android.settings"', true)
check('unknown-tool --flag', true)
check('cat /sdcard/x 2>&1', false)

if (failed > 0) {
  console.error(`=== ${failed} 条不符合预期 ===`)
  process.exit(1)
}
console.log('=== 全部通过 ===')
