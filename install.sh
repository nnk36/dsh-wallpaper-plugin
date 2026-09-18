#!/usr/bin/env bash
# ============================================================================
# dsh-wallpaper 安装脚本
# ============================================================================
# 把 dsh-wallpaper 装进指定的 DSH profile。
#
#   ./install.sh                       # 装进 $DSH_HOME(默认 ~/.dsh)/profiles/web
#   ./install.sh --profile myprofile   # 指定 profile
#   ./install.sh --home /path/to/.dsh  # 指定 DSH_HOME
#   ./install.sh --dir /path/to/keep   # 指定包被复制到的位置
#
# 为什么需要脚本，而不是一句 `dsh plugin add`：
#   `dsh plugin` 只是把参数转发给 profile 目录里的 pnpm，它只装依赖，
#   **不会**把插件名加进 package.json 的 dsh.profile.bundles。而 DSH 启动时
#   只按那个列表叠加 bundle 补丁，没有任何"装了依赖就自动生效"的发现机制。
#   所以必须补上 bundles 这一步，插件才会真正被组合进配置树。
# ============================================================================
set -euo pipefail

PROFILE="web"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
INSTALL_DIR=""

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --home)    DSH_HOME_DIR="${2:-}"; shift 2 ;;
    --dir)     INSTALL_DIR="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage; exit 2 ;;
  esac
done

[ -n "$PROFILE" ] || { echo "✗ --profile 不能为空" >&2; exit 2; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/dsh-wallpaper"
[ -f "$SRC/package.json" ] || { echo "✗ 找不到 $SRC/package.json —— 请保持压缩包解压后的目录结构不变" >&2; exit 1; }
[ -f "$SRC/lib/client.js" ] || { echo "✗ 缺少 lib/client.js，包不完整" >&2; exit 1; }
[ -f "$SRC/lib/index.js" ] || { echo "✗ 缺少 lib/index.js，包不完整" >&2; exit 1; }

DSH_HOME_DIR="${DSH_HOME_DIR%/}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
[ -f "$PROFILE_DIR/package.json" ] || {
  echo "✗ 找不到 profile：$PROFILE_DIR/package.json" >&2
  echo "  用 --profile <名字> 指定 profile，或用 --home <DSH_HOME> 指定 DSH 主目录。" >&2
  echo "  现有的 profile：$(ls "$DSH_HOME_DIR/profiles" 2>/dev/null | tr '\n' ' ')" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || { echo "✗ 需要 node（DSH 本身就依赖它，请确认 PATH）" >&2; exit 1; }

[ -n "$INSTALL_DIR" ] || INSTALL_DIR="$DSH_HOME_DIR/plugins/dsh-wallpaper"

echo "→ 包目录：$INSTALL_DIR"
mkdir -p "$(dirname "$INSTALL_DIR")"
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp -R "$SRC/." "$INSTALL_DIR/"

# ── 1) 依赖 + 符号链接 ───────────────────────────────────────────────────
# 优先走官方命令（pnpm 会自己维护 lockfile 与链接）；不可用时退回手工链接。
LINKED_BY="手工链接"
if command -v dsh >/dev/null 2>&1; then
  echo "→ 尝试 dsh plugin --profile $PROFILE add link:$INSTALL_DIR"
  if dsh plugin --profile "$PROFILE" add "link:$INSTALL_DIR" >/tmp/dsh-wallpaper-pnpm.log 2>&1; then
    LINKED_BY="dsh plugin add"
  else
    echo "  （官方命令未成功，改用手工链接；日志见 /tmp/dsh-wallpaper-pnpm.log）"
  fi
fi
if [ "$LINKED_BY" = "手工链接" ]; then
  mkdir -p "$PROFILE_DIR/node_modules"
  ln -sfn "$INSTALL_DIR" "$PROFILE_DIR/node_modules/dsh-wallpaper"
fi
echo "  ✓ 依赖已就位（$LINKED_BY）"

# ── 2) 写 package.json：dependencies + dsh.profile.bundles ───────────────
PKG_JSON="$PROFILE_DIR/package.json" WP_DIR="$INSTALL_DIR" node -e '
const fs = require("node:fs");
const file = process.env.PKG_JSON;
const dir = process.env.WP_DIR;
const raw = fs.readFileSync(file, "utf8");
let doc;
try { doc = JSON.parse(raw); } catch (error) {
  console.error("✗ package.json 不是合法 JSON：" + error.message);
  process.exit(1);
}
fs.writeFileSync(file + ".before-dsh-wallpaper", raw);
doc.dependencies = doc.dependencies || {};
doc.dependencies["dsh-wallpaper"] = "link:" + dir;
doc.dsh = doc.dsh || {};
doc.dsh.profile = doc.dsh.profile || {};
doc.dsh.profile.bundles = doc.dsh.profile.bundles || [];
if (!doc.dsh.profile.bundles.includes("dsh-wallpaper")) doc.dsh.profile.bundles.push("dsh-wallpaper");
fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
console.log("  ✓ dependencies[\"dsh-wallpaper\"] = link:" + dir);
console.log("  ✓ dsh.profile.bundles += dsh-wallpaper");
'
echo "  （原文件已备份为 package.json.before-dsh-wallpaper）"

echo
echo "✓ 安装完成"
echo "  profile ：$PROFILE_DIR"
echo "  包目录  ：$INSTALL_DIR"
echo
echo "下一步："
echo "  1. 重启 DSH（关闭并重新打开 App；命令行则是重启 dsh web 进程）"
echo "     —— 组合补丁只在启动时读取（patchReload: startup），不重启不会生效"
echo "  2. 打开 设置 → 「背景底图」，选一张图片即可"
echo
echo "注意：如果之后你运行了 pnpm install（例如用 dsh plugin 装别的插件），"
echo "      符号链接可能被清理，重新跑一次本脚本即可。"
