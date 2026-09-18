#!/usr/bin/env node
// ============================================================================
// dsh-wallpaper 卸载器（跨平台：Windows / macOS / Linux）
// ============================================================================
//   node uninstall.mjs                   # 从 $DSH_HOME(默认 ~/.dsh)/profiles/web 卸载
//   node uninstall.mjs --profile <名字> --home <DSH_HOME>
//   node uninstall.mjs --keep-files      # 只解除挂载，保留包目录
//
// 默认会：解除依赖与 bundles 条目、删除包目录。
// 已设的底图（$DSH_HOME/wallpaper.json）**始终保留**——想彻底清干净请自己删它。
// ============================================================================

import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const NAME = 'dsh-wallpaper'

function fail(message) {
  console.error('✗ ' + message)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { profile: 'web', home: undefined, dir: undefined, keepFiles: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '-h' || flag === '--help') {
      console.log([
        'dsh-wallpaper 卸载器（跨平台）',
        '',
        '  node uninstall.mjs                   从 $DSH_HOME/profiles/web 卸载',
        '  node uninstall.mjs --profile <名字>  指定 profile',
        '  node uninstall.mjs --home <DSH_HOME> 指定 DSH 主目录',
        '  node uninstall.mjs --keep-files      只解除挂载，保留包目录',
        '',
        '解除依赖与 dsh.profile.bundles 条目、删除链接与包目录；',
        '已设的底图 $DSH_HOME/wallpaper.json 始终保留。完成后需要重启 DSH。',
      ].join('\n'))
      process.exit(0)
    }
    if (flag === '--keep-files') { args.keepFiles = true; continue }
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
  try { info = lstatSync(path) } catch { return }
  if (info.isSymbolicLink()) { unlinkSync(path); return }
  rmSync(path, { recursive: true, force: true })
}

/**
 * Is this package directory still referenced by ANOTHER profile?
 *
 * The default install directory is shared by every profile on the machine
 * ($DSH_HOME/plugins/dsh-wallpaper), so deleting it while another profile links
 * to it leaves that profile with a dangling symlink and a broken plugin. Only a
 * `link:` dependency pointing at this exact directory counts.
 *
 * @returns the name of one profile still using it, or undefined.
 */
function profileStillUsing(home, installDir, currentProfile) {
  let profiles = []
  try { profiles = readdirSync(join(home, 'profiles')) } catch { return undefined }
  for (const name of profiles) {
    if (name === currentProfile) continue
    const manifest = join(home, 'profiles', name, 'package.json')
    if (!existsSync(manifest)) continue
    let doc
    try { doc = JSON.parse(readFileSync(manifest, 'utf8')) } catch { continue }
    const spec = doc.dependencies?.[NAME]
    if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
    if (resolve(spec.slice(5)) === installDir) return name
  }
  return undefined
}

const args = parseArgs(process.argv.slice(2))
const home = resolve(args.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const profileDir = join(home, 'profiles', args.profile)
const manifestPath = join(profileDir, 'package.json')
if (!existsSync(manifestPath)) fail('找不到 profile：' + manifestPath)

const raw = readFileSync(manifestPath, 'utf8')
let doc
try {
  doc = JSON.parse(raw)
} catch (error) {
  fail('profile 的 package.json 不是合法 JSON：' + (error && error.message ? error.message : error))
}
if (doc.dependencies && Object.prototype.hasOwnProperty.call(doc.dependencies, NAME)) delete doc.dependencies[NAME]
const bundles = doc.dsh?.profile?.bundles
if (Array.isArray(bundles)) doc.dsh.profile.bundles = bundles.filter((name) => name !== NAME)
writeFileSync(manifestPath, JSON.stringify(doc, null, 2) + '\n')
console.log('  ✓ 已移除 dependencies / dsh.profile.bundles 里的 ' + NAME)

removePath(join(profileDir, 'node_modules', NAME))
console.log('  ✓ 已删除 node_modules/' + NAME)

const installDir = resolve(args.dir ?? join(home, 'plugins', NAME))
const sharedWith = args.keepFiles ? undefined : profileStillUsing(home, installDir, args.profile)
if (args.keepFiles) {
  console.log('  · 保留包目录：' + installDir)
} else if (sharedWith !== undefined) {
  console.log('  · 保留包目录：' + installDir)
  console.log('    （profile "' + sharedWith + '" 仍在引用它，删掉会让那边断链）')
} else {
  removePath(installDir)
  console.log('  ✓ 已删除包目录：' + installDir)
}

console.log('')
console.log('✓ 卸载完成 —— 重启 DSH 后生效')
console.log('  已设的底图仍在：' + join(home, 'wallpaper.json') + '（想删就自己删）')
