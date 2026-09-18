#!/usr/bin/env bash
# ============================================================================
# dsh-wallpaper 卸载脚本
# ============================================================================
#   ./uninstall.sh                    # 从 $DSH_HOME(默认 ~/.dsh)/profiles/web 卸载
#   ./uninstall.sh --profile <名字> --home <DSH_HOME>
#   ./uninstall.sh --keep-files       # 只解除挂载，保留包目录与已设底图
#
# 默认会：解除依赖与 bundles 条目、删除包目录。
# 已设的底图（$DSH_HOME/wallpaper.json）**始终保留**——想彻底清干净请自己删它。
# ============================================================================
set -euo pipefail

PROFILE="web"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
INSTALL_DIR=""
KEEP_FILES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --home)    DSH_HOME_DIR="${2:-}"; shift 2 ;;
    --dir)     INSTALL_DIR="${2:-}"; shift 2 ;;
    --keep-files) KEEP_FILES=1; shift ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

DSH_HOME_DIR="${DSH_HOME_DIR%/}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
[ -n "$INSTALL_DIR" ] || INSTALL_DIR="$DSH_HOME_DIR/plugins/dsh-wallpaper"

if [ ! -f "$PROFILE_DIR/package.json" ]; then
  echo "✗ 找不到 profile：$PROFILE_DIR/package.json" >&2
  exit 1
fi
command -v node >/dev/null 2>&1 || { echo "✗ 需要 node" >&2; exit 1; }

PKG_JSON="$PROFILE_DIR/package.json" node -e '
const fs = require("node:fs");
const file = process.env.PKG_JSON;
const raw = fs.readFileSync(file, "utf8");
let doc;
try { doc = JSON.parse(raw); } catch (error) { console.error("✗ package.json 不是合法 JSON"); process.exit(1); }
if (doc.dependencies) delete doc.dependencies["dsh-wallpaper"];
const bundles = doc.dsh?.profile?.bundles;
if (Array.isArray(bundles)) {
  doc.dsh.profile.bundles = bundles.filter((name) => name !== "dsh-wallpaper");
}
fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
console.log("  ✓ 已移除 dependencies / dsh.profile.bundles 里的 dsh-wallpaper");
'

rm -f "$PROFILE_DIR/node_modules/dsh-wallpaper"
echo "  ✓ 已删除 node_modules/dsh-wallpaper"

# 默认安装目录是全机共享的（$DSH_HOME/plugins/dsh-wallpaper）：别的 profile 还在引用它时
# 必须保留，否则那边会变成断链、插件直接失效。只有指向同一个目录的 link: 依赖才算数。
shared_with=""
if [ "$KEEP_FILES" != 1 ]; then
  shared_with="$(PROFILES_DIR="$DSH_HOME_DIR/profiles" CUR="$PROFILE" TARGET="$INSTALL_DIR" node -e '
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.PROFILES_DIR;
const target = path.resolve(process.env.TARGET);
let names = [];
try { names = fs.readdirSync(root); } catch { process.exit(0); }
for (const name of names) {
  if (name === process.env.CUR) continue;
  const manifest = path.join(root, name, "package.json");
  if (!fs.existsSync(manifest)) continue;
  let doc;
  try { doc = JSON.parse(fs.readFileSync(manifest, "utf8")); } catch { continue; }
  const spec = doc.dependencies && doc.dependencies["dsh-wallpaper"];
  if (typeof spec !== "string" || spec.indexOf("link:") !== 0) continue;
  if (path.resolve(spec.slice(5)) === target) { process.stdout.write(name); break; }
}
' 2>/dev/null || true)"
fi

if [ "$KEEP_FILES" = 1 ]; then
  echo "  · 保留包目录：$INSTALL_DIR"
elif [ -n "$shared_with" ]; then
  echo "  · 保留包目录：$INSTALL_DIR"
  echo "    （profile \"$shared_with\" 仍在引用它，删掉会让那边断链）"
else
  rm -rf "$INSTALL_DIR"
  echo "  ✓ 已删除包目录：$INSTALL_DIR"
fi

echo
echo "✓ 卸载完成 —— 重启 DSH 后生效"
echo "  已设的底图仍在：$DSH_HOME_DIR/wallpaper.json（想删就自己删）"
