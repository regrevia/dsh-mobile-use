#!/usr/bin/env node
/**
 * dsh-mobile-use 自检：工具不出现在会话里时，先跑这个。
 *
 *   node doctor.mjs            # 查默认 profile
 *   npx dsh-mobile-use-doctor   # 跑 npm 包里的同一份
 *   node doctor.mjs --json     # 机器可读
 *   node doctor.mjs --profile /path/to/profile
 *
 * 为什么需要它：插件在 DSH 里是以 bundle 形式插入的（package.json 的
 * dsh.profile.bundles + 本包的 cordis.patch.yml）。只把包写进 dependencies、
 * 或者只在 profile 的 cordis.patch.yml 里写 `- id: adb`，patch 会落在一个
 * 不存在的行上，Loader 静默跳过——启动日志里一个字都没有。这个脚本把这几
 * 种「静默不加载」直接指出来，并给出该跑的命令。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_NAME = 'dsh-mobile-use'
const PLUGIN_ID = 'adb'

const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}
const readText = (file) => {
  try { return readFileSync(file, 'utf8') } catch { return '' }
}

/** 从 profile 的 package.json 判断「装没装 / 会不会被 Loader 当成 bundle」 */
export function inspectProfile(profileDir, options = {}) {
  const dir = resolve(profileDir)
  const checks = []
  const pkgFile = join(dir, 'package.json')
  const pkg = readJson(pkgFile)
  if (pkg === null) {
    checks.push({ id: 'profile', ok: false, detail: `找不到 profile：${pkgFile}`, fix: '用 --profile 指定 DSH profile 目录（通常是 ~/.dsh/profiles/<名字>）' })
    return { dir, checks, verdict: 'fail' }
  }
  checks.push({ id: 'profile', ok: true, detail: dir })

  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const spec = deps[PKG_NAME]
  checks.push(spec === undefined
    ? { id: 'installed', ok: false, detail: `profile 的 dependencies 里没有 ${PKG_NAME}`, fix: `在 DSH 里 plugin_manager action=install_bundle target=${HERE}` }
    : { id: 'installed', ok: true, detail: spec })

  const bundles = pkg?.dsh?.profile?.bundles
  const inBundles = Array.isArray(bundles) && bundles.includes(PKG_NAME)
  checks.push(inBundles
    ? { id: 'bundle', ok: true, detail: '已在 dsh.profile.bundles 里' }
    : { id: 'bundle', ok: false, detail: '不在 dsh.profile.bundles 里：本包的 cordis.patch.yml 不会被应用，profile 的 patch 里写 - id: adb 也落空', fix: `把 "${PKG_NAME}" 加进 package.json 的 dsh.profile.bundles（或重跑 plugin_manager install_bundle）` })

  // 真加载的是 node_modules 里那一份，不是眼前这个源码目录
  const installedDir = join(dir, 'node_modules', PKG_NAME)
  const installedPkg = readJson(join(installedDir, 'package.json'))
  const entry = installedPkg === null ? '' : join(installedDir, String(installedPkg.main ?? 'index.js'))
  const entryOk = entry !== '' && existsSync(entry)
  checks.push(entryOk
    ? { id: 'entry', ok: true, detail: `${installedPkg.version ?? '?'} → ${entry}` }
    : { id: 'entry', ok: false, detail: 'node_modules 里解析不到入口文件（link: 断链或没装）', fix: `重新安装：plugin_manager action=install_bundle target=${HERE}` })

  const ownPatch = readText(join(installedDir, 'cordis.patch.yml'))
  const declaresId = ownPatch.includes(`id: ${PLUGIN_ID}`)
  checks.push(declaresId
    ? { id: 'patch', ok: true, detail: `bundle patch 里有 insert: ${PLUGIN_ID}` }
    : { id: 'patch', ok: false, detail: `包里的 cordis.patch.yml 没有 insert id: ${PLUGIN_ID}`, fix: '包不完整，重装一次' })

  /* 插件加载时会在 /tmp 写下宿主 pid 的锁文件：它存在且 pid 还活着，就是
     「这个插件此刻确实被某个宿主加载了」最硬的证据，比翻启动日志准。 */
  const lockFile = options.lockFile ?? '/tmp/dsh-mobile-use-host.lock'
  let loadedPid = 0
  let loaded = false
  try {
    loadedPid = Number.parseInt(readText(lockFile).trim(), 10)
    if (Number.isInteger(loadedPid) && loadedPid > 0) {
      try { process.kill(loadedPid, 0); loaded = true } catch { /* 宿主已经退了 */ }
    }
  } catch { /* 没锁文件就是没加载过 */ }
  checks.push({ id: 'loaded', ok: loaded, optional: true,
    detail: loaded ? `宿主 pid ${loadedPid} 里已加载` : loadedPid > 0 ? `锁文件里的宿主 pid ${loadedPid} 已经不在了（上次崩溃/退出留下的）` : '没有加载锁文件：这个 profile 从没成功加载过插件',
  })

  // 启动日志是最省事的「到底加载没有」证据
  const logs = []
  const logDir = options.logDir ?? join(homedir(), '.dsh', 'logs')
  try {
    logs.push(...readdirSync(logDir)
      .filter((name) => name.startsWith('startup-') && name.endsWith('.log'))
      .map((name) => ({ name, at: statSync(join(logDir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .slice(0, 3))
  } catch { /* 没有日志目录就跳过检查 */ }
  let logHit = null
  for (const log of logs) {
    const text = readText(join(logDir, log.name))
    if (text.includes(`[${PKG_NAME}]`) || text.includes('include:adb') || text.includes(`[${PLUGIN_ID}]`)) { logHit = log.name; break }
  }
  checks.push({ id: 'startup-log', ok: logHit !== null, detail: logHit ?? (logs.length === 0 ? '没有 startup 日志（可选检查）' : `最近 3 份 startup 日志里没有 ${PKG_NAME} 加载记录`), optional: true })

  const adbPath = options.adb ?? '/opt/homebrew/bin/adb'
  let adbOk = false
  let devices = 0
  try {
    const out = execFileSync(adbPath, ['devices'], { encoding: 'utf8', timeout: 8000 })
    devices = out.split('\n').filter((line) => /\tdevice$/.test(line.trim())).length
    adbOk = true
  } catch { /* adb 不在 PATH 也是常见情况 */ }
  checks.push({ id: 'adb', ok: adbOk, detail: adbOk ? `${adbPath} · ${devices} 台设备在线` : `跑不了 ${adbPath}`, optional: true, fix: adbOk ? '' : '宿主要能跑 adb，或在插件 config 里写绝对路径 adb:' })

  const blocking = checks.filter((check) => check.ok === false && check.optional !== true)
  return { dir, checks, verdict: blocking.length === 0 ? 'pass' : 'fail' }
}

const parseArgs = (argv) => {
  const out = { profile: '', json: false, adb: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') out.json = true
    else if (arg === '--profile') out.profile = argv[++i] ?? ''
    else if (arg === '--adb') out.adb = argv[++i] ?? ''
  }
  return out
}

/** 默认 profile：DSH_PROFILE 指定，否则找 ~/.dsh/profiles 里最近改过的那个 */
export function defaultProfile() {
  const named = process.env.DSH_PROFILE
  if (named) return join(homedir(), '.dsh', 'profiles', named)
  const root = join(homedir(), '.dsh', 'profiles')
  try {
    const best = readdirSync(root)
      .map((name) => ({ name, at: statSync(join(root, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)[0]
    if (best !== undefined) return join(root, best.name)
  } catch { /* 没装过 profile */ }
  return join(root, 'desktop')
}

const run = () => {
  const args = parseArgs(process.argv.slice(2))
  const report = inspectProfile(args.profile === '' ? defaultProfile() : args.profile, { adb: args.adb === '' ? undefined : args.adb })
  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    process.exitCode = report.verdict === 'pass' ? 0 : 1
    return
  }
  console.log(`profile：${report.dir}`)
  for (const check of report.checks) {
    const mark = check.ok ? '✓' : check.optional === true ? '!' : '✗'
    console.log(`  ${mark} ${check.id.padEnd(12)} ${check.detail}`)
    if (check.ok === false && check.fix !== undefined) console.log(`      → ${check.fix}`)
  }
  console.log(report.verdict === 'pass'
    ? '\n结论：配置没问题。工具还是不出现，就重启一次 DSH 宿主（改 package.json 需要整个进程重载），再看 plugin_manager list_plugins 里 include:adb 是否 active。'
    : '\n结论：按上面的 → 改完再跑一次。改完 package.json 必须重启 DSH 宿主，只重开会话不够。')
  process.exitCode = report.verdict === 'pass' ? 0 : 1
}

const invokedDirectly = (() => {
  try { return resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url)) } catch { return false }
})()
if (invokedDirectly) run()
