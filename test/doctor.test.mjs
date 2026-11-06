/**
 * doctor.mjs 的判据测试：issue #1 那种「profile 里启用了但工具不出现」的
 * 几种静默失败，自检必须点名，而不是回一句「看起来没问题」。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { inspectProfile } from '../doctor.mjs'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${detail === '' ? '' : `：${detail}`}`) }
}

const root = mkdtempSync(join(tmpdir(), 'dsh-doctor-'))
const make = (name, pkg, extra = () => {}) => {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  if (pkg !== null) writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  extra(dir)
  return dir
}
const byId = (report, id) => report.checks.find((entry) => entry.id === id)
const opts = { logDir: join(root, 'logs'), adb: '/nonexistent/adb', lockFile: join(root, 'host.lock') }

/* 1. 根本没有 profile */
const none = inspectProfile(join(root, 'nowhere'), opts)
check('没有 profile 时判 fail', none.verdict === 'fail' && byId(none, 'profile').ok === false)
check('没有 profile 时给 --profile 提示', String(byId(none, 'profile').fix).includes('--profile'))

/* 2. 装进 dependencies 但没进 bundles —— issue #1 的核心场景 */
const changed = make('changed', {
  name: 'dsh-profile-x',
  dependencies: { 'dsh-mobile-use': 'link:/Users/apple/Desktop/odd/dsh-mobile-use' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  extra: undefined,
})
const report2 = inspectProfile(changed, opts)
check('依赖有、bundles 没有时判 fail', report2.verdict === 'fail')
const bundleCheck = byId(report2, 'bundle')
check('指出 patch 会落空', bundleCheck.ok === false && bundleCheck.detail.includes('cordis.patch.yml'))
check('给出加进 bundles 的修法', String(bundleCheck.fix).includes('dsh.profile.bundles'))

/* 3. 完全没装 */
const empty = make('empty', { name: 'dsh-profile-y', dsh: { profile: { bundles: [] } } })
check('没装时指出 dependencies 缺项', byId(inspectProfile(empty, opts), 'installed').ok === false)

/* 4. 配置齐了：deps + bundles + node_modules 入口 + 包里 patch */
const good = make('good', {
  name: 'dsh-profile-z',
  dependencies: { 'dsh-mobile-use': 'link:/src' },
  dsh: { profile: { bundles: ['dsh-mobile-use'] } },
})
mkdirSync(join(good, 'node_modules', 'dsh-mobile-use'), { recursive: true })
writeFileSync(join(good, 'node_modules', 'dsh-mobile-use', 'package.json'), JSON.stringify({ name: 'dsh-mobile-use', version: '1.4.36', main: 'index.js' }))
writeFileSync(join(good, 'node_modules', 'dsh-mobile-use', 'index.js'), 'export const apply = () => {}\n')
writeFileSync(join(good, 'node_modules', 'dsh-mobile-use', 'cordis.patch.yml'), '- insert:\n    - id: adb\n      name: dsh-mobile-use\n')
const report4 = inspectProfile(good, opts)
check('配齐后判 pass（adb 缺席只算可选）', report4.verdict === 'pass', JSON.stringify(report4.checks.filter((c) => !c.ok)))
check('入口版本可读', byId(report4, 'entry').detail.includes('1.4.36'))
check('adb 缺失只标可选', byId(report4, 'adb').optional === true && byId(report4, 'adb').ok === false)

/* 5. bundles 里有、但 node_modules 断链（link: 的常见翻车） */
const broken = make('broken', {
  name: 'dsh-profile-w',
  dependencies: { 'dsh-mobile-use': 'link:/src' },
  dsh: { profile: { bundles: ['dsh-mobile-use'] } },
})
const report5 = inspectProfile(broken, opts)
check('断链时判 fail 且指向重装', report5.verdict === 'fail' && byId(report5, 'entry').ok === false && String(byId(report5, 'entry').fix).includes('install_bundle'))

/* 6. 加载锁：pid 活着 = 此刻确实被宿主加载了；退出的 pid = 上次退出留下 */
writeFileSync(join(root, 'host.lock'), `${process.pid}\n`)
check('宿主 pid 活着时判已加载', byId(inspectProfile(good, opts), 'loaded').ok === true)
writeFileSync(join(root, 'host.lock'), '999999\n')
const deadLock = byId(inspectProfile(good, opts), 'loaded')
check('宿主 pid 不在了时点明是残留锁', deadLock.ok === false && deadLock.detail.includes('999999') && deadLock.detail.includes('不在了'))
rmSync(join(root, 'host.lock'), { force: true })
check('没有锁文件时说明从没加载过', byId(inspectProfile(good, opts), 'loaded').detail.includes('从没成功加载'))

/* 7. --json 形态：结构稳定，含 verdict 与 checks */
check('report 结构有 dir/checks/verdict', typeof report4.dir === 'string' && Array.isArray(report4.checks) && typeof report4.verdict === 'string')

rmSync(root, { recursive: true, force: true })
console.log(`doctor 自检：${pass} 项通过，${fail} 项失败`)
if (fail > 0) process.exitCode = 1
