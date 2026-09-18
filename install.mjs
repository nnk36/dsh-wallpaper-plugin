#!/usr/bin/env node
// ============================================================================
// dsh-wallpaper 安装器（跨平台：Windows / macOS / Linux）
// ============================================================================
//   node install.mjs                       # 装进 $DSH_HOME(默认 ~/.dsh)/profiles/web
//   node install.mjs --profile myprofile   # 指定 profile
//   node install.mjs --home /path/to/.dsh  # 指定 DSH_HOME
//   node install.mjs --dir /path/to/keep   # 指定包被复制到的位置
//
// 为什么是 node 而不是 shell 脚本：
//   * Windows 没有 bash；`ln -s` 需要管理员或开发者模式（这里用 junction 代替，
//     和 npm/pnpm 在 Windows 上的做法一致，不需要任何特权）
//   * 安卓 /sdcard 之类不保存可执行位，`node install.mjs` 只要有 node 就能跑
//
// 做的事和 install.sh 完全一致：
//   1. 把包复制到一个不会被删的位置
//   2. 装依赖：优先 `dsh plugin --profile <p> add link:<目录>`（pnpm 自己维护
//      lockfile 与链接）；不可用时自己建链接
//   3. 往 profile 的 package.json 写 dependencies 和 dsh.profile.bundles
//
// 第 3 步是关键：`dsh plugin` 只是把参数转发给 profile 目录里的 pnpm，它只装依赖，
// 不会写 bundles；而 DSH 启动时只按 dsh.profile.bundles 叠加各 bundle 的补丁，
// 没有任何"装了依赖就自动生效"的发现机制。漏掉这一步，装完什么都不会发生。
// ============================================================================

import { spawnSync } from 'node:child_process'
import {
  cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = 'dsh-wallpaper'
const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, NAME)
const IS_WINDOWS = process.platform === 'win32'

function usage() {
  console.log([
    'dsh-wallpaper 安装器（跨平台）',
    '',
    '  node install.mjs                       装进 $DSH_HOME(默认 ~/.dsh)/profiles/web',
    '  node install.mjs --profile <名字>      指定 profile',
    '  node install.mjs --home <DSH_HOME>     指定 DSH 主目录',
    '  node install.mjs --dir <目录>          指定包被复制到的位置',
    '',
    '做的事：复制包 → 装依赖并建链接 → 往 profile package.json 写',
    'dependencies 与 dsh.profile.bundles。最后一步不能省：`dsh plugin`',
    '只装依赖、不写 bundles，而 DSH 启动只按 bundles 叠加补丁。',
    '完成后需要重启 DSH。',
  ].join('\n'))
}

function fail(message) {
  console.error('✗ ' + message)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { profile: 'web', home: undefined, dir: undefined, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '-h' || flag === '--help') { args.help = true; continue }
    if (flag === '--profile' || flag === '--home' || flag === '--dir') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) fail(flag + ' 后面缺少值')
      args[flag.slice(2)] = value
      index += 1
      continue
    }
    fail('未知参数：' + flag)
  }
  return args
}

/** Remove a path whether it is a symlink/junction or a real file/directory, never following a link. */
function removePath(path) {
  let info
  try { info = lstatSync(path) } catch { return } // 不存在
  if (info.isSymbolicLink()) { unlinkSync(path); return }
  rmSync(path, { recursive: true, force: true })
}

/** Create a directory link: junction on Windows (no privileges needed), symlink elsewhere. */
function linkDirectory(target, linkPath) {
  removePath(linkPath)
  symlinkSync(target, linkPath, IS_WINDOWS ? 'junction' : 'dir')
}

/** Ask the official CLI to install the dependency; pnpm owns the lockfile and the link. */
function tryOfficialAdd(profile, installDir) {
  const spec = 'link:' + installDir
  const result = IS_WINDOWS
    ? spawnSync('dsh', ['plugin', '--profile', profile, 'add', JSON.stringify(spec)], { stdio: 'ignore', shell: true })
    : spawnSync('dsh', ['plugin', '--profile', profile, 'add', spec], { stdio: 'ignore' })
  return result.status === 0
}

// ── 参数与前置检查 ──────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2))
if (args.help) { usage(); process.exit(0) }
if (!args.profile) fail('--profile 不能为空')

