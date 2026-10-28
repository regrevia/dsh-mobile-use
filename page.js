/**
 * 独立调试页：任何浏览器打开 /dsh-mobile-use/ 就能看画面、点按、圈选标注。
 *
 * 只做三件事：接 /stream 播分片 MP4（失败退 /frame 抓帧）、把点击换算成设备坐标打
 * /tap、把圈选区域连同说明发到 /annotate（宿主再拼进会话里给 agent 看）。
 * 页面自己不持有任何定时器以外的状态；所有 fetch 失败只更新状态行，不抛到顶层。
 */

/** 页面 HTML。刻意不引任何外部资源：离线、无 CSP 例外、无第三方脚本。 */
export const PLAYER_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>设备画面</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #0b0d10; color: #e6e8eb;
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif; }
  body { display: flex; flex-direction: column; }
  #stage { position: relative; flex: 1 1 auto; min-height: 0; display: flex;
    align-items: center; justify-content: center; overflow: hidden; }
  #video { max-width: 100%; max-height: 100%; display: block; background: #000; }
  #canvas { position: absolute; inset: 0; width: 100%; height: 100%; cursor: crosshair;
    touch-action: none; display: none; }
  #canvas.on { display: block; }
  #bar { flex: 0 0 auto; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
    padding: 8px 10px; border-top: 1px solid #1d222b; background: #11151b; }
  button { font: inherit; padding: 6px 10px; border-radius: 6px; border: 1px solid #2a313d;
    background: #1a2029; color: #e6e8eb; cursor: pointer; }
  button[aria-pressed="true"] { background: #2b6cff; border-color: #2b6cff; color: #fff; }
  button:disabled { opacity: .45; cursor: default; }
  input, textarea { font: inherit; background: #0e1218; color: #e6e8eb;
    border: 1px solid #2a313d; border-radius: 6px; padding: 6px 8px; }
  textarea { flex: 1 1 220px; min-height: 32px; max-height: 96px; resize: vertical; }
  #status { flex: 1 1 240px; color: #8b95a4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #hint { padding: 6px 10px; color: #8b95a4; border-top: 1px solid #1d222b; display: none; }
  #hint.on { display: block; }
</style>
</head>
<body>
<div id="stage">
  <video id="video" muted autoplay playsinline></video>
  <canvas id="canvas"></canvas>
</div>
<div id="bar">
  <button id="mark" aria-pressed="false" title="拖一个框，把这块发给会话">圈选</button>
  <button id="send" disabled>发到对话</button>
  <span id="status">连接中</span>
</div>
<div id="hint" class="on">点一下＝点按，按住拖动＝滑动，滚轮＝上下滑。</div>
<script>
(function () {
  var ROUTE = '/dsh-mobile-use'
  var params = new URLSearchParams(location.search)
  var serial = params.get('serial') || ''
  var session = params.get('session') || localStorage.getItem('adb-session') || ''
  if (session !== '') localStorage.setItem('adb-session', session)

  var stage = document.getElementById('stage')
  var video = document.getElementById('video')
  var canvas = document.getElementById('canvas')
  var markBtn = document.getElementById('mark')
  var send = document.getElementById('send')
  var status = document.getElementById('status')
  var hint = document.getElementById('hint')

  var screen = { w: 0, h: 0 }
  var frameAt = 0
  var wantFrozen = false
  var rect = null
  var drag = null
  var frozenImage = ''
  var frozenMs = 0
  var marking = false

  var say = function (text) { status.textContent = text }

  function post(path, body) {
    return fetch(ROUTE + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) { return res.json() }).catch(function (error) {
      say('请求失败：' + String(error && error.message || error))
      return { ok: false }
    })
  }

  function refreshState() {
    fetch(ROUTE + '/state?serial=' + encodeURIComponent(serial), { cache: 'no-store' })
      .then(function (res) { return res.json() })
      .then(function (info) {
        if (info && info.screen) screen = { w: Number(info.screen.w) || 0, h: Number(info.screen.h) || 0 }
        if (info && info.serial && serial === '') serial = info.serial
        if (session === '' && info && typeof info.want === 'string' && info.want !== '') {
          session = info.want
          localStorage.setItem('adb-session', session)
        }
        var stream = (info && info.stream) || null
        if (stream) {
          frameAt = Number(stream.lastAt) || 0
          var age = frameAt === 0 ? '' : (' · ' + Math.max(0, Math.round((Date.now() - frameAt) / 1000)) + 's前')
          say((stream.capture || '?') + ' · ' + (stream.frames || 0) + ' 帧' + age +
            (stream.fps ? (' · ' + stream.fps + ' fps') : '') + (serial ? (' · ' + serial) : ''))
        }
      })
      .catch(function () { /* 状态只是装饰，失败不打断播放 */ })
  }
  var stateTimer = setInterval(refreshState, 2000)
  refreshState()

  /* ---- 直播：MediaSource 收 fMP4；不行就退成抓帧 ---- */
  var liveStopped = false
  var mediaSource = null
  var sourceBuffer = null
  var queue = []
  var appending = false
  var codec = ''
  var initPayload = null
  var objectUrl = ''

  /* 现场事件环：只在出问题时才需要，所以只留最近 12 条、不参与热路径。 */
  function mark(what) {
    stats.events = (stats.events || []).concat([[Math.round(performance.now()), what, mediaSource ? mediaSource.readyState : 'null', video.buffered.length ? +video.buffered.end(video.buffered.length - 1).toFixed(2) : 0]]).slice(-40)
  }

  /* 初始化段是不是同一份：采集链路重发、或观众重连补发时会重复给，字节一样就没有重建的必要。 */
  function sameBytes(a, b) {
    if (a === null || b === null || a.length !== b.length) return false
    for (var i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
    return true
  }

  function resetSource() {
    mark('reset')
    stats.resets = (stats.resets || 0) + 1
    queue = []
    appending = false
    sourceBuffer = null
    mediaSource = null
    if (objectUrl !== '') { URL.revokeObjectURL(objectUrl); objectUrl = '' }
    try { video.removeAttribute('src'); video.load() } catch (error) { /* 忽略 */ }
  }

  /* 现场计数：出问题时能直接看出是没收帧、没入队，还是 append 一直失败。 */
  var stats = { meta: 0, init: 0, media: 0, end: 0, appends: 0, appendErr: '', dropped: 0, queueMax: 0, stalls: 0, connects: 0 }
  /* 卡死判定用的进度探针（秒级，不参与热路径）。 */
  var currentReader = null
  var lastAppendAt = Date.now()
  var lastTimeSeen = -1
  var lastTimeAt = Date.now()
  var connectedAt = 0
  /* 收到 META 的时间：META 到了却一直没有 INIT，说明宿主那边采集链路死了，光等没用。 */
  var metaAt = 0
  window.__adbm = stats

  function appendNext() {
    if (sourceBuffer === null || appending || queue.length === 0) return
    if (mediaSource && mediaSource.readyState !== 'open') return
    if (sourceBuffer.updating) return
    appending = true
    var chunk = queue.shift()
    var len = chunk && chunk.byteLength ? chunk.byteLength : 0
    stats.appendBytes = (stats.appendBytes || 0) + len
    if (stats.appends < 3) mark('ap' + String(stats.appends) + ':' + String(len))
    try { sourceBuffer.appendBuffer(chunk); stats.appends += 1 } catch (error) { appending = false; stats.appendErr = String(error && error.name) + ':' + String(error && error.message).slice(0, 60) }
  }

  function attachSource() {
    if (mediaSource === null || sourceBuffer !== null || codec === '') return
    /* 只传裸 codec 会 NotSupportedError：Chrome 认的是完整 MIME，两种写法都试一遍。 */
    try { sourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="' + codec + '"') }
    catch (error) {
      try { sourceBuffer = mediaSource.addSourceBuffer(codec) } catch (second) { startPolling(); return }
    }
    mark('attach')
    sourceBuffer.mode = 'segments'
    sourceBuffer.addEventListener('error', function () { stats.appendErr = 'sb-error' })
    sourceBuffer.addEventListener('updateend', function () {
      appending = false
      lastAppendAt = Date.now()
      try {
        if (sourceBuffer && sourceBuffer.buffered.length > 0) {
          var end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1)
          var start = sourceBuffer.buffered.start(0)
          var lag = end - video.currentTime
          if (lag > 0.45) video.currentTime = Math.max(start, end - 0.06)
          else video.playbackRate = lag > 0.12 ? 1.2 : 1
          tryPlay()
          if (end - start > 8 && sourceBuffer.updating === false) sourceBuffer.remove(start, end - 4)
          stats.buf = [Math.round(start * 100) / 100, Math.round(end * 100) / 100, sourceBuffer.buffered.length]
          stats.elBuf = video.buffered.length
          stats.msState = mediaSource ? mediaSource.readyState : 'null'
        } else if (stats.appends < 6) { mark('nb' + String(stats.appends))
        }
      } catch (error) { /* 边界状态 */ }
      appendNext()
    })
    appendNext()
  }

  /* 自动播放不是到处都成立（无声视频多数浏览器放行，但策略变了、或页面被当成弹窗时会被拦）：
     主动 play 一次，被拦了就把「点一下开始播放」露出来，别让用户对着黑屏猜。 */
  function tryPlay() {
    if (video.paused === false) return
    var result = video.play()
    if (result && typeof result.catch === 'function') {
      result.catch(function () { hint.textContent = '点一下画面开始播放'; hint.classList.add('on') })
    }
  }

  function ensureSource() {
    if (mediaSource !== null) { mark('ensure-skip'); return }
    if (codec === '' || typeof window.MediaSource !== 'function') return
    var created = null
    try { created = new window.MediaSource(); stats.ms = (stats.ms || 0) + 1 } catch (error) { startPolling(); return }
    mediaSource = created
    mark('ensure-new')
    objectUrl = URL.createObjectURL(created)
    /* MediaSource 要有 element 的 src 指向它才会 open，所以 src 不能等 sourceopen。
       竞态用下面的引用比较挡住：旧实例的 sourceopen 晚到时不会再挂到新实例上。 */
    try { video.src = objectUrl } catch (error) { reportError('assign-src', error) }
    tryPlay()
    /* 只在「这个 MediaSource 还是当前那个」时才挂 src 和 sourceBuffer：
       初始化段来得快时旧实例的 sourceopen 会晚到，挂错了就是 buffer 一直空、画面全黑。 */
    created.addEventListener('sourceopen', function () {
      if (mediaSource !== created) { mark('open-stale'); return }
      mark('open')
      /* 顺序不能反：先挂初始化段，再挂 sourceBuffer；反过来 attachSource 会先把
         sourceopen 之前排队的分片吐出去，解复用器拿不到 moov 就报 APPEND_FAILED。 */
      if (initPayload !== null) { queue = [initPayload].concat(queue); initPayload = null }
      attachSource()
      appendNext()
    })
  }

  function onFrame(type, payload) {
    if (type === 0) { stats.meta += 1; metaAt = Date.now() }
    if (type === 1) stats.init += 1
    if (type === 2) { stats.media += 1; if (queue.length > stats.queueMax) stats.queueMax = queue.length }
    if (type === 3) stats.end += 1
    if (type === 0) {
      try {
        var info = JSON.parse(new TextDecoder().decode(payload))
        if (info && info.codec) codec = String(info.codec)
        if (info && info.width) screen = { w: Number(info.width), h: Number(info.height) }
      } catch (error) { /* 坏 meta 忽略 */ }
      try { ensureSource() } catch (error) { reportError('ensureSource', error) }
      return
    }
    if (type === 1) {
      metaAt = 0
      /* 同一份初始化段重发（重连补发、链路重试）不该把已经在播的画面清掉：
         之前每次都重建 MediaSource，观众看到的就是每隔几秒黑一下。 */
      var playing = mediaSource !== null && mediaSource.readyState === 'open' && video.buffered.length > 0
      var dup = sameBytes(initPayload, payload) && playing
      initPayload = payload
      if (dup) { mark('init-dup'); stats.dups = (stats.dups || 0) + 1; return }
      if (!playing) {
        /* 还没出画面：直接在现有 MediaSource 上换初始化段。重建会把 sourceopen/attach
           再来一遍，冷启动时就成了每两秒黑一次的循环。 */
        mark('init-replace')
        stats.replaced = (stats.replaced || 0) + 1
        queue = []
        if (sourceBuffer !== null) { queue.push(payload); appendNext() }
        else { try { ensureSource() } catch (error) { reportError('ensureSource.init', error) } }
        return
      }
      resetSource()
      try { ensureSource() } catch (error) { reportError('ensureSource.init', error) }
      return
    }
    if (type === 2) {
      queue.push(payload)
      if (queue.length > 60) { queue = queue.slice(-8); stats.dropped += 1 }
      appendNext()
      return
    }
    if (type === 3) resetSource()
  }

  function readStream() {
    if (liveStopped) return Promise.resolve()
    return fetch(ROUTE + '/stream?serial=' + encodeURIComponent(serial) + '&t=' + Date.now(), { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok || !res.body) throw new Error('stream ' + res.status)
        stats.connects += 1
        var reader = res.body.getReader()
        var buf = new Uint8Array(0)
        /* 只记下当前 reader，卡死判定交给 stallTick：静止画面本来就不出帧，
           「N 秒没字节」会把正常空闲当成故障，之前那版这样做过，结果每 3 秒重连一次。 */
        currentReader = reader
        connectedAt = Date.now()
        function step() {
          return reader.read().then(function (part) {
            if (part.done) return null
            var value = part.value
            /* 追加只拷贝一次、解析用游标：一帧 1 MB 时按帧 slice 是 O(n²)，
               页面之前就是这样追不上、积压被断开、重连后又从头补同一个 GOP，永远卡死。 */
            if (buf.length === 0) { buf = value } else {
              var merged = new Uint8Array(buf.length + value.length)
              merged.set(buf)
              merged.set(value, buf.length)
              buf = merged
            }
            var off = 0
            while (buf.length - off >= 5) {
              var len = buf[off + 1] * 16777216 + (buf[off + 2] << 16) + (buf[off + 3] << 8) + buf[off + 4]
              if (buf.length - off < 5 + len) break
              onFrame(buf[off], buf.subarray(off + 5, off + 5 + len))
              off += 5 + len
            }
            if (off > 0) buf = buf.subarray(off)
            return step()
          })
        }
        return step()
      })
  }

  function pumpStream() {
    readStream().catch(function () { /* 断流走重连 */ }).then(function () {
      if (liveStopped) return
      setTimeout(pumpStream, 400)
    })
  }

  /* ---- 退路：抓帧轮询（MSE 不可用或流一直没来）---- */
  var polling = false
  var pollTimer = null
  function startPolling() {
    if (polling) return
    polling = true
    resetSource()
    var tick = function () {
      if (liveStopped) return
      var img = new Image()
      img.onload = function () {
        var box = video.getBoundingClientRect()
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        video.style.visibility = 'hidden'
        canvas.classList.add('on')
        var ctx = canvas.getContext('2d')
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(img, 0, 0)
        drawRect(ctx, box)
        frameAt = Date.now()
      }
      img.onerror = function () { /* 下一拍再试 */ }
      img.src = ROUTE + '/frame?serial=' + encodeURIComponent(serial) + '&t=' + Date.now()
      pollTimer = setTimeout(tick, 250)
    }
    tick()
  }

  function drawRect(ctx, box) {
    if (rect === null) return
    if (!ctx) return
    var sx = canvas.width / Math.max(1, screen.w)
    var sy = canvas.height / Math.max(1, screen.h)
    ctx.save()
    ctx.strokeStyle = '#2b6cff'
    ctx.lineWidth = Math.max(2, canvas.width / 400)
    ctx.strokeRect(rect.x * sx, rect.y * sy, rect.w * sx, rect.h * sy)
    ctx.restore()
  }

  pumpStream()

  /* 页面自身的异常也上报：黑屏时先看这里，不要靠猜。 */
  function report(body) {
    try {
      fetch(ROUTE + '/diag', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ pid: 'player' }, body)),
      }).catch(function () { /* 诊断上报失败不影响操作 */ })
    } catch (error) { /* 诊断不影响操作 */ }
  }

  function reportError(where, error) {
    try {
      fetch(ROUTE + '/diag', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pid: 'player', error: where + ': ' + String(error && (error.stack || error.message || error)) .slice(0, 400) }),
      }).catch(function () { /* 上报失败不影响播放 */ })
    } catch (e) { /* 同上 */ }
  }
  window.addEventListener('error', function (event) { reportError('error', event.error || event.message) })
  window.addEventListener('unhandledrejection', function (event) { reportError('reject', event.reason) })

  /* 现场上报：没有 CDP 也能从宿主 /diag 看到这一页实际收到了什么。 */
  setInterval(function () {
    try {
      fetch(ROUTE + '/diag', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pid: 'player', stream: { meta: stats.meta, init: stats.init, media: stats.media, appends: stats.appends, stalls: stats.stalls, connects: stats.connects, ct: video.currentTime, rs: video.readyState, elBuf: video.buffered.length, paused: video.paused, end: video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1) : 0, start: video.buffered.length > 0 ? video.buffered.start(0) : 0, ms: mediaSource ? mediaSource.readyState : 'null', q: queue.length, err: stats.appendErr, buf: stats.buf || null, ev: stats.events || null } }),
      }).catch(function () { /* 上报失败不影响播放 */ })
    } catch (error) { /* 同上 */ }
  }, 3000)

  function armReconnect() {
    try { if (currentReader !== null) { const reader = currentReader; currentReader = null; reader.cancel().catch(function () {}) } } catch (error) { /* 已断 */ }
  }

  /* 三种「看着像崩了」的卡死各给一条出路：追加链停、播放时间停、连接半死。
     判定必须排除静止画面（本来就不出帧），所以只看「有数据却不动」。 */
  setInterval(function () {
    try {
      if (liveStopped) return
      var now = Date.now()
      var t = video.currentTime
      if (t !== lastTimeSeen) { lastTimeSeen = t; lastTimeAt = now }
      /* 连上了却连 META 都没收到：冷启动时 stream 还没就绪，连接会一直空转。 */
      if (stats.meta === 0 && connectedAt > 0 && now - connectedAt > 2500) { stats.stalls += 1; armReconnect(); connectedAt = 0; return }
      /* 有 META 没有 INIT：解码起点没来，画面必黑，重连比干等有用（宿主那边的看门狗会在这期间重建采集）。 */
      if (metaAt > 0 && now - metaAt > 14000) { stats.stalls += 1; metaAt = 0; armReconnect(); return }
      if (queue.length > 4 && now - lastAppendAt > 2000) { stats.stalls += 1; armReconnect(); return }
      var end = 0
      if (sourceBuffer !== null && sourceBuffer.buffered.length > 0) end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1)
      if (end > 0 && video.paused === false && video.readyState >= 3 && now - lastTimeAt > 2500) {
        if (end - t > 0.3) { video.currentTime = Math.max(0, end - 0.06); lastTimeAt = now }
        else { stats.stalls += 1; armReconnect() }
      }
    } catch (error) { /* 诊断不能抛 */ }
  }, 1000)

  /* 宿主升级后这一页可能还是旧代码：每 30 秒对一次版本，不一致就自己重载。
     长期开着的侧栏不用人记得刷新。 */
  setInterval(function () {
    try {
      if (liveStopped) return
      var mine = String(window.__ADBM_PAGE_BUILD || '')
      if (mine === '') return
      fetch(ROUTE + '/state?t=' + Date.now(), { cache: 'no-store' }).then(function (res) { return res.ok ? res.json() : null }).then(function (state) {
        var host = String((state && state.build) || '')
        if (host !== '' && host !== mine) window.location.reload()
      }).catch(function () {})
    } catch (error) { /* 对版本失败不打扰画面 */ }
  }, 30000)

  /* 侧栏这一页会被长期开着：解码器、缓冲、连接残留只会越攒越多。
     六小时自己重载一次，断的是这一页，采集链路几十毫秒就接回来。 */
  setTimeout(function () {
    try { window.location.reload() } catch (error) { /* 下次打开再说 */ }
  }, 6 * 3600 * 1000)

  /* ---- 鼠标直操作：点=点按，拖=滑动，按住=长按，滚轮=上下滑 ---- */
  function devicePoint(event) {
    var box = video.getBoundingClientRect()
    var w = screen.w || video.videoWidth
    var h = screen.h || video.videoHeight
    if (!w || !h || box.width < 8 || box.height < 8) return null
    var x = Math.round((event.clientX - box.left) / box.width * w)
    var y = Math.round((event.clientY - box.top) / box.height * h)
    return { x: Math.max(0, Math.min(w - 1, x)), y: Math.max(0, Math.min(h - 1, y)) }
  }

  var press = null
  function onDown(event) {
    try { report({ event: 'input', phase: 'down', mode: marking ? 'mark' : 'tap', button: event.button, serial: serial }) } catch (error) { /* 诊断不影响操作 */ }
    if (marking || event.button !== 0) return
    var at = devicePoint(event)
    if (at === null) return
    try { stage.setPointerCapture(event.pointerId) } catch (error) { /* 拿不到指针也能用 */ }
    hint.classList.remove('on')
    press = { at: at, x: event.clientX, y: event.clientY, t: Date.now(), track: [at], moved: false }
  }
  function onMove(event) {
    if (press === null) return
    if (!press.moved && Math.abs(event.clientX - press.x) + Math.abs(event.clientY - press.y) > 6) press.moved = true
    if (!press.moved) return
    var at = devicePoint(event)
    if (at !== null) press.track.push(at)
  }
  function onUp(event) {
    if (press === null) return
    var held = press
    press = null
    var ms = Date.now() - held.t
    if (!held.moved) {
      /* 按住不放再松手是长按，快速按一下是点按。 */
      if (ms >= 550) {
        post('/gesture', { serial: serial, tracks: [[held.at]], ms: Math.min(1200, ms) }).then(function () {
          say('长按 ' + held.at.x + ',' + held.at.y)
        })
        return
      }
      post('/tap', { serial: serial, x: held.at.x, y: held.at.y }).then(function (result) {
        try { report({ event: 'input', phase: 'up', kind: 'tap', x: held.at.x, y: held.at.y, ok: result && result.ok === true, reason: result && result.reason, engine: result && result.engine }) } catch (error) { /* 诊断不影响操作 */ }
        say(result && result.ok ? ('点 ' + held.at.x + ',' + held.at.y) : '点击失败')
      })
      return
    }
    var at = devicePoint(event)
    if (at !== null) held.track.push(at)
    var track = held.track.filter(function (point, index) {
      return index === 0 || index === held.track.length - 1 || index % 3 === 0
    })
    post('/gesture', { serial: serial, tracks: [track], ms: Math.max(80, Math.min(1200, ms)) }).then(function (result) {
      say(result && result.ok ? ('滑动 ' + track.length + ' 点') : '滑动失败')
    })
  }
  function onWheel(event) {
    if (marking) return
    event.preventDefault()
    var at = devicePoint(event) || { x: Math.round((screen.w || 1080) / 2), y: Math.round((screen.h || 1920) / 2) }
    var dy = Math.round(Math.max(-1200, Math.min(1200, event.deltaY * 4)))
    if (dy === 0) return
    post('/scroll', { serial: serial, x: at.x, y: at.y, dy: dy }).catch(function () { /* 滚动失败不刷状态 */ })
  }
  stage.addEventListener('pointerdown', onDown)
  stage.addEventListener('pointermove', onMove)
  stage.addEventListener('pointerup', onUp)
  stage.addEventListener('pointercancel', function () { press = null })
  stage.addEventListener('wheel', onWheel, { passive: false })

  /* ---- 圈选 ---- */
  markBtn.addEventListener('click', function () {
    marking = !marking
    markBtn.setAttribute('aria-pressed', marking ? 'true' : 'false')
    hint.classList.toggle('on', marking)
    canvas.classList.toggle('on', marking)
    hint.textContent = marking
      ? '按住拖一个框，松手后画面定住；点「发到对话」把这一块连同坐标、控件、操作时间线发给会话。'
      : '点一下＝点按，按住拖动＝滑动，滚轮＝上下滑。'
    if (marking) {
      var box = video.getBoundingClientRect()
      canvas.width = video.videoWidth || Math.round(box.width)
      canvas.height = video.videoHeight || Math.round(box.height)
      var ctx = canvas.getContext('2d')
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      send.disabled = true
    } else {
      rect = null
    }
  })

  function pointAt(event) {
    var box = canvas.getBoundingClientRect()
    var px = (event.clientX - box.left) / box.width
    var py = (event.clientY - box.top) / box.height
    return { x: Math.max(0, Math.min(1, px)), y: Math.max(0, Math.min(1, py)) }
  }

  canvas.addEventListener('pointerdown', function (event) {
    if (!marking) return
    canvas.setPointerCapture(event.pointerId)
    drag = pointAt(event)
    rect = null
  })

  canvas.addEventListener('pointermove', function (event) {
    if (!marking || drag === null) return
    var now = pointAt(event)
    var ctx = canvas.getContext('2d')
    try { video.pause() } catch (error) { /* 无所谓 */ }
    var parent = canvas.parentNode
    var img = video
    ctx.save()
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    try { ctx.drawImage(img, 0, 0, canvas.width, canvas.height) } catch (error) { /* 抓不到就只画框 */ }
    var x = Math.min(drag.x, now.x) * canvas.width
    var y = Math.min(drag.y, now.y) * canvas.height
    var w = Math.abs(now.x - drag.x) * canvas.width
    var h = Math.abs(now.y - drag.y) * canvas.height
    ctx.strokeStyle = '#2b6cff'
    ctx.lineWidth = Math.max(2, canvas.width / 400)
    ctx.fillStyle = 'rgba(43,108,255,.16)'
    ctx.fillRect(x, y, w, h)
    ctx.strokeRect(x, y, w, h)
    ctx.restore()
  })

  canvas.addEventListener('pointerup', function (event) {
    if (!marking || drag === null) return
    var now = pointAt(event)
    var dw = screen.w || canvas.width
    var dh = screen.h || canvas.height
    var x = Math.round(Math.min(drag.x, now.x) * dw)
    var y = Math.round(Math.min(drag.y, now.y) * dh)
    var w = Math.round(Math.abs(now.x - drag.x) * dw)
    var h = Math.round(Math.abs(now.y - drag.y) * dh)
    drag = null
    if (w < 6 || h < 6) { rect = null; send.disabled = true; return }
    rect = { x: x, y: y, w: w, h: h }
    frozenMs = frameAt === 0 ? 0 : Date.now() - frameAt
    try { frozenImage = canvas.toDataURL('image/png') } catch (error) { frozenImage = '' }
    send.disabled = false
    say('已圈选 ' + w + 'x' + h + ' @ ' + x + ',' + y)
  })

  send.addEventListener('click', function () {
    if (session === '') { say('这个页面不知道会话：在地址后加 ?session=…'); return }
    if (rect === null) { say('先拖一个框'); return }
    send.disabled = true
    say('发送中')
    var body = {
      session: session,
      serial: serial,
      note: '',
      rect: rect,
      frozen_ms: frozenMs,
    }
    if (frozenImage !== '') body.png = frozenImage.slice(frozenImage.indexOf(',') + 1)
    post('/annotate', body).then(function (result) {
      if (result && result.ok) {
        say('已发到会话')
        rect = null
        marking = false
        markBtn.setAttribute('aria-pressed', 'false')
        canvas.classList.remove('on')
        hint.classList.remove('on')
        try { video.play() } catch (error) { /* 无所谓 */ }
      } else {
        say('发送失败：' + String(result && result.reason || '未知'))
        send.disabled = false
      }
    })
  })

  window.addEventListener('beforeunload', function () {
    liveStopped = true
    clearInterval(stateTimer)
    if (pollTimer !== null) clearTimeout(pollTimer)
  })
})()
</script>
</body>
</html>
`
