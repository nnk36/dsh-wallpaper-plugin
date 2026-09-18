// dsh-wallpaper —— 宿主半（Node 侧 Cordis 插件行）
//
// 职责只有一件事：给浏览器半提供两个同源路由，用来读写落在
// $DSH_HOME/wallpaper.json 的底图状态。
//
// 为什么需要宿主半：静态客户端插件（dsh.client）不是动态包，拿不到
// harness.handle / host.call 那套 Package-private RPC，所以持久化走 HTTP 路由。
//
// 设计约束（都是实测出来的，别随手改）：
//   * webServer 必须是模块级 inject —— 它是硬依赖，inject 让 Cordis 等服务就绪后
//     再激活本行。曾经用 ctx.get('webServer') + 缺失即返回来"避免入口 pending"，
//     隔离实例实测**失败**：本行比 webServer 的提供者先激活，apply 时 ctx.get 拿到
//     undefined，于是静默早退、路由根本没注册，持久化失效且没有任何报错。
//   * 所有路由都过 connection.requestRejection 信任栅栏，避免 DNS 重绑定 /
//     未认证页面读写底图（栅栏本身不可用时 fail-open，但只警告一次）。
//   * 写入用 临时文件 + rename，避免半截 JSON 让状态文件变成"损坏"。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(DSH_HOME, 'wallpaper.json')
const TEMP_FILE = path.join(DSH_HOME, '.wallpaper.json.tmp')

// 压缩后的底图通常 200–500KB，base64 后更小；24MB 足够容纳"本来就很小、
// 因而保持原样"的图（客户端对超过 1.2MB 的文件会强制重编码）。
const MAX_BODY_BYTES = 24 * 1024 * 1024

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('body too large'))
        try { req.destroy() } catch (error) { /* 已经断开 */ }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const asNumber = (value, fallback) => (typeof value === 'number' && isFinite(value) ? value : fallback)
const asText = (value) => (typeof value === 'string' ? value : '')
const asImageUrl = (value) => {
  const text = asText(value)
  return text.indexOf('data:image/') === 0 ? text : null
}

/** Normalize one persisted record; never trusts the file's shape. */
function normalizeState(parsed) {
  if (parsed === null || typeof parsed !== 'object') return null
  return {
    url: asImageUrl(parsed.url),
    name: asText(parsed.name),
    size: asNumber(parsed.size, 0),
    sourceSize: asNumber(parsed.sourceSize, 0),
    veil: asNumber(parsed.veil, null)
  }
}

/** Read the persisted record; an absent or damaged file reads as "no wallpaper". */
function readState() {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')))
  } catch (error) {
    return null
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(JSON.stringify(payload))
}

export default {
  name: 'dsh-wallpaper',
  /* Hard dependency: without this the row activates before the web server exists,
     apply() sees no service, and the routes silently never register. */
  inject: ['webServer'],
  apply(ctx) {
    const webServer = ctx.webServer
    if (webServer === undefined) {
      console.warn('[dsh-wallpaper] webServer 服务已声明 inject 却仍不可用，底图持久化路由未注册')
      return
    }

    let fenceWarned = false
    /** Trust fence: reject forged Host/Origin and unauthenticated requests. */
    function rejected(req, res) {
      const connection = ctx.get('connection')
      if (connection === undefined || typeof connection.requestRejection !== 'function') {
        if (!fenceWarned) {
          fenceWarned = true
          console.warn('[dsh-wallpaper] 信任栅栏不可用：connection 服务缺失，自定义路由将放行处理')
        }
        return false
      }
      try {
        const code = connection.requestRejection(req)
        if (code === undefined || code === null || code === false) return false
        res.statusCode = typeof code === 'number' ? code : 403
        res.end()
        return true
      } catch (error) {
        return false
      }
    }

    function register(route) {
      const inner = route.handler
      ctx.effect(() => webServer.register(Object.assign({}, route, {
        handler: async (req, res) => {
          if (rejected(req, res)) return undefined
          return inner(req, res)
        }
      })), 'dsh-wallpaper: route ' + route.path)
    }

    register({
      kind: 'exact',
      path: '/dsh-wallpaper/state',
      handler: (req, res) => {
        // 连同路径一起回，刷新后设置页也能显示底图存在哪里（与 save 的响应保持一致）。
        sendJson(res, 200, { ok: true, path: STATE_FILE, value: readState() })
      }
    })

    register({
      kind: 'exact',
      path: '/dsh-wallpaper/save',
      handler: async (req, res) => {
        let body
        try {
          body = await readBody(req, MAX_BODY_BYTES)
        } catch (error) {
          sendJson(res, 413, { ok: false, reason: '请求体过大' })
          return
        }
        let parsed
        try {
          parsed = JSON.parse(body === '' ? '{}' : body)
        } catch (error) {
          sendJson(res, 400, { ok: false, reason: 'JSON 解析失败' })
          return
        }
        if (parsed === null || typeof parsed !== 'object') {
          sendJson(res, 400, { ok: false, reason: '请求体必须是对象' })
          return
        }
        const state = normalizeState(parsed) || { url: null, name: '', size: 0, sourceSize: 0, veil: null }
        try {
          await fs.promises.writeFile(TEMP_FILE, JSON.stringify(state), 'utf8')
          await fs.promises.rename(TEMP_FILE, STATE_FILE)
        } catch (error) {
          sendJson(res, 500, { ok: false, reason: String(error && error.message ? error.message : error) })
          return
        }
        sendJson(res, 200, {
          ok: true,
          path: STATE_FILE,
          bytes: state.url === null ? 0 : state.url.length
        })
      }
    })
  }
}