for (const relative of ['package.json', 'cordis.patch.yml', 'lib/client.js', 'lib/index.js']) {
  if (!existsSync(join(SRC, relative))) {
    fail('包不完整，缺少 ' + join(SRC, relative) + ' —— 请保持压缩包解压后的目录结构不变')
  }
}

const home = resolve(args.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const profileDir = join(home, 'profiles', args.profile)
const manifestPath = join(profileDir, 'package.json')
if (!existsSync(manifestPath)) {
  let existing = []
  try { existing = readdirSync(join(home, 'profiles')) } catch { existing = [] }
  fail('找不到 profile：' + manifestPath + '\n' +
    '  用 --profile <名字> 指定，或用 --home <DSH_HOME> 指定 DSH 主目录。\n' +
    (existing.length > 0
      ? '  该 DSH_HOME 下现有的 profile：' + existing.join(', ')
      : '  该 DSH_HOME 下没有找到任何 profile。'))
}
const installDir = resolve(args.dir ?? join(home, 'plugins', NAME))

// ── 1) 复制包 ──────────────────────────────────────────────────────────
console.log('→ 包目录：' + installDir)
mkdirSync(dirname(installDir), { recursive: true })
removePath(installDir)
mkdirSync(installDir, { recursive: true })
cpSync(SRC, installDir, { recursive: true })

// ── 2) 依赖与链接 ──────────────────────────────────────────────────────
let linkedBy = '手工链接'
if (tryOfficialAdd(args.profile, installDir)) {
  linkedBy = 'dsh plugin add'
} else {
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  try {
    linkDirectory(installDir, join(profileDir, 'node_modules', NAME))
  } catch (error) {
    fail('建立链接失败：' + (error && error.message ? error.message : error) +
      '\n  Windows 上 junction 通常无需特权；若被策略拦截，可手动把包目录复制到 ' +
      join(profileDir, 'node_modules', NAME))
  }
}
console.log('  ✓ 依赖已就位（' + linkedBy + '）')

// ── 3) 写 package.json ─────────────────────────────────────────────────
const raw = readFileSync(manifestPath, 'utf8')
let doc
try {
  doc = JSON.parse(raw)
} catch (error) {
  fail('profile 的 package.json 不是合法 JSON：' + (error && error.message ? error.message : error))
}
writeFileSync(manifestPath + '.before-' + NAME, raw)

doc.dependencies = doc.dependencies || {}
doc.dependencies[NAME] = 'link:' + installDir
doc.dsh = doc.dsh || {}
doc.dsh.profile = doc.dsh.profile || {}
const bundles = Array.isArray(doc.dsh.profile.bundles) ? doc.dsh.profile.bundles : []
if (!bundles.includes(NAME)) bundles.push(NAME)
doc.dsh.profile.bundles = bundles
writeFileSync(manifestPath, JSON.stringify(doc, null, 2) + '\n')

console.log('  ✓ dependencies["' + NAME + '"] = link:' + installDir)
console.log('  ✓ dsh.profile.bundles += ' + NAME)
console.log('  （原文件已备份为 package.json.before-' + NAME + '）')

// 设置页需要 Web profile：非 web 的 profile 里这条行会一直等 webServer。给个提醒，不拦。
const hasWeb = bundles.some((name) => /dsh-web-app|(^|\/)web($|-)/.test(String(name)))
if (!hasWeb) {
  console.log('  ! 这个 profile 的 bundles 里没看到 web 相关 bundle：插件会装上，')
  console.log('    但「设置 → 背景底图」是网页界面，非 Web profile 里不会出现。')
}

console.log('')
console.log('✓ 安装完成')
console.log('  profile  ：' + profileDir)
console.log('  包目录   ：' + installDir)
console.log('')
console.log('下一步：')
console.log('  1. 重启 DSH（关闭并重新打开 App / 重启 dsh web 进程）')
console.log('     —— 组合补丁只在启动时读取（patchReload: startup），不重启不会生效')
console.log('  2. 打开 设置 → 「背景底图」，选一张图片即可')
console.log('')
console.log('注意：如果之后你运行了 pnpm install（例如用 dsh plugin 装别的插件），')
console.log('      链接可能被清理，重新跑一次本脚本即可。')
