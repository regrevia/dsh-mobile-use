/**
 * 发布包自检：`npm pack` 出来的文件必须覆盖所有本地运行时依赖。
 *
 * 背景：files 白名单漏掉 tsmux.js / scrcpy.js / page.js 时，源码目录测试全绿，
 * 安装包一 import 就 ERR_MODULE_NOT_FOUND。这个用例只跑打包清单，不起设备。
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0

/** 断言一条检查结果。 @param {boolean} ok 是否通过。 @param {string} name 用例名。 @param {string} detail 失败说明。 */
function check(ok, name, detail = '') {
  if (ok) {
    pass += 1
    return
  }
  fail += 1
  console.log(`❌ ${name}${detail ? `：${detail}` : ''}`)
}

const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 })
check(packed.status === 0, 'npm pack --dry-run 能跑通', (packed.stderr || packed.stdout || '').slice(0, 200))
const manifest = packed.status === 0 ? JSON.parse(packed.stdout)[0] : { files: [] }
const files = new Set(manifest.files.map((f) => f.path))

for (const required of ['index.js', 'mirror.js', 'stream.js', 'ocr.js', 'ocr_worker.py',
  'look.js', 'client.js', 'client.rev', 'page.js', 'scrcpy.js', 'tsmux.js', 'cordis.patch.yml', 'locale/zh.json', 'vendor/u2.jar', 'vendor/scrcpy-server', 'vendor/app-uiautomator.apk']) {
  check(files.has(required), `包里含 ${required}`)
}

/* 逐个读包内 js，把 `from './x.js?v=N'` 的裸模块名解析回包内路径，缺一个就是装上去就崩。 */
const ENTRY = ['index.js', 'mirror.js', 'stream.js', 'ocr.js', 'client.js', 'page.js', 'scrcpy.js', 'tsmux.js']
for (const entry of ENTRY) {
  if (!files.has(entry)) continue
  const text = readFileSync(join(ROOT, entry), 'utf8')
  for (const match of text.matchAll(/from\s+'\.\/([^'?]+)/g)) {
    check(files.has(match[1]), `${entry} 的依赖 ${match[1]} 在包里`)
  }
}

console.log(`pack.test.mjs：${pass} 项通过，${fail} 项失败`)
if (fail > 0) process.exit(1)
