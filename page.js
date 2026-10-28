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
  <textarea id="note" placeholder="这块是什么问题"></textarea>
  <button id="send" disabled>发到会话</button>
  <span id="status">连接中</span>
</div>
<div id="hint">按住拖一个框；松手后画面定住，可以补一句说明再发。</div>
<script>
(function () {
  var ROUTE = '/dsh-mobile-use'
  var params = new URLSearchParams(location.search)
  var serial = params.get('serial') || ''
  var session = params.get('session') || localStorage.getItem('adb-session') || ''
  if (session !== '') localStorage.setItem('adb-session', session)

  var video = document.getElementById('video')
  var canvas = document.getElementById('canvas')
  var note = document.getElementById('note')
  var mark = document.getElementById('mark')
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

  function resetSource() {
    queue = []
    appending = false
    sourceBuffer = null
    mediaSource = null
    if (objectUrl !== '') { URL.revokeObjectURL(objectUrl); objectUrl = '' }
    try { video.removeAttribute('src'); video.load() } catch (error) { /* 忽略 */ }
  }

  /* 现场计数：出问题时能直接看出是没收帧、没入队，还是 append 一直失败。 */
  var stats = { meta: 0, init: 0, media: 0, end: 0, appends: 0, appendErr: '', dropped: 0, queueMax: 0 }
  window.__adbm = stats

  function appendNext() {
    if (sourceBuffer === null || appending || queue.length === 0) return
    if (mediaSource && mediaSource.readyState !== 'open') return
    if (sourceBuffer.updating) return
    appending = true
    try { sourceBuffer.appendBuffer(queue.shift()); stats.appends += 1 } catch (error) { appending = false; stats.appendErr = String(error && error.name) + ':' + String(error && error.message).slice(0, 60) }
  }

  function attachSource() {
    if (mediaSource === null || sourceBuffer !== null || codec === '') return
    /* 只传裸 codec 会 NotSupportedError：Chrome 认的是完整 MIME，两种写法都试一遍。 */
    try { sourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="' + codec + '"') }
    catch (error) {
      try { sourceBuffer = mediaSource.addSourceBuffer(codec) } catch (second) { startPolling(); return }
    }
    sourceBuffer.mode = 'segments'
    sourceBuffer.addEventListener('updateend', function () {
      appending = false
      try {
        if (sourceBuffer && sourceBuffer.buffered.length > 0) {
          var end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1)
          var start = sourceBuffer.buffered.start(0)
          var lag = end - video.currentTime
          if (lag > 0.6) video.currentTime = Math.max(start, end - 0.06)
          else video.playbackRate = lag > 0.15 ? 1.25 : 1
          if (end - start > 8 && sourceBuffer.updating === false) sourceBuffer.remove(start, end - 4)
          stats.buf = [Math.round(start * 100) / 100, Math.round(end * 100) / 100, sourceBuffer.buffered.length]
        }
      } catch (error) { /* 边界状态 */ }
      appendNext()
    })
    appendNext()
  }

  function ensureSource() {
    if (mediaSource !== null || codec === '' || typeof window.MediaSource !== 'function') return
    try { mediaSource = new window.MediaSource() } catch (error) { startPolling(); return }
    objectUrl = URL.createObjectURL(mediaSource)
    video.src = objectUrl
    mediaSource.addEventListener('sourceopen', function () {
      /* 顺序不能反：先挂初始化段，再挂 sourceBuffer；反过来 attachSource 会先把
         sourceopen 之前排队的分片吐出去，解复用器拿不到 moov 就报 APPEND_FAILED。 */
      if (initPayload !== null) { queue = [initPayload].concat(queue); initPayload = null }
      attachSource()
      appendNext()
    })
  }

  function onFrame(type, payload) {
    if (type === 0) stats.meta += 1
    if (type === 1) stats.init += 1
    if (type === 2) { stats.media += 1; if (queue.length > stats.queueMax) stats.queueMax = queue.length }
    if (type === 3) stats.end += 1
    if (type === 0) {
      try {
        var info = JSON.parse(new TextDecoder().decode(payload))
        if (info && info.codec) codec = String(info.codec)
        if (info && info.width) screen = { w: Number(info.width), h: Number(info.height) }
      } catch (error) { /* 坏 meta 忽略 */ }
      ensureSource()
      return
    }
    if (type === 1) { initPayload = payload; resetSource(); ensureSource(); return }
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
        var reader = res.body.getReader()
        var buf = new Uint8Array(0)
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

  /* ---- 点击 → 设备坐标 ---- */
  video.addEventListener('click', function (event) {
    if (marking) return
    var box = video.getBoundingClientRect()
    var w = screen.w || video.videoWidth
    var h = screen.h || video.videoHeight
    if (!w || !h) return
    var x = Math.round((event.clientX - box.left) / box.width * w)
    var y = Math.round((event.clientY - box.top) / box.height * h)
    post('/tap', { serial: serial, x: x, y: y }).then(function (result) {
      say(result && result.ok ? ('已点 ' + x + ',' + y + ' · ' + (result.engine || '')) : '点击失败')
    })
  })

  /* ---- 圈选 ---- */
  mark.addEventListener('click', function () {
    marking = !marking
    mark.setAttribute('aria-pressed', marking ? 'true' : 'false')
    hint.classList.toggle('on', marking)
    canvas.classList.toggle('on', marking)
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
      note: note.value,
      rect: rect,
      frozen_ms: frozenMs,
    }
    if (frozenImage !== '') body.png = frozenImage.slice(frozenImage.indexOf(',') + 1)
    post('/annotate', body).then(function (result) {
      if (result && result.ok) {
        say('已发到会话')
        note.value = ''
        rect = null
        marking = false
        mark.setAttribute('aria-pressed', 'false')
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
