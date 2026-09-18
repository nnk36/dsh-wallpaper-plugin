# dsh-wallpaper

DSH Web 界面的**背景底图**常驻插件：在「设置 → 背景底图」里上传一张本地图片更换界面底图，
可一键恢复默认空白底图。底图落盘，**刷新页面或重启 DSH 后自动生效**。

## 为什么是常驻插件

最初这功能是一个**动态 Cordis 插件**（`cordis_define` / `cordis_run` 那套）。动态插件只活在
DSH 进程内存里：进程一重启，插件连同界面一起消失，只剩状态文件，需要重新运行插件才能恢复。
这个包把它变成常驻插件，让底图在重启后自己回来。

## 结构

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主半（Node 侧）：注册 `/dsh-wallpaper/{state,save}` 两条同源路由，读写状态文件 |
| `lib/client.js` | 浏览器半：真正的客户端插件，注册进 `settings.section` 插槽 |
| `cordis.patch.yml` | bundle patch：把宿主半那一行插进 Web profile 的配置树 |

浏览器半由 `clientModules` 依据 `package.json` 的 `dsh.client` + `exports["./client"]` 组合进
页面，和第一方 `dsh-client-ui-*` 插件走同一条路——**不是**往 index.html 里注入裸脚本，
所以它拿得到真正的 `slots` / `theme` 服务。

## 状态文件

    $DSH_HOME/wallpaper.json      # 本机为 /root/.dsh/wallpaper.json

内容是一个 JSON 对象：

```json
{ "url": "data:image/webp;base64,…", "name": "照片.jpg", "size": 101342,
  "sourceSize": 194472, "veil": 0.3 }
```

* `url` 为 `null` 表示"使用默认空白底图"（即已恢复默认）；非 `data:image/` 开头的值一律被清成 `null`。
* 写入用 临时文件 + rename，避免半截 JSON。
* 文件损坏或缺失都读作"没有底图"，不会报错。

## 安装 / 卸载

一份分发包（含 `install.sh`）的用法见压缩包**顶层**的 `README.md`。一句话版本：

```sh
bash install.sh --profile web       # 复制包 + 装依赖 + 写 bundles 条目
# 然后重启 DSH
```

如果你手上只有这个包目录（没有安装脚本），手工等价操作是：

```sh
# 1) 把包放到一个不会被删的位置，例如 $DSH_HOME/plugins/dsh-wallpaper
# 2) 装依赖（或直接建符号链接）
ln -sfn <包目录绝对路径> $DSH_HOME/profiles/<profile>/node_modules/dsh-wallpaper
# 3) 编辑 $DSH_HOME/profiles/<profile>/package.json：
#    dependencies += "dsh-wallpaper": "link:<包目录绝对路径>"
#    dsh.profile.bundles += "dsh-wallpaper"      ← 少这一步不会生效
# 4) 重启 DSH（patchReload 为 startup，只在启动时读组合）
```

卸载：把上面两处 `package.json` 改动去掉、删掉符号链接、重启 DSH；
`$DSH_HOME/wallpaper.json` 可以留着也可以删。

校验组合是否有效（**不需要重启**）：

```sh
dsh --profile web --dump-config | grep -A2 dsh-wallpaper
```

## 设计约束（都是踩过或查过的，别随手改掉）

* **`webServer` 必须是模块级 `inject`**：它是硬依赖，`inject` 让 Cordis 等服务就绪后
  再激活本行。曾经用 `ctx.get('webServer')` + 缺失即返回来"避免入口 pending"，
  在隔离实例上实测**失败**——本行比 webServer 的提供者先激活，`apply` 时 `ctx.get`
  拿到 `undefined`，于是静默早退、路由根本没注册，持久化失效**且没有任何报错**。
  （`dsh-status-overlay` 那条"不要模块级 inject"的告诫针对的是可能永远不出现的服务；
  web 服务在 web profile 里必然出现，不适用。）
* **路由都过 `connection.requestRejection` 信任栅栏**，避免 DNS 重绑定 / 未认证页面读写底图。
* **图片样式表带着整份 data URL，所以每张图只插一次 `<style>`**；
  拖遮罩滑杆只重发布那 2 个 CSS 变量，绝不重建大样式表。
  （拖滑杆仍有一点开销：theme 服务每次重发布都会让 ui-layout 的 ThemePresenter
  做一次 `getComputedStyle`；要彻底消除得把 alpha 写进自己的样式表、绕开 theme 服务。）
* **侧边栏不透明**：`--dsw-specific-sidebar-fill` 用不透明常量（浅色纯白 `#ffffff`、
  深色沿用出厂 `#1b1b1c`），刻意不给 alpha —— 底图只从主区域透出来，左栏保持干净可读。
  纯白只在**有自定义底图时**生效；点「恢复默认空白底图」后 token 层整体撤回，
  侧栏回到出厂浅灰 `#f9fafb`。
* **上传时先把图缩到长边 ≤1920 再 webp q0.86 重编码**（失败回退 jpeg），
  否则 12MP 原图会被交给合成器，滚动时明显掉帧。
  已经够小（长边 ≤1920 且 ≤1.2MB）的文件保持原样，不做无谓的有损重编码。
* **`lib/client.js` 会被原样拼进 combo 脚本**（clientModules 只剥 source map 尾注）。
  它一旦有语法错误，整页所有客户端插件都会挂——改完务必做一次经典脚本上下文的解析检查：

  ```sh
  cp lib/client.js /tmp/check.cjs && node --check /tmp/check.cjs
  ```

* 客户端半**不能**用 `harness.handle` / `host.call`（那是动态包专属的 Package-private RPC），
  所以持久化走 HTTP 路由。
