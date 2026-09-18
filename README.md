# dsh-wallpaper —— 给 DSH Web 换背景底图

一个 DSH 插件：在 **设置 → 「背景底图」** 里上传一张本地图片，把它作为整个界面的背景底图；
一键即可恢复默认空白底图。底图会**存到磁盘**，刷新页面、重启 DSH 之后都会自动恢复。

- 底图铺在界面最底层，上面叠加一层可调强度的半透明遮罩，保证文字可读
- 侧边栏保持不透明（浅色为纯白），底图只从主区域透出来
- 上传时会自动把大图缩到长边 ≤1920 再重编码（webp），避免手机相册里的大照片拖慢界面

## 环境要求

- 一套 DSH，且有一个**基于 Web 的 profile**（`web` 或从它派生的 profile）
- 能用浏览器打开 DSH 界面
- `node` 在 PATH 里（DSH 本身就依赖它）

> 本包在 **DSH 0.1.5-rc.2 + Node 24** 上开发并实测通过（安装、启动加载、上传、刷新恢复、
> 重启恢复、卸载都已跑过）。它只用稳定的公开接口（`dsh.bundle.patch`、`dsh.client`、
> `webServer.register`、`slots.register`、`theme.overrideTokens`），版本相差不大一般都能用。
> 万一某个接口在你的版本上变了，DSH 的启动输出（本机是 `/root/dsh-web.log`）里会有插件
> 加载轨迹，能看出卡在哪一步。

## 安装（三步）

```bash
# 1. 解压后进入本目录
unzip dsh-wallpaper-0.1.1.zip && cd dsh-wallpaper-0.1.1

# 2. 运行安装器（跨平台，只要有 node：Windows / macOS / Linux 通用）
node install.mjs                 # 默认装进 ~/.dsh/profiles/web
# 需要时指定：
# node install.mjs --profile <名字> --home <DSH_HOME>

# 3. 重启 DSH，然后打开 设置 → 「背景底图」
```

> **为什么必须重启**：DSH 的插件组合补丁只在启动时读取（`patchReload: startup`）。

三个平台都用 `node install.mjs`：Windows 上用 **junction** 建链接（和 npm/pnpm 的做法一致，
**不需要管理员或开发者模式**），其他系统用符号链接；`--home`、`--dir` 也都按平台原生路径处理。
POSIX 环境也可以用附带的 shell 脚本，两者等价：

```bash
bash install.sh                  # 或 ./install.sh（前提是执行位还在）
```

> 为什么更推荐 `node install.mjs`：脚本的执行位在部分环境会丢（例如安卓 `/sdcard`
> 不保存可执行位，从那里拷贝或重新打包就会丢），而 `node` 调用根本不依赖执行位。

### 安装器做了什么

1. 把插件包复制到 `$DSH_HOME/plugins/dsh-wallpaper`
   （Windows 下即 `%USERPROFILE%\.dsh\plugins\dsh-wallpaper`）
2. 装依赖：优先 `dsh plugin --profile <p> add link:<包目录>`，失败则自己建链接
3. **把 `dsh-wallpaper` 加进 profile `package.json` 的 `dsh.profile.bundles`**
4. 原文件备份为 `package.json.before-dsh-wallpaper`

第 3 步是关键：`dsh plugin` 只是把参数转发给 profile 目录里的 pnpm，它**只装依赖**。
DSH 启动时只按 `dsh.profile.bundles` 这个有序列表叠加各 bundle 的补丁，**不存在**
"装了依赖就自动生效"的发现机制——漏掉这一步，装完什么都不会发生。

## 手工安装（不想跑脚本时）

1. 把 `dsh-wallpaper/` 整个目录放到一个**不会被删**的位置，例如 `~/.dsh/plugins/dsh-wallpaper`
2. 编辑 `~/.dsh/profiles/web/package.json`：

   ```json
   {
     "dependencies": {
       "dsh-wallpaper": "link:/绝对路径/.dsh/plugins/dsh-wallpaper"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "dsh-wallpaper"
         ]
       }
     }
   }
   ```

   （`bundles` 里保留原有的项，只在末尾加上 `dsh-wallpaper`）
3. 建符号链接：`ln -s /绝对路径/.dsh/plugins/dsh-wallpaper ~/.dsh/profiles/web/node_modules/dsh-wallpaper`
   （Windows 上可用 `mklink /D`，或直接把目录复制进 `node_modules/`）
4. 重启 DSH

校验配置有没有被正确读到（**不需要重启**）：

```bash
dsh --profile web --dump-config | grep -A2 dsh-wallpaper
```

能看到 `- id: dsh-wallpaper` 就说明组合树里有它了。

## 使用

**设置 → 「背景底图」**（在设置导航最下面）：

| 元素 | 作用 |
| --- | --- |
| 预览框 | 显示当前底图；未设置时提示"当前使用默认空白底图" |
| **选择图片 / 更换图片** | 打开本地文件选择器（`image/*`），选完立即生效并保存 |
| **恢复默认空白底图** | 清空自定义底图，回到原始纯色背景 |
| 遮罩强度 | 30%–95%。越高越不透明、文字越清晰；越低照片越明显 |
| 状态行 | 当前文件名与体积（含压缩比）、持久化文件路径 |

## 卸载

```bash
node uninstall.mjs                # 解除挂载并删除包目录（跨平台）
node uninstall.mjs --keep-files   # 只解除挂载
# POSIX 也可用：bash uninstall.sh
```

已设的底图存在 `$DSH_HOME/wallpaper.json`，卸载**不会**动它；想彻底清干净自己删掉即可。

## 说明

- 底图存放在 `$DSH_HOME/wallpaper.json`（默认 `~/.dsh/wallpaper.json`），是一个含
  data URL 的 JSON 对象。写入用"临时文件 + rename"，不会出现半截文件。
- 插件由两部分组成：Node 侧只注册两条读写底图状态的路由，浏览器侧是真正的 DSH 客户端插件，
  通过 `settings.section` 插槽注册设置页。技术细节与设计约束见 `dsh-wallpaper/README.md`。
- 如果之后你运行了 `pnpm install`（例如用 `dsh plugin` 装别的插件），符号链接可能被清理，
  重跑一次 `./install.sh` 即可。
- 卸载或停用插件后，底图会随样式一起回滚到默认外观；但状态文件仍在，重装后会恢复。

## 许可

MIT，见 `dsh-wallpaper/LICENSE`。
