// dsh-wallpaper —— 浏览器半
//
// 这是一个真正的 DSH 客户端插件（不是动态包），因此：
//   * 拿得到真实的 slots / theme 服务，设置页按第一方插件的方式注册；
//   * 没有 harness.handle / host.call 那套 Package-private RPC，
//     持久化改走宿主半注册的同源路由 /dsh-wallpaper/{state,save}。
//
// 文件由 clientModules 原样拼接进 combo 脚本下发，所以这里是自包含的 IIFE：
// 不写 import，只通过工厂的 require('react') 取 React。
//
// 性能要点（都是实测出来的，不是想当然）：
//   * 图片样式表里带着整份 data URL，因此每张图只插一次 <style>；
//     拖遮罩滑杆只重发布那 2 个 CSS 变量，绝不重建大样式表；
//   * 上传时先把图缩到长边 ≤1920 再重编码，避免把 12MP 原图交给合成器。

window.__ModuleLoader__.load({
  id: 'dsh-wallpaper',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')

    const STYLE = [
      '.dwp-page{display:flex;flex-direction:column;gap:14px;max-width:680px;padding:4px 4px 28px}',
      '.dwp-h{margin:0;font-size:16px;line-height:24px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.dwp-p{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.dwp-preview{position:relative;display:flex;align-items:center;justify-content:center;width:100%;height:190px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:14px;background-color:var(--dsw-alias-bg-layer-2,#f5f6f7);background-size:cover;background-position:center center;background-repeat:no-repeat;overflow:hidden;font-size:13px;color:var(--dsw-alias-label-tertiary,#81858c)}',
      '.dwp-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px}',
      '.dwp-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 18px;box-sizing:border-box;border:0;border-radius:18px;font-size:14px;line-height:1;font-family:inherit;cursor:pointer;background:var(--dsw-alias-bg-layer-2,#f5f6f7);color:var(--dsw-alias-label-primary,#0f1115);transition:background-color .12s ease-out}',
      '.dwp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.dwp-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#0f1115);outline-offset:2px}',
      '.dwp-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.dwp-btn-main{background:var(--dsw-alias-button-primary-fill,#0f1115);color:var(--dsw-alias-label-primary-foreground,#fff)}',
      '.dwp-btn-main:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#3a3a3d)}',
      '.dwp-file{position:absolute;left:0;top:0;width:1px;height:1px;padding:0;border:0;opacity:0;overflow:hidden;pointer-events:none}',
      '.dwp-slider{display:flex;align-items:center;gap:12px}',
      '.dwp-range{flex:1;min-width:120px;accent-color:var(--dsw-alias-brand-primary,#0f1115)}',
      '.dwp-range:disabled{opacity:.45}',
      '.dwp-cap{font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary,#61666b);white-space:nowrap}',
      '.dwp-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#81858c);word-break:break-all}',
      '.dwp-status{font-size:12px;line-height:18px;min-height:18px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.dwp-err{color:var(--dsw-alias-state-error-primary,#ec1313)}'
    ].join('\n')

    /* 我们真正绘制的图的最长边上限：解码一张 12MP 手机照片是最大的一笔绘制开销，
       而视口远小于它。 */
    const IMAGE_MAX_EDGE = 1920
    /* 超过这个体积就重编码，即使长边已经够小。 */
    const KEEP_ORIGINAL_BYTES = 1200000
    const VEIL_MIN = 0.3
    const VEIL_MAX = 0.95
    const VEIL_DEFAULT = 0.72

    /* 随包发布的浅/深色底，重新发射为带 alpha 的值，让照片从主区域透出来。 */
    const BASE_LIGHT = '255,255,255'
    const BASE_DARK = '21,21,23'
    /* 侧边栏刻意**不给 alpha**：不透明，底图不透进左栏。
       浅色用纯白；深色沿用出厂侧栏底色——纯白在深色主题下会刺眼。 */
    const SIDE_SOLID_LIGHT = '#ffffff'
    const SIDE_SOLID_DARK = '#1b1b1c'

    const STATE_URL = '/dsh-wallpaper/state'
    const SAVE_URL = '/dsh-wallpaper/save'

    const clampVeil = (value) => {
      const n = Number(value)
      if (!isFinite(n)) return VEIL_DEFAULT
      return Math.min(VEIL_MAX, Math.max(VEIL_MIN, n))
    }

    const bytesText = (bytes) => bytes >= 1048576
      ? (bytes / 1048576).toFixed(1) + ' MB'
      : Math.max(1, Math.round(bytes / 1024)) + ' KB'

    /* base64 data URL 的近似解码体积。 */
    const dataBytes = (url) => Math.round(url.length * 0.75)

    function apply(ctx) {
      let imageUrl = null
      let fileName = ''
      let storedBytes = 0
      let sourceBytes = 0
      let veil = VEIL_DEFAULT
      let imageCss = null
      let tokenLayer = null
      let persistState = 'loading'
      let persistDetail = ''
      const watchers = new Set()

      const styleTag = document.createElement('style')
      styleTag.setAttribute('data-dsh-wallpaper', '')
      styleTag.textContent = STYLE
      document.head.append(styleTag)
      ctx.effect(() => () => { styleTag.remove() })

      const notify = () => { watchers.forEach((fn) => fn()) }
      const rgba = (triple) => 'rgba(' + triple + ',' + veil.toFixed(2) + ')'

      /* 图片样式表带着整份 data URL，所以每张图只插一次，拖遮罩时绝不重建。 */
      const paintImage = () => {
        if (imageCss !== null) { imageCss(); imageCss = null }
        if (imageUrl === null) return
        const tag = document.createElement('style')
        tag.setAttribute('data-dsh-wallpaper-image', '')
        tag.textContent = 'html{background-image:url("' + imageUrl + '");background-size:cover;'
          + 'background-position:center center;background-repeat:no-repeat;}'
        document.head.append(tag)
        imageCss = () => { tag.remove() }
      }

      /* 遮罩变化只重发布这 2 个 token：内置 light/dark 主题自身 tokens 为空，
         所以一次重发布只写 2 个 CSS 变量，而不是整套调色板。
         侧栏的值不随遮罩变（它是不透明常量），所以拖滑杆只影响主区域。 */
      const paintVeil = () => {
        if (tokenLayer !== null) { tokenLayer(); tokenLayer = null }
        if (imageUrl === null) return
        const theme = ctx.get('theme')
        if (theme === undefined) return
        tokenLayer = theme.overrideTokens('dsh-wallpaper', {
          '--dsw-alias-bg-base': { light: rgba(BASE_LIGHT), dark: rgba(BASE_DARK) },
          '--dsw-specific-sidebar-fill': { light: SIDE_SOLID_LIGHT, dark: SIDE_SOLID_DARK }
        })
      }

      const paint = () => { paintImage(); paintVeil() }

      ctx.effect(() => () => {
        if (imageCss !== null) { imageCss(); imageCss = null }
        if (tokenLayer !== null) { tokenLayer(); tokenLayer = null }
      })

      const save = (payload) => {
        fetch(SAVE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).then((response) => response.json().then(
          (body) => ({ ok: response.ok, body }),
          () => ({ ok: false, body: null })
        )).then((result) => {
          if (result.ok && result.body !== null && typeof result.body === 'object' && result.body.ok === true) {
            persistState = 'ok'
            persistDetail = typeof result.body.path === 'string' ? result.body.path : ''
          } else {
            persistState = 'off'
            persistDetail = result.body !== null && typeof result.body === 'object' && typeof result.body.reason === 'string'
              ? result.body.reason
              : '写入失败'
          }
          notify()
        }).catch(() => {
          persistState = 'off'
          persistDetail = '宿主未响应'
          notify()
        })
      }

      const persistNow = () => save({
        url: imageUrl,
        name: fileName,
        size: storedBytes,
        sourceSize: sourceBytes,
        veil: veil
      })

      const applyImage = (url, name, size, source) => {
        imageUrl = url
        fileName = name
        storedBytes = size
        sourceBytes = source
        paint()
        notify()
        persistNow()
      }

      const resetImage = () => {
        imageUrl = null
        fileName = ''
        storedBytes = 0
        sourceBytes = 0
        paint()
        notify()
        persistNow()
      }

      const setVeil = (value) => {
        veil = clampVeil(value)
        if (imageUrl !== null) paintVeil()
        notify()
      }

      /* 绘制前、存储前都先缩放：一张大图同时是绘制开销和持久化体积。
         已经够小且是 Web 原生格式的文件保持原样。 */
      const prepare = (file, done) => {
        const reader = new FileReader()
        reader.onerror = () => done(null, '读取失败')
        reader.onload = () => {
          const original = typeof reader.result === 'string' ? reader.result : ''
          if (original === '' || original.indexOf('data:image/') !== 0) {
            done(null, '图片数据无法解析')
            return
          }
          const size = typeof file.size === 'number' ? file.size : 0
          const probe = document.createElement('img')
          probe.onerror = () => done(null, '图片无法解码')
          probe.onload = () => {
            const w = probe.naturalWidth || probe.width || 0
            const h = probe.naturalHeight || probe.height || 0
            const edge = Math.max(w, h)
            if (edge === 0) { done(original, null); return }
            if (edge <= IMAGE_MAX_EDGE && size <= KEEP_ORIGINAL_BYTES) { done(original, null); return }
            const scale = Math.min(1, IMAGE_MAX_EDGE / edge)
            const nw = Math.max(1, Math.round(w * scale))
            const nh = Math.max(1, Math.round(h * scale))
            let encoded = ''
            try {
              const canvas = document.createElement('canvas')
              canvas.width = nw
              canvas.height = nh
              const graphics = canvas.getContext('2d')
              if (graphics === null) { done(original, null); return }
              graphics.drawImage(probe, 0, 0, nw, nh)
              encoded = canvas.toDataURL('image/webp', 0.86)
              if (encoded.indexOf('data:image/webp') !== 0) encoded = canvas.toDataURL('image/jpeg', 0.86)
            } catch (error) { encoded = '' }
            done(encoded.indexOf('data:image/') === 0 ? encoded : original, null)
          }
          probe.src = original
        }
        reader.readAsDataURL(file)
      }

      const useTick = () => {
        const [, setTick] = React.useState(0)
        React.useEffect(() => {
          const listener = () => setTick((n) => n + 1)
          watchers.add(listener)
          return () => { watchers.delete(listener) }
        }, [])
      }

      function Panel() {
        useTick()
        const [status, setStatus] = React.useState('')
        const [failed, setFailed] = React.useState(false)
        const [busy, setBusy] = React.useState(false)

        const pick = (event) => {
          const input = event.target
          const file = input.files !== null && input.files.length > 0 ? input.files[0] : null
          input.value = ''
          if (file === null) return
          const kind = typeof file.type === 'string' ? file.type : ''
          if (kind !== '' && kind.indexOf('image/') !== 0) {
            setBusy(false)
            setFailed(true)
            setStatus('这个文件不是图片，请选择 png / jpg / webp / gif。')
            return
          }
          setBusy(true)
          setFailed(false)
          setStatus('正在处理图片…')
          prepare(file, (url, error) => {
            if (url === null) {
              setBusy(false)
              setFailed(true)
              setStatus(error + '，请换一张重试。')
              return
            }
            const name = typeof file.name === 'string' ? file.name : '图片'
            const source = typeof file.size === 'number' ? file.size : 0
            applyImage(url, name, dataBytes(url), source)
            setBusy(false)
            setFailed(false)
            setStatus('已应用新底图并保存。')
          })
        }

        const hasImage = imageUrl !== null
        const previewStyle = hasImage ? { backgroundImage: 'url("' + imageUrl + '")' } : null
        const compressed = hasImage && storedBytes > 0 && sourceBytes > storedBytes * 1.05
        const meta = hasImage
          ? '当前：' + fileName + (storedBytes > 0 ? '（' + bytesText(storedBytes) + '）' : '')
            + (compressed ? ' · 已从 ' + bytesText(sourceBytes) + ' 压缩' : '')
          : '未设置自定义底图'
        const persistText = persistState === 'loading'
          ? '持久化：正在读取已保存的底图…'
          : persistState === 'ok'
            ? '持久化：已保存' + (persistDetail !== '' ? '（' + persistDetail + '）' : '') + '，刷新与重启后自动恢复'
            : '持久化不可用' + (persistDetail !== '' ? '：' + persistDetail : '') + '（本次仅在当前页面有效）'

        return React.createElement('div', { className: 'dwp-page' },
          React.createElement('h2', { className: 'dwp-h' }, '背景底图'),
          React.createElement('p', { className: 'dwp-p' },
            '选择一张本地图片作为 DSH 的背景底图，图片会保存，刷新页面或重启 DSH 后自动恢复。'
            + '图片铺在界面最底层，上面叠加半透明遮罩以保证文字可读；点「恢复默认空白底图」清空自定义底图。'),
          React.createElement('div', { className: 'dwp-preview', style: previewStyle },
            hasImage ? null : React.createElement('span', null, '当前使用默认空白底图')),
          React.createElement('div', { className: 'dwp-row' },
            React.createElement('label', { className: 'dwp-btn dwp-btn-main' },
              busy ? '处理中…' : (hasImage ? '更换图片' : '选择图片'),
              React.createElement('input', {
                className: 'dwp-file',
                type: 'file',
                accept: 'image/*',
                disabled: busy,
                onChange: pick
              })),
            React.createElement('button', {
              type: 'button',
              className: 'dwp-btn',
              disabled: !hasImage,
              onClick: resetImage
            }, '恢复默认空白底图')),
          React.createElement('div', { className: 'dwp-slider' },
            React.createElement('span', { className: 'dwp-cap' }, '遮罩强度'),
            React.createElement('input', {
              className: 'dwp-range',
              type: 'range',
              min: VEIL_MIN,
              max: VEIL_MAX,
              step: 0.01,
              value: veil,
              disabled: !hasImage,
              onChange: (event) => setVeil(event.target.value),
              onPointerUp: persistNow,
              onKeyUp: persistNow,
              onBlur: persistNow
            }),
            React.createElement('span', { className: 'dwp-cap' }, Math.round(veil * 100) + '%')),
          React.createElement('div', { className: 'dwp-meta' }, meta),
          React.createElement('div', { className: 'dwp-meta' }, persistText),
          React.createElement('div', { className: failed ? 'dwp-status dwp-err' : 'dwp-status' }, status)
        )
      }

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'wallpaper',
        order: 25,
        label: '背景底图'
      }, Panel))

      /* 读回已保存的底图；设置页读的是同一份内存状态。 */
      fetch(STATE_URL, { cache: 'no-store' }).then((response) => response.json().then(
        (body) => ({ ok: response.ok, body }),
        () => ({ ok: false, body: null })
      )).then((result) => {
        if (!result.ok || result.body === null || typeof result.body !== 'object' || result.body.ok !== true) {
          persistState = 'off'
          persistDetail = result.body !== null && typeof result.body === 'object' && typeof result.body.reason === 'string'
            ? result.body.reason
            : '宿主未响应'
          notify()
          return
        }
        persistState = 'ok'
        persistDetail = typeof result.body.path === 'string' ? result.body.path : ''
        const value = result.body.value
        if (value === null || typeof value !== 'object') { notify(); return }
        if (typeof value.veil === 'number') veil = clampVeil(value.veil)
        const url = typeof value.url === 'string' && value.url.indexOf('data:image/') === 0 ? value.url : null
        if (url !== null) {
          imageUrl = url
          fileName = typeof value.name === 'string' && value.name !== '' ? value.name : '已保存的底图'
          storedBytes = typeof value.size === 'number' && value.size > 0 ? value.size : dataBytes(url)
          sourceBytes = typeof value.sourceSize === 'number' ? value.sourceSize : 0
          paint()
        }
        notify()
      }).catch(() => {
        persistState = 'off'
        persistDetail = '宿主未响应'
        notify()
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  }
})
