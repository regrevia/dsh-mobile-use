/**
 * dsh-mobile-use · 实时ADB 的页面半边。
 *
 * 一栏给三种用法：
 *   · 看：设备画面按 4 帧/秒推过来，鼠标点一下就是真机上的点击，拖动就是滑动；
 *   · 说：在画面上圈一下，写一句话，「发送」把带圈的图连同圈内控件一起推回聊天；
 *   · 叫：agent 通过 adb_mirror 也能把这一栏叫出来，不用人去找。
 *
 * 画面、录制、标注落盘都在宿主那半边，这里只负责画出来和收集人的动作。
 */

/* 页面代码的版本号：宿主报的和这里不一致，说明页面还在跑旧模块，自己重载一次。
   必须和 client.rev 一致，selftest 会核对；不一致时页面只换一次就停，不来回重载。 */
window.__ADBM_BUILD = '178'

/* 同一个 bundle 被执行两次（HMR 重评 / 重复注入）时只注册一次：client-modules 对重复
   factory 会直接抛错，整条 web boot 就失败（2026-10-27 20:32 duplicate factory 事故）。
   注册本身若抛错则撤掉标记，让下一次还能重试。 */
if (window.__ADBM_LOADED__ !== true) {
  window.__ADBM_LOADED__ = true
  try {
    window.__ModuleLoader__.load({
  id: 'dsh-mobile-use',
  factory(load) {
    const React = load('react')
    const h = React.createElement

    const NS = 'adb-mirror'
    const KIND = 'adb-mirror' // ui-copy-ignore
    const ID = 'dsh-mobile-use'
    const SLOT = 'sidebar.right.pane.tab'
    const TITLE_SLOT = 'sidebar.right.pane.tab.title'
    const ROUTE = '/dsh-mobile-use' // ui-copy-ignore

    const DICT = {
      zh: {
        'type.label': '实时ADB',
        'type.hint': '手机画面同步显示，点一下就是点手机',
        'act.mark': '标注',
        'act.tap': '点按',
        'act.send': '发到对话',
        'act.clear': '清除',
        'act.recent': '最近画面',
        'empty.none': '没有连接设备，插上线就会自己出现',
        'empty.gone': '设备已断开，插回来自动恢复',
        'state.starting': '画面准备中',
        'state.sent': '已发到对话',
        'state.failed': '发送失败',
        'ph.text': '输入文字',
        'act.text': '输入',
        'act.fit': '适应',
        'key.back': '返回',
        'key.home': '主屏',
        'key.enter': '回车',
        'key.del': '删除',
        'key.tab': '制表',
        'state.sending': '发送中',
      },
      en: {
        'type.label': 'Live ADB',
        'type.hint': 'The phone screen, live; tap it to tap the phone',
        'act.mark': 'Mark',
        'act.tap': 'Tap',
        'act.send': 'Send to chat',
        'act.clear': 'Clear',
        'act.recent': 'Recent frames',
        'empty.none': 'No device connected; plug one in',
        'empty.gone': 'Device disconnected; plug it back in',
        'state.starting': 'Starting',
        'state.sent': 'Sent to chat',
        'state.failed': 'Send failed',
        'ph.text': 'Type text',
        'act.text': 'Type',
        'act.fit': 'Fit',
        'key.back': 'Back',
        'key.home': 'Home',
        'key.enter': 'Enter',
        'key.del': 'Del',
        'key.tab': 'Tab',
        'state.sending': 'Sending',
      },
    }
    const LANG = /^zh/i.test(typeof navigator === 'undefined' ? '' : navigator.language ?? '') ? 'zh' : 'en'
    const L = (key) => DICT[LANG][key] ?? key

    /* 诊断上报：只在 loopback 上写一行，用来确认「这一页、这一栏」到底有没有起来。 */
    const PID = (() => {
      try { return crypto.randomUUID().slice(0, 8) } catch { return String(Math.random()).slice(2, 10) }
    })()
    const report = (body) => {
      try {
        void fetch(`${ROUTE}/diag`, { // ui-copy-ignore
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pid: PID, build: String(window.__ADBM_BUILD ?? ''), ...body }),
        })
      } catch {}
    }

    const CSS = [
      '.adbm-body{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0;height:100%;gap:6px;padding:8px;background:var(--dsw-alias-bg-base)}',
      '.adbm-bar{flex:none;display:flex;align-items:center;flex-wrap:wrap;gap:6px;row-gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary);min-height:26px}',
      '.adbm-btn{font:inherit;font-size:12px;padding:2px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;cursor:pointer}',
      '.adbm-btn[data-on="1"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
      '.adbm-btn[disabled]{opacity:.45;cursor:default}',
  '.adbm-btn[data-primary="1"]{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-inverted)}',
  '.adbm-btn[data-primary="1"]:hover:not([disabled]){background:var(--dsw-alias-button-primary-hover);border-color:transparent}',
      '.adbm-said{flex:1 1 100%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}',
      '.adbm-stage{position:relative;flex:1 1 auto;min-width:0;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden}',
      '.adbm-frame{position:relative;flex:none;display:block;line-height:0;transform-origin:0 0}',
      '.adbm-keys{display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin-top:4px}',
      '.adbm-key{font:inherit;font-size:12px;padding:2px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;cursor:pointer}',
      '.adbm-key:disabled{opacity:.4;cursor:default}',
      '.adbm-text{flex:1 1 120px;min-width:0}',
      '.adbm-log{flex:none;font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.adbm-mark{position:absolute;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:999px;border:2px solid var(--dsw-alias-state-success-primary);pointer-events:none;animation:adbm-ping .9s ease-out forwards}',
      '@keyframes adbm-ping{from{transform:scale(.5);opacity:1}to{transform:scale(2.4);opacity:0}}',
      '.adbm-img{display:block;width:100%;height:100%;object-fit:contain;background:#000;border-radius:6px;-webkit-user-drag:none;user-select:none}',
      '.adbm-video{display:block;width:100%;height:100%;background:#000;border-radius:6px;object-fit:contain}',
      '.adbm-ink{position:absolute;inset:0;touch-action:none}',
      '.adbm-live{position:absolute;inset:0;width:100%;height:100%;border:0;background:#000}',
      '.adbm-ink[data-mode="mark"]{cursor:crosshair}',
      '.adbm-ink[data-mode="tap"]{cursor:pointer}',
      '.adbm-input{flex:none;font:inherit;font-size:12px;padding:5px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit}',
      '.adbm-empty{position:absolute;inset:auto 12px;margin:0;text-align:center;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
  '.adbm-title{white-space:nowrap}',
    ].join('')

    /**
     * 兜底：一栏渲染出错时留下证据，而不是变成一块空白。
     * @param {any} props - 同上。
     * @returns {any} 元素。
     */
    function Body(props) {
      try {
        return h(BodyView, props)
      } catch (error) {
        report({ err: `body-render: ${String(error && error.message ? error.message : error)}` })
        return h('div', { className: 'adbm-body' }, String(error))
      }
    }

    /**
     * 一栏的全部内容。
     * @param {{ sessionId: string }} props - 这一栏属于哪个会话。
     * @returns {any} 元素。
     */
    /* 播放器封包格式必须和服务端 stream.js 一致：[类型 1 B][长度 4 B BE][负载]。 */
    const STREAM_META = 0 // ui-copy-ignore
    const STREAM_INIT = 1 // ui-copy-ignore
    const STREAM_MEDIA = 2 // ui-copy-ignore
    const STREAM_END = 3 // ui-copy-ignore

    /* 持续推流播放：MediaSource 收分片 MP4，收到哪帧放哪帧，静止时零流量。
       任何一步不成就回调 onFail，上层继续用抓帧那条路，画面不会断。 */
    function startLiveVideo(options) {
      const serial = String(options.serial ?? '')
      const video = options.video
      let stopped = false
      let mediaSource = null
      let sourceBuffer = null
      let objectUrl = ''
      let queue = []
      let appending = false
      let codec = ''
      let lastLagAt = 0
      let controller = new AbortController()
      /* 卡死判定：只看「有数据却不动」，静止画面本来就不出帧，不能按「多久没字节」判。 */
      let currentController = null
      let lastAppendAt = Date.now()
      let lastTimeSeen = -1
      let lastTimeAt = Date.now()
      let connectedAt = 0
      let metaSeen = 0
      /* META 到了却没有 INIT：解码起点没来，画面必黑，光等不会好。 */
      let metaAt = 0
      let initSeen = 0
      let mediaSeen = 0
      let stalling = false
      let lastReportAt = 0

      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const meta = (payload) => {
        try { return JSON.parse(new TextDecoder().decode(payload)) } catch { return null }
      }
      /* meta.codec 缺失时（采集端还没解析出 SPS）从 init 的 avcC 直接取 profile/level：
         否则 codec 一直是空串，MSE 永远不建，画面全黑且没有任何报错。 */
      const codecFromInit = (bytes) => {
        if (bytes === null || bytes === undefined || bytes.length < 16) return ''
        const tag = [0x61, 0x76, 0x63, 0x43]
        for (let i = 0; i + 8 < bytes.length; i += 1) {
          if (bytes[i] !== tag[0] || bytes[i + 1] !== tag[1] || bytes[i + 2] !== tag[2] || bytes[i + 3] !== tag[3]) continue
          const hex = (value) => value.toString(16).padStart(2, '0').toUpperCase()
          return 'avc1.' + hex(bytes[i + 5]) + hex(bytes[i + 6]) + hex(bytes[i + 7])
        }
        return ''
      }
      let initPayload = null
      const reset = () => {
        queue = []
        appending = false
        sourceBuffer = null
        mediaSource = null
        if (objectUrl !== '') {
          URL.revokeObjectURL(objectUrl)
          objectUrl = ''
        }
        try { video.removeAttribute('src'); video.load() } catch { /* 无所谓 */ }
      }
      /* 一份 moov 对应一个 MediaSource：换 init 必须整条重来，不能往旧的分片流里塞。 */
      const ensureSource = () => {
        if (mediaSource !== null || codec === '' || typeof window.MediaSource !== 'function') return
        try {
          mediaSource = new window.MediaSource()
        } catch {
          options.onFail?.('mediasource')
          return
        }
        objectUrl = URL.createObjectURL(mediaSource)
        video.src = objectUrl
        video.muted = true
        mediaSource.addEventListener('sourceopen', () => {
          /* 先挂初始化段再挂 sourceBuffer：反了会先吐出 sourceopen 前排队的裸分片，解复用器报 APPEND_FAILED。 */
          if (initPayload !== null) { queue = [initPayload, ...queue]; initPayload = null }
          attach()
          appendNext()
        })
      }
      const appendNext = () => {
        if (sourceBuffer === null || appending || queue.length === 0) return
        if (mediaSource?.readyState !== 'open') return
        if (sourceBuffer.updating) return
        appending = true
        try {
          sourceBuffer.appendBuffer(queue.shift())
        } catch {
          appending = false
        }
      }
      const attach = () => {
        if (mediaSource === null || sourceBuffer !== null || codec === '') return
        try {
          /* 裸 codec 不被 Chrome 接受（NotSupportedError），必须是完整 MIME；两种都试。 */
          try { sourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="' + codec + '"') }
          catch (mimeError) { sourceBuffer = mediaSource.addSourceBuffer(codec) }
        } catch {
          options.onFail?.('codec')
          return
        }
        sourceBuffer.mode = 'segments'
        sourceBuffer.addEventListener('error', () => { /* 解复用器报错只在 buffered 上看得出，不抛 */ })
        sourceBuffer.addEventListener('updateend', () => {
          appending = false
          lastAppendAt = Date.now()
          try {
            if (sourceBuffer !== null && sourceBuffer.buffered.length > 0) {
              const end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1)
              const start = sourceBuffer.buffered.start(0)
              /* 追到直播边缘：落后 0.6 s 直接跳到尾部，落后一点用 1.25 倍速追
                 （小漂移不会自己收敛，不追就一直落后）；顺手扔掉 4 s 之前的。 */
              const lag = end - video.currentTime
              if (lag > 0.45) video.currentTime = Math.max(start, end - 0.06)
              else video.playbackRate = lag > 0.12 ? 1.2 : 1
              if (end - start > 8 && sourceBuffer.updating === false) sourceBuffer.remove(start, end - 4)
              /* 延迟的唯一可观测口径：把落后直播边缘多少报给宿主，/state 里看得到。 */
              if (Date.now() - lastLagAt > 2000) {
                lastLagAt = Date.now()
                report({ lag_ms: Math.round(lag * 1000), buffered_s: Math.round((end - start) * 10) / 10, rate: video.playbackRate })
              }
            }
          } catch { /* 边界状态，忽略 */ }
          appendNext()
        })
        appendNext()
      }
      const onFrame = (type, payload) => {
        if (type === STREAM_META) {
          metaSeen += 1
          metaAt = Date.now()
          const info = meta(payload)
          if (info?.codec) codec = String(info.codec)
          ensureSource()
          return
        }
        if (type === STREAM_INIT) {
          initSeen += 1
          metaAt = 0
          initPayload = payload
          if (codec === '') codec = codecFromInit(payload)
          reset()
          ensureSource()
          return
        }
        if (type === STREAM_MEDIA) {
          mediaSeen += 1
          queue.push(payload)
          /* 队列太长说明这台机器放不过来，丢到只剩最新几片，宁可卡一下也不无限堆积。 */
          if (queue.length > 60) queue = queue.slice(-8)
          appendNext()
          return
        }
        if (type === STREAM_END) reset()
      }
      const session = async () => {
        reset()
        controller = new AbortController()
        const res = await fetch(`${ROUTE}/stream?serial=${encodeURIComponent(serial)}&t=${Date.now()}`, {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!res.ok || res.body === null) throw new Error('stream')
        const reader = res.body.getReader()
        let buf = new Uint8Array(0)
        currentController = controller
        connectedAt = Date.now()
        while (!stopped) {
          const { value, done } = await reader.read()
          if (done) break
          /* 追加只拷贝一次、解析用游标；按帧 slice 在 1 MB 帧下是 O(n²)，会追不上积压。 */
          if (buf.length === 0) { buf = value } else {
            const merged = new Uint8Array(buf.length + value.length)
            merged.set(buf)
            merged.set(value, buf.length)
            buf = merged
          }
          let off = 0
          while (buf.length - off >= 5) {
            const type = buf[off]
            const len = buf[off + 1] * 16777216 + (buf[off + 2] << 16) + (buf[off + 3] << 8) + buf[off + 4]
            if (buf.length - off < 5 + len) break
            onFrame(type, buf.subarray(off + 5, off + 5 + len))
            off += 5 + len
          }
          if (off > 0) buf = buf.subarray(off)
        }
      }
      const run = async () => {
        let backoff = 300
        while (!stopped) {
          try {
            await session()
            backoff = 300
          } catch (error) {
            if (stopped) return
            if (options.onFail?.(String(error?.message ?? error)) === false) {
              stopped = true
              return
            }
            await sleep(backoff)
            backoff = Math.min(4000, backoff * 2)
            continue
          }
          if (stopped) return
          await sleep(120)
        }
      }
      video.muted = true
      video.playsInline = true
      video.autoplay = true
      video.addEventListener('loadeddata', () => options.onReady?.())
      video.addEventListener('loadedmetadata', () => options.onSize?.(video.videoWidth, video.videoHeight))
      video.addEventListener('resize', () => options.onSize?.(video.videoWidth, video.videoHeight))
      video.addEventListener('playing', () => {
        if (stalling) { stalling = false; options.onStall?.('') }
        options.onReady?.()
      })
      void video.play().catch(() => {})
      /* 三种「看着像崩了」的卡死各给一条出路：追加链停、播放时间停。
         命中就 abort 当前连接，外层按退避重连（重连会重发 INIT 和最近一个 GOP）。 */
      const stallTick = setInterval(() => {
        try {
          if (stopped) return
          const now = Date.now()
          if (video.currentTime !== lastTimeSeen) { lastTimeSeen = video.currentTime; lastTimeAt = now }
          /* 连上了却连 META 都没收到：冷启动时 stream 还没就绪，这条连接会一直空转，
             不主动断开就是永久黑屏（3 s 后的 abort 由外层退避重连）。 */
          if (connectedAt > 0 && metaSeen === 0 && now - connectedAt > 2500) {
            try { currentController?.abort() } catch { /* 已断 */ }
            connectedAt = 0
            return
          }
          /* 有 META 没有 INIT 超过 6 秒：宿主那边采集链路大概率死了，断开重连比干等有用。 */
          if (metaAt > 0 && now - metaAt > 6000) {
            metaAt = 0
            report({ stall: 'no-init' })
            if (!stalling) { stalling = true; options.onStall?.('no-init') }
            try { currentController?.abort() } catch { /* 已断 */ }
            return
          }
          if (now - lastReportAt > 3000) {
            lastReportAt = now
            report({ stream: { meta: metaSeen, init: initSeen, media: mediaSeen, queue: queue.length, ct: video.currentTime, rs: video.readyState, elBuf: video.buffered.length } })
          }
          if (queue.length > 4 && now - lastAppendAt > 2000) {
            try { currentController?.abort() } catch { /* 已断 */ }
            return
          }
          let end = 0
          if (sourceBuffer !== null && sourceBuffer.buffered.length > 0) end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1)
          if (end > 0 && video.paused === false && video.readyState >= 3 && now - lastTimeAt > 2500) {
            if (end - video.currentTime > 0.3) { video.currentTime = Math.max(0, end - 0.06); lastTimeAt = now }
            else { try { currentController?.abort() } catch { /* 已断 */ } }
          }
        } catch { /* 诊断不能抛 */ }
      }, 1000)
      void run()
      return () => {
        stopped = true
        clearInterval(stallTick)
        try { controller.abort() } catch { /* 已经关了 */ }
        reset()
      }
    }

    function BodyView(props) {
      const sessionId = String(props?.sessionId ?? '')
      const [serial, setSerial] = React.useState('')
      const [devices, setDevices] = React.useState([])
      const [mode, setMode] = React.useState('tap')
      const [status, setStatus] = React.useState('')
      const [ready, setReady] = React.useState(false)
      const [screen, setScreen] = React.useState({ w: 0, h: 0 })
      const [frameSize, setFrameSize] = React.useState({ w: 0, h: 0 })
      /* 画面框像素尺寸：只由容器和设备屏幕比例决定，帧尺寸变了也不动。 */
      const [box, setBox] = React.useState({ w: 0, h: 0 })
      const boxAt = React.useRef({ w: 0, h: 0 }) // ui-copy-ignore
      const [streaming, setStreaming] = React.useState(false)
      /* jpeg = 抓帧长轮询，mse = 持续推流；后者起来后前者自动停。 */
      const [engine, setEngine] = React.useState('jpeg')
      const [zoom, setZoom] = React.useState(1)
      const [pan, setPan] = React.useState({ x: 0, y: 0 })
      const [draft, setDraft] = React.useState('')
      const [ops, setOps] = React.useState([])
      const [marks, setMarks] = React.useState([])
      const seenOps = React.useRef(new Set())
      const imgRef = React.useRef(null) // ui-copy-ignore
      const videoRef = React.useRef(null) // ui-copy-ignore
      const frameRef = React.useRef(null) // ui-copy-ignore
      const stageRef = React.useRef(null) // ui-copy-ignore
      const canvasRef = React.useRef(null) // ui-copy-ignore
      const strokes = React.useRef([])
      /* 标注要绑住"当时看到的那一帧"：动笔画第一下就把画面冻住，
         之后输入说明的几秒里页面继续动，送回会话的图、圈、控件仍然是同一时刻的。 */
      const frozen = React.useRef(null) // ui-copy-ignore
      /* 防重复提交用独立标志：状态行显示"已发送"之后人还能继续圈下一处。 */
      const isSending = React.useRef(false) // ui-copy-ignore
      /* 点下去先在本地画一个圈：设备那一帧要 0.7 s 才回来，圈让手感立刻有回应。 */
      const taps = React.useRef([]) // ui-copy-ignore
      const drawing = React.useRef(null) // ui-copy-ignore
      const gesture = React.useRef(null) // ui-copy-ignore
      const panDrag = React.useRef(null) // ui-copy-ignore
      const wheel = React.useRef({ dy: 0, x: 0, y: 0, timer: 0 }) // ui-copy-ignore
      const pinch = React.useRef({ dy: 0, x: 0, y: 0, timer: 0 }) // ui-copy-ignore

      /* 画布按显示尺寸重建，人画的线才和画面同尺度。 */
      const paint = React.useCallback(() => {
        const canvas = canvasRef.current
        if (canvas === null) return
        const ratio = Math.min(2, window.devicePixelRatio || 1)
        const box = canvas.getBoundingClientRect()
        const width = Math.max(1, Math.round(box.width * ratio))
        const height = Math.max(1, Math.round(box.height * ratio))
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width
          canvas.height = height
        }
        const ink = canvas.getContext('2d')
        if (ink === null) return
        ink.setTransform(1, 0, 0, 1, 0, 0)
        ink.clearRect(0, 0, canvas.width, canvas.height)
        ink.setTransform(ratio, 0, 0, ratio, 0, 0)
        ink.strokeStyle = '#ff3b30'
        ink.lineWidth = 3
        ink.lineCap = 'round'
        ink.lineJoin = 'round'
        for (const stroke of strokes.current) {
          if (stroke.length < 1) continue
          ink.beginPath()
          stroke.forEach((point, index) => {
            if (index === 0) ink.moveTo(point.x, point.y)
            else ink.lineTo(point.x, point.y)
          })
          if (stroke.length === 1) ink.lineTo(stroke[0].x + 0.5, stroke[0].y + 0.5)
          ink.stroke()
        }
        for (const tap of taps.current) {
          ink.beginPath()
          ink.arc(tap.x, tap.y, 18, 0, Math.PI * 2)
          ink.stroke()
          ink.beginPath()
          ink.arc(tap.x, tap.y, 3, 0, Math.PI * 2)
          ink.fillStyle = '#ff3b30'
          ink.fill()
        }
      }, [])

      /* 画面框按设备屏幕比例装进 stage：推流帧和抓帧帧比例不同也不改框，交给 object-fit 留边。 */
      React.useEffect(() => {
        const stage = stageRef.current
        if (stage === null) return undefined
        const fit = () => {
          const rect = stage.getBoundingClientRect()
          const knows = screen.w > 0 && screen.h > 0
          const aw = knows ? screen.w : 9
          const ah = knows ? screen.h : 16
          if (rect.width < 2 || rect.height < 2 || aw < 2 || ah < 2) return
          const k = Math.min(rect.width / aw, rect.height / ah)
          const next = { w: Math.max(2, Math.round(aw * k)), h: Math.max(2, Math.round(ah * k)) }
          if (boxAt.current.w === next.w && boxAt.current.h === next.h) return
          boxAt.current = next
          setBox(next)
          paint()
        }
        fit()
        const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null
        watch?.observe(stage)
        window.addEventListener('resize', fit)
        return () => {
          watch?.disconnect()
          window.removeEventListener('resize', fit)
        }
      }, [screen.w, screen.h, frameSize.w, frameSize.h, paint])

      /* 只在这一栏真的被人看见时收画面：切走、最小化、被别的页签盖住都停。 */
      React.useEffect(() => {
        const node = frameRef.current
        const awake = () => document.visibilityState !== 'hidden'
        const decide = () => {
          /* 还没来帧时 .adbm-frame 没有尺寸，得看外层 stage 的位置，否则永远判成不可见。 */
          const host = node === null ? null : (node.parentElement ?? node)
          const box = host === null ? null : host.getBoundingClientRect()
          const onScreen = box !== null && box.width > 8 && box.height > 8 && box.bottom > 0 && box.top < window.innerHeight
          setStreaming(awake() && onScreen)
        }
        decide()
        const watch = typeof ResizeObserver === 'function' && node !== null ? new ResizeObserver(decide) : null
        watch?.observe(node)
        document.addEventListener('visibilitychange', decide)
        window.addEventListener('resize', decide)
        return () => {
          watch?.disconnect()
          document.removeEventListener('visibilitychange', decide)
          window.removeEventListener('resize', decide)
        }
      }, [])

      React.useEffect(() => {
        report({ body: true, sessionId })
      }, [sessionId])

      /* 对话里刚点了哪里：让这一栏和聊天记录对得上，不用回头读文字。 */
      React.useEffect(() => {
        if (serial === '') return undefined
        let live = true
        const tick = () => {
          fetch(`${ROUTE}/actions?serial=${encodeURIComponent(serial)}`, { cache: 'no-store' })
            .then((response) => response.json())
            .then((body) => {
              if (!live) return
              const rows = Array.isArray(body?.actions) ? body.actions : []
              setOps(rows)
              /* 对话里刚动的那个点，在画面上画一圈，看一眼就知道 agent 摸哪儿了。 */
              const fresh = []
              for (const row of rows) {
                const text = String(row)
                if (seenOps.current.has(text)) continue
                seenOps.current.add(text)
                const hit = /@(\d+),(\d+)/.exec(text)
                if (hit !== null) fresh.push({ id: `${text}#${Date.now()}`, x: Number(hit[1]), y: Number(hit[2]) })
              }
              if (seenOps.current.size > 200) seenOps.current = new Set(rows.map(String))
              if (fresh.length === 0) return
              setMarks((old) => [...old.slice(-3), ...fresh])
              window.setTimeout(() => setMarks((old) => old.filter((each) => !fresh.some((row) => row.id === each.id))), 1000)
            })
            .catch(() => {})
        }
        tick()
        const timer = window.setInterval(tick, 2000)
        return () => { live = false; window.clearInterval(timer) }
      }, [serial])

      React.useEffect(() => {
        const frame = frameRef.current
        if (frame === null || typeof ResizeObserver !== 'function') return undefined
        const watch = new ResizeObserver(() => paint())
        watch.observe(frame)
        return () => watch.disconnect()
      }, [paint])

      React.useEffect(() => {
        let live = true
        fetch(`${ROUTE}/devices`, { cache: 'no-store' })
          .then((response) => response.json())
          .then((body) => {
            if (!live) return
            setDevices(Array.isArray(body?.devices) ? body.devices : [])
            setSerial(String(body?.serial ?? ''))
          })
          .catch(() => {})
        return () => { live = false }
      }, [])

      /* 优先走持续推流：画面一变，编码器那一帧几十毫秒就到；静止时零流量。
         浏览器不支持、解码器不认这个 profile 时退回抓帧，画面不会断。 */
      React.useEffect(() => {
        if (serial === '' || !streaming) return undefined
        if (typeof window.MediaSource !== 'function') return undefined
        const video = videoRef.current
        if (video === null) return undefined
        let alive = true
        let fails = 0
        let painted = false
        /* 2.5 s 还没出画面就退回抓帧，别让人对着黑屏等。 */
        const watchdog = window.setTimeout(() => {
          if (alive && !painted) setEngine('jpeg')
        }, 2500)
        const stop = startLiveVideo({
          serial,
          video,
          onReady: () => {
            if (!alive) return
            painted = true
            window.clearTimeout(watchdog)
            setEngine('mse')
            setReady(true)
            paint()
          },
          onSize: (width, height) => {
            if (alive && width > 0) setFrameSize({ w: width, h: height })
          },
          onStall: (reason) => {
            if (!alive) return
            if (reason === '') { if (!ready) return; setStatus('') };
            if (reason === 'no-init') setStatus('画面没有响应，正在重新连接')
          },
          onFail: () => {
            fails += 1
            if (fails <= 2) return true
            if (alive) setEngine('jpeg')
            return false
          },
        })
        return () => {
          alive = false
          window.clearTimeout(watchdog)
          stop()
        }
      }, [serial, streaming, paint])

      /* 面板长轮询取帧：服务端等到下一帧才回，客户端不用空转等待，
         延迟只剩「抓一帧」本身。看不到时退到低频，窗口在后台就停下。 */
      React.useEffect(() => {
        if (serial === '' || engine === 'mse') return undefined
        let live = true
        let timer
        let since = 0
        let misses = 0
        /* 正在显示与正在解码的 Blob URL 各留一个：替换时先释放旧的待解码，
           卸载时两个都释放。旧写法只靠 onload 回收，换帧快时会漏掉整条 URL。 */
        let shownUrl = ''
        let pendingUrl = ''
        const releaseUrls = () => {
          if (pendingUrl !== '') {
            URL.revokeObjectURL(pendingUrl)
            pendingUrl = ''
          }
          if (shownUrl !== '') {
            URL.revokeObjectURL(shownUrl)
            shownUrl = ''
          }
        }
        const visible = () => {
          const node = frameRef.current
          const host = node === null ? null : (node.parentElement ?? node)
          const box = host === null ? null : host.getBoundingClientRect()
          const onScreen = box !== null && box.width > 8 && box.height > 8 && box.bottom > 0 && box.top < window.innerHeight // ui-copy-ignore
          setStreaming(document.visibilityState !== 'hidden' && onScreen)
          return document.visibilityState !== 'hidden' && onScreen
        }
        const pull = async () => {
          if (!live) return
          if (!visible()) {
            timer = setTimeout(pull, 700)
            return
          }
          try {
            const query = `serial=${encodeURIComponent(serial)}&since=${since}&wait=${misses === 0 ? 1500 : 0}&t=${Date.now()}` // ui-copy-ignore
            const res = await fetch(`${ROUTE}/frame?${query}`, { cache: 'no-store' }) // ui-copy-ignore
            if (!res.ok) throw new Error('还没有帧')
            const blob = await res.blob()
            since = Number(res.headers.get('x-adb-seq') ?? '') || since
            if (!live) return
            const img = imgRef.current
            if (img !== null) {
              const url = URL.createObjectURL(blob)
              if (pendingUrl !== '') URL.revokeObjectURL(pendingUrl)
              pendingUrl = url
              img.onload = () => {
                if (pendingUrl !== url) return
                pendingUrl = ''
                if (shownUrl !== '') URL.revokeObjectURL(shownUrl)
                shownUrl = url
                setReady(true)
                paint()
              }
              img.onerror = () => {
                if (pendingUrl !== url) return
                pendingUrl = ''
                URL.revokeObjectURL(url)
              }
              img.src = url
            }
            misses = 0
          } catch {
            misses += 1
          }
          if (live) timer = setTimeout(pull, misses === 0 ? 0 : Math.min(3000, 300 * misses))
        }
        void pull()
        return () => { live = false; clearTimeout(timer); releaseUrls() }
      }, [serial, paint, engine])

      /* 画面尺寸与是否在直播：标注坐标要换算到设备像素，必须知道这两个数。 */
      React.useEffect(() => {
        if (serial === '') return undefined
        let live = true
        const tick = () => {
          fetch(`${ROUTE}/state?serial=${encodeURIComponent(serial)}`, { cache: 'no-store' })
            .then((response) => response.json())
            .then((state) => {
              if (!live) return
              if (Number(state?.screen?.w) > 0) setScreen({ w: Number(state.screen.w), h: Number(state.screen.h) })
              if (Number(state?.frame?.w) > 0) setFrameSize({ w: Number(state.frame.w), h: Number(state.frame.h) })
              setReady(state?.live === true)
              const build = String(state?.build ?? '')
              if (build !== '' && build !== window.__ADBM_BUILD) {
                /* 换一次代码就够：换完还是对不上，是两边的版本号本身不一致，再换就是整页死循环。 */
                const seen = `adbm-stale:${window.__ADBM_BUILD}->${build}`
                let tried = 0
                try { tried = Number(sessionStorage.getItem(seen) ?? 0) } catch { tried = 0 }
                if (tried >= 1) {
                  setStatus('页面代码没有更新，重新打开这一栏')
                  return
                }
                try { sessionStorage.setItem(seen, '1') } catch { /* 存不了就只靠这一轮的上限 */ }
                setStatus('正在载入新版本…')
                window.location.reload()
              }
            })
            .catch(() => {})
        }
        tick()
        const timer = setInterval(tick, 1500)
        return () => { live = false; clearInterval(timer) }
      }, [serial])

      /* 一次性诊断：面板挂上了却不出画面时，把关键状态打到宿主，别靠猜。 */
      React.useEffect(() => {
        let n = 0
        const beat = () => {
          const img = imgRef.current
          const size = (node) => {
            const rect = node === null || node === undefined ? null : node.getBoundingClientRect()
            return rect === null ? [0, 0] : [Math.round(rect.width), Math.round(rect.height)]
          }
          n += 1
          report({
            event: 'pane',
            n,
            stage: size(stageRef.current),
            frame: size(frameRef.current),

            serial,
            streaming: streaming === true,
            img: img === null ? 'none' : String(img.getAttribute('src') ?? '').slice(-26),
            w: img?.naturalWidth ?? 0,
            h: img?.naturalHeight ?? 0,
            complete: img?.complete === true,
            ready,
            vis: document.visibilityState,
            title: String(document.title ?? '').slice(0, 20),
          })
          if (n >= 6) clearInterval(timer)
        }
        const timer = setInterval(beat, 2500)
        return () => clearInterval(timer)
      }, [serial, streaming, ready])

      /**
       * 指针位置换成画布里的坐标。
       * @param {any} event - 指针事件。
       * @returns {{ x: number, y: number }} 坐标。
       */
      const pointOf = (event) => {
        const box = canvasRef.current.getBoundingClientRect()
        return { x: event.clientX - box.left, y: event.clientY - box.top }
      }

      /**
       * 画布坐标换成设备坐标：画面等比铺满画布，两边比例一致。
       * @param {{ x: number, y: number }} point - 画布坐标。
       * @returns {{ x: number, y: number }} 设备坐标。
       */
      /* 画面元素：MSE 用 video，抓帧用 img；谁可见用谁。 */
      const pictureEl = () => (engine === 'mse' ? videoRef.current : imgRef.current)

      /* 真正画出画面的矩形。缩放/平移都作用在 .adbm-frame 上，这里拿到的就是变换后的框；
         留边（object-fit:contain / max-width:100%）也算进去了，所以不再假设「铺满画布」。 */
      const pictureRect = () => {
        const media = pictureEl()
        const box = media === null ? null : media.getBoundingClientRect()
        if (box !== null && box.width > 1 && box.height > 1) return box
        return canvasRef.current.getBoundingClientRect()
      }

      /* 设备是竖是横：wm size 报物理方向，画面可能是另一个方向，横竖不一致就是转过 90°。 */
      const turned = () => screen.w > 0 && screen.h > 0 && frameSize.w > 0 && frameSize.h > 0
        && (screen.w > screen.h) !== (frameSize.w > frameSize.h)

      /**
       * 画布坐标换成设备坐标。
       * @param {{ x: number, y: number }} point - 画布坐标。
       * @returns {{ x: number, y: number }} 设备坐标。
       */
      const devicePoint = (point) => {
        if (screen.w < 1 || screen.h < 1) return { x: 0, y: 0 }
        const canvas = canvasRef.current
        const rect = pictureRect()
        if (canvas === null || rect.width < 1 || rect.height < 1) return { x: 0, y: 0 }
        /* point 来自 pointOf，是画布内的局部坐标；pictureRect 是视口坐标。
           混用两个坐标系会把侧栏整体算成负偏移（右栏越靠右，误差越大），
           所以这里补一次画布自身在视口里的偏移，整条换算只做一次。 */
        const box = canvas.getBoundingClientRect()
        const u = Math.min(1, Math.max(0, (point.x + box.left - rect.left) / rect.width))
        const v = Math.min(1, Math.max(0, (point.y + box.top - rect.top) / rect.height))
        const x = turned() ? Math.round(v * screen.w) : Math.round(u * screen.w)
        const y = turned() ? Math.round(u * screen.h) : Math.round(v * screen.h)
        return { x, y }
      }

      /* 平移边界：放大后画面不许整块跑出舞台，否则一块空白还照样能点。 */
      const clampPan = (next, z) => {
        const stage = stageRef.current
        const canvas = canvasRef.current
        if (stage === null || canvas === null) return next
        const box = canvas.getBoundingClientRect()
        const base = stage.getBoundingClientRect()
        const w = (box.width / (z === 0 ? 1 : z)) * z
        const h = (box.height / (z === 0 ? 1 : z)) * z
        const minX = Math.min(0, base.width - w)
        const minY = Math.min(0, base.height - h)
        return { x: Math.min(0, Math.max(minX, next.x)), y: Math.min(0, Math.max(minY, next.y)) }
      }

      /* 缩放锚在指针上：放大了点键盘上的小键才点得准。 */
      const zoomTo = (next, anchor) => {
        const clamped = Math.min(4, Math.max(1, next))
        if (clamped === zoom) return
        if (clamped === 1) {
          setZoom(1)
          setPan({ x: 0, y: 0 })
          return
        }
        const box = stageRef.current === null ? null : stageRef.current.getBoundingClientRect()
        const origin = anchor ?? (box === null ? { x: 0, y: 0 } : { x: box.width / 2, y: box.height / 2 })
        const ratio = clamped / zoom
        const x = Math.round(origin.x - (origin.x - pan.x) * ratio)
        const y = Math.round(origin.y - (origin.y - pan.y) * ratio)
        setZoom(clamped)
        setPan(clampPan({ x, y }, clamped))
      }

      const onDown = (event) => {
        const point = pointOf(event)
        try { report({ event: 'input', phase: 'down', mode, x: Math.round(point.x), y: Math.round(point.y), button: event.button, serial }) } catch (error) { /* 诊断不影响操作 */ }
        if (mode === 'mark') {
          /* 第一笔落下就把画面冻住：之后几秒输入说明时页面再动，
             送回会话的仍是"人看到问题的那一帧"。 */
          if (frozen.current === null && serial !== '') {
            const box = canvasRef.current === null ? null : canvasRef.current.getBoundingClientRect()
            const width = box === null ? 0 : box.width
            fetch(`${ROUTE}/frame?serial=${encodeURIComponent(serial)}`, { cache: 'no-store' })
              .then((response) => (response.ok ? response.blob() : Promise.reject(new Error('no frame'))))
              .then((blob) => createImageBitmap(blob))
              .then((bitmap) => {
                if (frozen.current === null && strokes.current.length > 0) {
                  frozen.current = { bitmap, width, at: Date.now() }
                } else if (bitmap !== null && typeof bitmap.close === 'function') {
                  bitmap.close()
                }
              })
              .catch(() => { setStatus(L('state.failed')) })
          }
          drawing.current = [point]
          strokes.current.push(drawing.current)
          paint()
          return
        }
        if (zoom > 1 && event.shiftKey) {
          panDrag.current = { start: point, pan }
          return
        }
        gesture.current = { start: point, last: point, at: Date.now() }
        taps.current = [{ x: point.x, y: point.y }]
        paint()
        setTimeout(() => { taps.current = []; paint() }, 500)
      }

      const onMove = (event) => {
        const point = pointOf(event)
        if (panDrag.current !== null) {
          const { start, pan: from } = panDrag.current
          setPan(clampPan({ x: from.x + (point.x - start.x), y: from.y + (point.y - start.y) }, zoom))
          return
        }
        if (mode === 'mark') {
          if (drawing.current === null) return
          drawing.current.push(point)
          paint()
          return
        }
        if (gesture.current !== null) gesture.current.last = point
      }

      const onUp = () => {
        if (panDrag.current !== null) { panDrag.current = null; return }
        if (mode === 'mark') {
          drawing.current = null
          return
        }
        const gestureNow = gesture.current
        gesture.current = null
        if (gestureNow === null || serial === '') return
        const from = devicePoint(gestureNow.start)
        const to = devicePoint(gestureNow.last)
        const far = Math.abs(to.x - from.x) + Math.abs(to.y - from.y)
        const held = Date.now() - (gestureNow.at ?? 0) >= 650
        const body = far < 12
          ? fetch(`${ROUTE}/tap`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(held ? { serial, x: from.x, y: from.y, long: true } : { serial, x: from.x, y: from.y }),
          })
          : fetch(`${ROUTE}/swipe`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ serial, x1: from.x, y1: from.y, x2: to.x, y2: to.y, ms: 260 }),
          })
        body.then((response) => (response.ok ? response.json() : null)).then((result) => {
          try { report({ event: 'input', phase: 'up', far, engine: result && result.engine, ok: result === null ? null : result.ok === true, reason: result && result.reason }) } catch (error) { /* 诊断不影响操作 */ }
          if (result !== null && result.ok === true) return
          setStatus(String((result && result.reason) || L('state.failed')))
        }).catch(() => setStatus(L('state.failed')))
      }

      /* 画布拿到焦点时，键入直接进设备：可见字符攒 150 ms 发一次，功能键立刻发。 */
      const typeQueue = { text: '', timer: 0, serial: '' }
      const flushText = () => {
        typeQueue.timer = 0
        const text = typeQueue.text
        typeQueue.text = ''
        if (text === '' || typeQueue.serial === '') return
        fetch(`${ROUTE}/text`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ serial: typeQueue.serial, text }),
        }).catch(() => setStatus(L('state.failed')))
      }
      /* 中文没法用 keyevent 打进去：交给宿主用剪贴板粘贴，前端只发一段文本。 */
      const commitText = () => {
        const text = draft
        if (text === '' || serial === '') return
        setDraft('')
        setStatus(L('state.sending'))
        fetch(`${ROUTE}/text`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ serial, text }),
        }).then((response) => {
          if (!response.ok) throw new Error('text ' + String(response.status))
          return response.json()
        }).then((body) => {
          setStatus(body?.ok === false ? L('state.failed') : '')
          if (body?.ok === false) setDraft(text)
        }).catch(() => setStatus(L('state.failed')))
      }
      const sendKey = (key) => {
        fetch(`${ROUTE}/key`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ serial, key }),
        }).catch(() => setStatus(L('state.failed')))
      }
      const onKey = (event) => {
        if (mode === 'mark' || serial === '') return
        const keys = { Enter: 'ENTER', Backspace: 'DEL', Tab: 'TAB', Escape: 'BACK', ArrowUp: 'DPAD_UP', ArrowDown: 'DPAD_DOWN', ArrowLeft: 'DPAD_LEFT', ArrowRight: 'DPAD_RIGHT' }
        const named = keys[event.key]
        if (named !== undefined) {
          event.preventDefault()
          if (typeQueue.timer !== 0) flushText()
          sendKey(named)
          return
        }
        if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return
        event.preventDefault()
        typeQueue.text += event.key
        typeQueue.serial = serial
        if (typeQueue.timer === 0) typeQueue.timer = window.setTimeout(flushText, 150)
      }

      /* 鼠标滚轮 = 单指滑动：攒一小段再发，连续滚动不会每格打一次 adb。 */
      const onWheel = (event) => {
        if (mode === 'mark' || serial === '') return
        event.preventDefault()
        const point = pointOf(event)
        if (event.altKey) {
          /* 捏合：滚轮攒够一段再整段发，端上一次性写进触摸屏。 */
          pinch.current.dy += event.deltaY
          pinch.current.x = point.x
          pinch.current.y = point.y
          if (pinch.current.timer !== 0) return
          pinch.current.timer = window.setTimeout(() => {
            const { dy, x, y } = pinch.current
            pinch.current = { dy: 0, x: 0, y: 0, timer: 0 }
            if (Math.abs(dy) < 8) return
            const at = devicePoint({ x, y })
            const apart = dy < 0
            fetch(`${ROUTE}/pinch`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                serial,
                x: at.x,
                y: at.y,
                from: apart ? 140 : 520,
                to: apart ? 520 : 140,
                ms: 280,
              }),
            }).catch(() => setStatus(L('state.failed')))
          }, 160)
          return
        }
        if (event.ctrlKey || event.metaKey) {
          zoomTo(zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15), point)
          return
        }
        wheel.current.dy += event.deltaY
        wheel.current.x = point.x
        wheel.current.y = point.y
        if (wheel.current.timer !== 0) return
        wheel.current.timer = window.setTimeout(() => {
          const { dy, x, y } = wheel.current
          wheel.current = { dy: 0, x: 0, y: 0, timer: 0 }
          if (Math.abs(dy) < 8) return
          const from = devicePoint({ x, y })
          fetch(`${ROUTE}/scroll`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ serial, x: from.x, y: from.y, dy: Math.round(dy * 3) }),
          }).catch(() => setStatus(L('state.failed')))
        }, 120)
      }

      const clear = () => {
        strokes.current = []
        frozen.current = null
        paint()
        setStatus('')
      }

      /* 图上带圈，连同圈里的控件一起推进聊天。 */
      /* `wm size` 报的是竖屏物理尺寸（2136x3200），画面常是横屏 3200x2136；
         两边横竖不一致时按长边归位，否则标注/点按会整体缩到左上角。 */
      const deviceWidth = () => {
        if (screen.w < 1) return 0
        const same = frameSize.w < 1 || (screen.w > screen.h) === (frameSize.w > frameSize.h)
        return same ? screen.w : Math.max(screen.w, screen.h)
      }

      const send = async () => {
        if (serial === '' || isSending.current) return
        isSending.current = true
        setStatus(L('state.starting'))
        try {
          /* 优先用画第一笔时冻住的那一帧：保证图、圈、控件是同一时刻的现场。
             冻帧失败（当时没网/没帧）才退回取当前帧，并在证据里标明。 */
          const still = frozen.current
          let bitmap = null
          let frozenAt = 0
          let canvasWidth = 0
          if (still !== null) {
            bitmap = still.bitmap
            frozenAt = still.at
            canvasWidth = still.width
          } else {
            const response = await fetch(`${ROUTE}/frame?serial=${encodeURIComponent(serial)}`, { cache: 'no-store' })
            if (!response.ok) throw new Error('no frame')
            bitmap = await createImageBitmap(await response.blob())
            frozenAt = Date.now()
            canvasWidth = canvasRef.current.getBoundingClientRect().width
          }
          const out = document.createElement('canvas')
          out.width = bitmap.width
          out.height = bitmap.height
          const ink = out.getContext('2d')
          if (ink === null) throw new Error('no canvas')
          ink.drawImage(bitmap, 0, 0)
          const scale = canvasWidth < 1 ? 1 : out.width / canvasWidth
          ink.strokeStyle = '#ff3b30'
          ink.lineWidth = Math.max(3, 3 * scale)
          ink.lineCap = 'round'
          ink.lineJoin = 'round'
          let left = Infinity
          let top = Infinity
          let right = -Infinity
          let bottom = -Infinity
          for (const stroke of strokes.current) {
            ink.beginPath()
            stroke.forEach((point, index) => {
              const x = point.x * scale
              const y = point.y * scale
              if (index === 0) ink.moveTo(x, y)
              else ink.lineTo(x, y)
              left = Math.min(left, x)
              top = Math.min(top, y)
              right = Math.max(right, x)
              bottom = Math.max(bottom, y)
            })
            ink.stroke()
          }
          const deviceScale = deviceWidth() > 0 ? deviceWidth() / out.width : 1
          const rect = Number.isFinite(left)
            ? {
              x: left * deviceScale,
              y: top * deviceScale,
              w: Math.max(1, (right - left) * deviceScale),
              h: Math.max(1, (bottom - top) * deviceScale),
            }
            : null
          const png = out.toDataURL('image/png').split(',')[1]
          const answer = await fetch(`${ROUTE}/annotate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              serial,
              session: sessionId,
              note: '',
              png,
              rect,
              frozen_at: frozenAt,
              frozen_ms: frozenAt < 1 ? null : Math.max(0, Date.now() - frozenAt),
            }),
          }).then((res) => res.json())
          if (answer?.ok === true) {
            setStatus(L('state.sent'))
            strokes.current = []
            frozen.current = null
            paint()
          } else {
            setStatus(String(answer?.reason ?? L('state.failed')))
          }
        } catch {
          setStatus(L('state.failed'))
        } finally {
          isSending.current = false
        }
      }

      /* 不画任何东西，直接把最近几秒的画面 + 操作时间线推给 agent：
         桌宠变大这类「刚才那几下之后不对劲」的问题，用这个最快。 */
      const sendRecent = async () => {
        if (serial === '' || isSending.current) return
        isSending.current = true
        setStatus(L('state.starting'))
        try {
          const answer = await fetch(`${ROUTE}/annotate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ serial, session: sessionId, note: '', recent: true, png: '', rect: null }),
          }).then((res) => res.json())
          if (answer?.ok === true) {
            setStatus(L('state.sent'))
          } else {
            setStatus(String(answer?.reason ?? L('state.failed')))
          }
        } catch {
          setStatus(L('state.failed'))
        } finally {
          isSending.current = false
        }
      }

      const button = (value, label, onClick, extra) => h('button', {
        className: 'adbm-btn',
        'data-on': mode === value ? '1' : '0',
        'data-primary': extra?.primary === true ? '1' : undefined,
        disabled: extra?.disabled === true,
        onClick,
      }, label)

      const say = status !== '' ? status : (ready ? '' : L('state.starting'))
      const empty = serial === ''
        ? L('empty.none')
        : (devices.includes(serial) ? '' : L('empty.gone'))

      return h('div', { className: 'adbm-body' },
        h('div', { className: 'adbm-bar' },
          serial === '' ? button('tap', L('act.tap'), () => setMode('tap')) : null,
          serial === '' ? null : h('button', {
            className: 'adbm-btn',
            'data-primary': '1',
            disabled: !ready,
            onClick: send,
          }, L('act.send')),
          h('button', {
            className: 'adbm-btn',
            disabled: serial === '',
            onClick: sendRecent,
          }, L('act.recent')),
          strokes.current.length > 0 ? h('button', { className: 'adbm-btn', onClick: clear }, L('act.clear')) : null,
          say === '' ? null : h('span', { className: 'adbm-said' }, say),
          devices.length > 1
            ? h('select', {
              className: 'adbm-input',
              value: serial,
              onChange: (event) => { setSerial(event.target.value); setReady(false) },
            }, devices.map((each) => h('option', { key: each, value: each }, each)))
            : null,
        ),
        h('div', { className: 'adbm-stage', ref: stageRef }, // ui-copy-ignore
          empty === '' ? null : h('p', { className: 'adbm-empty' }, empty),
          serial === ''
            ? null
            : h('iframe', {
              className: 'adbm-live',
              title: serial,
              allow: 'autoplay; fullscreen',
              src: `${ROUTE}/?session=${encodeURIComponent(sessionId)}&serial=${encodeURIComponent(serial)}`,
            }),
          h('div', {
            className: 'adbm-frame',
            ref: frameRef,
            style: (() => {
              const frameStyle = {}
              if (box.w > 0) {
                frameStyle.width = `${box.w}px`
                frameStyle.height = `${box.h}px`
              }
              if (zoom !== 1) frameStyle.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`
              return frameStyle
            })(), // ui-copy-ignore
          },
            serial === ''
              ? null
              : h('video', {
                className: 'adbm-video',
                ref: videoRef, // ui-copy-ignore
                muted: true,
                playsInline: true,
                autoPlay: true,
                style: { display: engine === 'mse' ? 'block' : 'none' },
              }),
            serial === '' || engine === 'mse'
              ? null
              : h('img', {
                className: 'adbm-img',
                ref: imgRef, // ui-copy-ignore
                alt: '',
                draggable: false,
                /* 没人在看就断开：右栏切到别的页签、窗口在后台、面板滚出视野，
                   都不该让设备一直截图。重新被看见时这一条会自己接上。 */
                /* 帧由上面的拉取循环塞进来；这里不给 src，免得同一路画面开两条。 */
                onLoad: () => { setReady(true); paint() },
              }),
            h('canvas', {
              className: 'adbm-ink',
              ref: canvasRef, // ui-copy-ignore
              'data-mode': mode,
              onPointerDown: onDown,
              onPointerMove: onMove,
              onPointerUp: onUp,
              onPointerCancel: onUp,
              onWheel: onWheel,
              tabIndex: 0,
              onKeyDown: onKey,
            }),
          ),
        ),
        h('div', { className: 'adbm-keys' },
          h('input', {
            className: 'adbm-input adbm-text',
            value: draft,
            placeholder: L('ph.text'),
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); commitText() } },
          }),
          h('button', { className: 'adbm-key', disabled: serial === '' || draft === '', onClick: commitText }, L('act.text')),
          h('button', { className: 'adbm-key', disabled: serial === '', onClick: () => sendKey('BACK') }, L('key.back')),
          h('button', { className: 'adbm-key', disabled: serial === '', onClick: () => sendKey('HOME') }, L('key.home')),
          h('button', { className: 'adbm-key', disabled: serial === '', onClick: () => sendKey('ENTER') }, L('key.enter')),
          h('button', { className: 'adbm-key', disabled: serial === '', onClick: () => sendKey('DEL') }, L('key.del')),
          h('button', { className: 'adbm-key', disabled: serial === '', onClick: () => sendKey('TAB') }, L('key.tab')),
        ),
        h('div', { className: 'adbm-keys' },
          h('button', { className: 'adbm-key', disabled: serial === '' || zoom === 1, onClick: () => zoomTo(1) }, L('act.fit')),
          h('button', { className: 'adbm-key', disabled: serial === '', 'data-on': zoom >= 2 ? '1' : '0', onClick: () => zoomTo(2) }, '2×'),
          h('button', { className: 'adbm-key', disabled: serial === '', 'data-on': zoom >= 3 ? '1' : '0', onClick: () => zoomTo(3) }, '3×'),
        ),
        ops.length === 0 ? null : h('div', { className: 'adbm-log' }, ops.slice(-2).join(' · ')),
        ...marks.map((mark) => h('span', {
          key: mark.id,
          className: 'adbm-mark',
          style: { left: `${screen.w > 0 ? (mark.x / screen.w) * 100 : 50}%`, top: `${screen.h > 0 ? (mark.y / screen.h) * 100 : 50}%` },
        })),
      )
    }

    return {
      inject: ['slots', 'locale', 'layout'],
      /**
       * 注册这一栏，并让 agent 也能把它叫出来。
       * @param {any} ctx - 客户端插件上下文。
       */
      apply(ctx) {
      report({ event: 'boot' })
        try {
          ctx.locale.register(NS, { zh: DICT.zh, 'zh-CN': DICT.zh, en: DICT.en })
        } catch {
          /* 只有一个 locale 服务，或没有 */
        }
        ctx.effect(() => {
          const style = document.createElement('style')
          style.id = 'dsh-mobile-use-mirror-css'
          style.dataset.pluginCss = ID
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'dsh-mobile-use: 实时镜像样式')

        /* 右栏的登记处是页面级单例，而插件的模块可能被就地换过一次：旧实例注册的类型
           还在册，新实例再注册就会撞名，页签于是只长出个空壳。这里把整页重建一次，
           登记处和页面一起换新；同一页面 30 秒内只重建一次，避免来回跳。 */
        const reloadPage = (reason) => {
          try {
            const last = Number(sessionStorage.getItem('dsh-mobile-use.reload') ?? 0)
            if (Date.now() - last < 30_000) return
            if (document.querySelector('[aria-modal="true"], dialog[open]') !== null) return
            sessionStorage.setItem('dsh-mobile-use.reload', String(Date.now()))
            report({ event: 'reload', reason })
            location.reload()
          } catch {
            /* 没有存储的页面就宁可不动 */
          }
        }

        /* 诊断一次性：看清「这个窗口到底在显示哪个会话」——路由、标题、DOM 里带会话 id 的属性。 */
        try {
          const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
          const hits = []
          for (const node of document.querySelectorAll('[data-session-id],[data-session],[data-id]')) {
            hits.push(`${node.tagName.toLowerCase()}[${node.getAttribute('data-session-id') ?? node.getAttribute('data-session') ?? node.getAttribute('data-id')}]`)
            if (hits.length > 8) break
          }
          const walk = []
          for (const node of document.querySelectorAll('*')) {
            for (const attribute of node.attributes ?? []) {
              if (uuid.test(attribute.value)) walk.push(`${attribute.name.slice(0, 24)}=${attribute.value.slice(-36)}`)
            }
            if (walk.length > 10) break
          }
          report({ event: 'dom', href: String(location.href).slice(0, 120), title: String(document.title).slice(0, 40), hits, walk })
        } catch (error) {
          report({ event: 'dom-fail', message: String(error?.message ?? error).slice(0, 120) })
        }

        ctx.inject(['sidebarRightTabs', 'sidebarRight'], (scope) => scope.effect(() => {
        /* 诊断一次性：客户端 sessions / layout 服务里到底哪个值代表「这个窗口正显示的会话」。 */
        try {
          const out = {}
          for (const service of ['sessions', 'layout', 'uiWorkspace']) {
            const svc = scope.get(service)
            if (svc === undefined) { out[service] = 'missing'; continue }
            let names = []
            let proto = Object.getPrototypeOf(svc)
            while (proto && proto !== Object.prototype && names.length < 40) {
              names = names.concat(Object.getOwnPropertyNames(proto))
              proto = Object.getPrototypeOf(proto)
            }
            out[service] = [...new Set(names)]
            for (const method of ['active', 'activeId', 'current', 'focused', 'selected', 'snapshot', 'getSnapshot']) {
              try {
                const value = typeof svc[method] === 'function' ? svc[method]() : svc[method]
                if (value !== undefined) out[`${service}.${method}`] = String(value?.sessionId ?? value?.id ?? value?.session ?? JSON.stringify(value)).slice(0, 80)
              } catch { /* 试不到就算 */ }
            }
          }
          report({ event: 'svc', out })
        } catch (error) {
          report({ event: 'svc-fail', message: String(error?.message ?? error).slice(0, 120) })
        }


          const done = []
          /* 先把页签类型注册进右栏的登记处：没有这一条，openTab 等于没调。 */
          try {
            const tabs = scope.sidebarRightTabs
            const registration = typeof tabs?.register === 'function'
              ? tabs.register({
                id: KIND, // ui-copy-ignore
                kind: KIND, // ui-copy-ignore
                title: () => L('type.label'),
                guide: [{
                  order: 40,
                  title: () => L('type.label'),
                  description: () => L('type.hint'),
                  icon: 'mdi:cellphone-link',
                }],
              })
              : undefined
            if (registration !== undefined) done.push(registration)
          } catch (error) {
            if (/already registered/i.test(String(error?.message ?? error))) {
              reloadPage('tab-type-conflict')
              return () => {}
            }
          }

          done.push(scope.slots.inject(SLOT, () => scope.slots.register({
            name: SLOT, // ui-copy-ignore
            key: KIND, // ui-copy-ignore
            locale: NS, // ui-copy-ignore
            inject: (sessionId) => ({ sessionId }),
          }, Body)))

          done.push(scope.slots.inject(TITLE_SLOT, () => scope.slots.register({
            name: TITLE_SLOT, // ui-copy-ignore
            key: KIND, // ui-copy-ignore
            locale: NS, // ui-copy-ignore
          }, () => h('span', { className: 'adbm-title' }, L('type.label')))))

          const right = () => {
            try { return scope.get('sidebarRight') } catch { return undefined }
          }
          /* 某个会话自己那一栏里已经开着的页签。不能用全局清单：别处开着的同类型页签
             会让这里误判「已经开了」，于是跳过建页签、转而去动别人正在看的那一栏。 */
          const rowsOf = (sessionId) => {
            try { return right()?.tabsIn?.(sessionId) ?? [] } catch { return [] }
          }
          const mountedNow = () => {
            try { return right()?.mounted?.getSnapshot?.() } catch { return undefined }
          }
          /* 宿主说「打开这一栏」：只在发起方那一栏建页签、展开右栏、切到它。 */
          const onWanted = (event, retryPass) => {
            let body
            try { body = JSON.parse(event?.data ?? '{}') } catch { body = {} }
            const want = body?.sessionId ?? body?.session
            if (typeof want !== 'string' || want === '') return
            /* 推送会重连、页面会重载：同一个请求（at 不变或更旧）不再重放一次。 */
            const at = Number(body?.at ?? 0) || 0
            /* 宿主留下的旧请求不补开：页面隔很久才装载时，半小时前的 want 不该再弹一次栏。 */
            if (at > 0 && Date.now() - at > 120000) return
            if (at > 0 && retryPass !== true) {
              if (at <= seenWantAt) return
              seenWantAt = at
              wantTries = 0
            }
            const mounted = mountedNow()
            /* 空串和 undefined 一样，都是「右栏没挂上任何会话」：右栏收起时就是这个值。
               这不是许可，但也不该立刻放弃——挂上来只需要几十毫秒，等一下再看。 */
            const blank = mounted === undefined || mounted === null || mounted === ''
            /* 默认拒绝：只有「右栏正挂在发起方这一栏上」才允许占用可见栏；标题相近不算，绝不串栏。 */
            if (typeof body.title === 'string' && body.title !== '') lastWantTitle = body.title
            const wantedTitle = String(body.title ?? lastWantTitle ?? '')
            if (mounted !== want && directedLogged === false) {
              directedLogged = true
              const names = (svc) => {
                if (svc === undefined) return 'missing'
                let list = []
                let proto = Object.getPrototypeOf(svc)
                while (proto && proto !== Object.prototype && list.length < 50) {
                  list = list.concat(Object.getOwnPropertyNames(proto))
                  proto = Object.getPrototypeOf(proto)
                }
                return [...new Set(list)]
              }
              report({ event: 'svc-sidebar', right: names(scope.get('sidebarRight')), tabs: names(scope.get('sidebarRightTabs')) })
            }
            if (mounted !== want) {
              /* 不在前台也能定向开：往本会话自己的布局里建页签，不碰屏幕上的那一栏。 */
              const directed = scope.get('sidebarRight')
              if (typeof directed?.openTabIn === 'function') {
                try {
                  directed.openTabIn(want, KIND)
                  let opened = 'unknown'
                  try {
                    const list = directed.tabsIn?.(want)
                    opened = Array.isArray(list) ? list.map((tab) => String(tab?.kind ?? tab?.type ?? tab)).join(',') : String(typeof list)
                  } catch (error) { opened = 'ERR ' + String(error?.message ?? error).slice(0, 60) }
                  report({ event: 'directed-open', want: String(want).slice(-8), tabs: String(opened).slice(0, 120) })
                  /* 页签先建好，再把请求挂起：等人回到这一栏，立刻展开并聚焦，不用再叫一次。 */
                  pending = { body: JSON.stringify(body), want, until: Date.now() + 600000 }
                  clearInterval(retry)
                  retry = setInterval(() => {
                    if (pending === undefined) { clearInterval(retry); return }
                    if (Date.now() > pending.until) { pending = undefined; clearInterval(retry); return }
                    onWanted({ data: pending.body }, true)
                  }, 800)
                  return
                } catch (error) {
                  report({ event: 'directed-fail', message: String(error?.message ?? error).slice(0, 120) })
                }
              }
              report({ event: 'want-skip', mounted: blank ? 'blank' : String(mounted).slice(-8), want: String(want).slice(-8), wantedTitle: String(wantedTitle).slice(0, 24), windowTitle: String(document.title ?? '').slice(0, 24) })
              /* 人还没把这一栏切到前台。请求留着：等这一栏真被切上来再开，最多等十分钟。
                 期间不碰任何别的会话那一栏，也不展开。 */
              pending = { body: JSON.stringify(body), want, until: Date.now() + 600000 }
              clearInterval(retry)
              retry = setInterval(() => {
                if (pending === undefined) { clearInterval(retry); return }
                if (Date.now() > pending.until) {
                  pending = undefined
                  clearInterval(retry)
                  report({ event: 'want-expire', want: String(want).slice(-8) })
                  return
                }
                onWanted({ data: pending.body }, true)
              }, 800)
              report({ event: 'want-arm', want: String(want).slice(-8) })
              return
            }
            pending = undefined
            clearInterval(retry)
            const pane = right()
            if (apiLogged === false) {
              apiLogged = true
              try {
                report({ event: 'api', methods: Object.getOwnPropertyNames(Object.getPrototypeOf(pane ?? {})).slice(0, 40) })
              } catch { /* 探不到就算了 */ }
            }
            if (rowsOf(want).some((row) => row.kind === KIND) === false) {
              try { pane?.openTab?.(KIND) } catch { /* 页签被拒：下一跳再看 */ }
            }
            try {
              if (typeof pane?.isExpanded === 'function' && !pane.isExpanded()) pane.toggleExpanded()
            } catch { /* 没有展开能力就这样 */ }
            report({ event: 'want-ok', tabs: rowsOf(want).map((row) => row.kind).slice(-4) })
            const tab = rowsOf(want).find((row) => row.kind === KIND)
            try {
              if (tab !== undefined && typeof pane?.focus === 'function') pane.focus(tab.tabId ?? tab.id)
            } catch { /* 切不过去就等下一跳 */ }
          }
          /* 短等右栏挂上的重试要有限度：每次 onWanted 只排一次，靠 at 去重挡重复请求。 */
          let seenWantAt = 0
          let wantTries = 0
          let apiLogged = false
          let pending
          let lastWantTitle = ''
          let directedLogged = false
          let retry
          let source
          try {
            source = new EventSource(`${ROUTE}/events`) // ui-copy-ignore
            source.addEventListener('message', onWanted)
          } catch {
            source = undefined
          }
          /* 推送之外再补一条拉取：宿主重启过、或页面在后台被节流时，推送会断但轮询还会醒。 */
          const pull = async () => {
            try {
              const response = await fetch(`${ROUTE}/want`, { cache: 'no-store' }) // ui-copy-ignore
              const body = await response.json()
              if (typeof body?.title === 'string' && body.title !== '') {
                lastWantTitle = body.title
                if (pending !== undefined) pending.body = JSON.stringify(body)
              }
              if (typeof body?.session === 'string' && body.session !== '') {
                onWanted({ data: JSON.stringify(body) }, pending !== undefined)
              }
            } catch { /* 宿主没起就下一跳再问 */ }
          }
          const timer = setInterval(pull, 3000)
          void pull()

          return () => {
            clearInterval(timer)
            clearTimeout(retry)
            try { source?.close() } catch { /* 已关 */ }
            for (const dispose of done.reverse()) { try { dispose?.() } catch { /* 已撤 */ } }
          }
        }, 'dsh-mobile-use: 实时镜像面板'))
      },
    }
  },
    })
  } catch (error) {
    window.__ADBM_LOADED__ = false
    throw error
  }
}
