# scrcpy 通道（视频流 + 控制注入）

本文件说明 `scrcpy.js` 的实现依据、协议字节布局、实测数据与边界。**本轮只落地模块，不接进插件**：
没有任何现有文件 import 它，`import` 本身也没有副作用（不起进程、不起定时器、不读设备）。

## 1. vendor 里的 server

| 项 | 值 |
| --- | --- |
| 版本 | scrcpy **v5.0.1** |
| 文件 | `vendor/scrcpy-server`（733,930 字节，无扩展名的 JAR） |
| SHA-256 | `764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536` |
| 来源 | <https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/scrcpy-server-v5.0.1> |
| 许可 | Apache-2.0（与 scrcpy 上游一致） |
| 内容 | JAR/zip，内含 `classes.dex`（2,302,128 字节），靠 `app_process` 直接跑 |

设备端放在 `/data/local/tmp/scrcpy-server.jar`，启动形式（`Server.SERVER_PATH` 取 classpath 第一项）：

```sh
adb -s <serial> shell \
  'CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / com.genymobile.scrcpy.Server <args>'
```

`<args>` 由 `buildServerArgs()` 生成，形如
`5.0.1 scid=0000abcd log_level=info tunnel_forward=false video=true audio=false control=true`。

**版本必须与客户端匹配**：v5.0.1 走 protocol 4.x，包头/字段布局与 2.x–3.x 不同（见第 3 节）。

## 2. 连接拓扑（默认 forward：设备端监听，本机连过去）

```
adb push vendor/scrcpy-server → /data/local/tmp/scrcpy-server.jar
adb forward tcp:<port> localabstract:scrcpy_<scid>      # 本机端口 ← 设备侧抽象 socket
adb shell CLASSPATH=... app_process / com.genymobile.scrcpy.Server ... tunnel_forward=true
本机连 127.0.0.1:<port>：server 在设备侧 accept，第 1 条 socket = 视频，第 2 条 = 控制
```

`scrcpy.js` 的类默认 `tunnelForward: false`（reverse：设备连回本机监听端口），
但插件实际起采集时显式传 `tunnelForward: true`（`scrcpy.js` 里 `startCapture` 的调用点），
因为 forward 不需要设备侧主动连本机、也不受反向网络策略影响。

## 3. 视频流协议

### 3.1 protocol ≥ 4.0（v5.0.1，默认 `protocol: 'v5'`）

1. 首条 socket 先来 **64 字节设备名**：UTF-8，NUL 填充（`DEVICE_NAME_FIELD_LENGTH = 64`）。
2. 紧接 **4 字节 codec id**（u32 BE）：`0` = 流被显式禁用，`1` = 配置失败，其余是 codec 名
   ASCII 打成的 u32（`h264` / `h265` / `\0av1` / `\0vp8` / `\0vp9`）。**不带宽高**。
3. 之后每个包 **12 字节包头**（`SC_PACKET_HEADER_SIZE = 12`，`app/src/demuxer.c`）：

   - `header[0] & 0x80 != 0` → **session 包**（分辨率变化）：
     `client_resized = header[3] & 1`，`width = BE32(header[4..7])`，`height = BE32(header[8..11])`，
     没有 payload。
   - 否则 → **媒体包**：`u64 BE = flags | PTS`（`bit63` session、`bit62` config、`bit61` key frame、
     低 61 位 PTS 微秒），`u32 BE = payload 长度`，随后是这么久的数据。

   H.264/H.265 的 payload 是 MediaCodec 的 AVCC（4 字节长度前缀 NAL）；SPS/PPS 在 config 包里。

### 3.2 protocol < 4.0（2.x–3.x，`protocol: 'v3'`）

- codec 元数据 **12 字节**：codec id(u32) + width(u32) + height(u32)。
- 媒体包头：`bit63` = config、`bit62` = key frame、低 62 位 = PTS；**没有 session 包**。
- 注意：v3 里 config 包最高位也是 1，所以必须显式指定协议，不能靠“最高位=1 就是 session”猜。

`VideoStreamParser` 按 `protocol` 分支；喂错模式会解析出垃圾而不是抛异常（包头位是任意字节时
不 panic 是刻意的，见 3.3）。

### 3.3 容错约定

- 数据不完整 → 留在内层缓冲，**不吐半包**；`parser.buffered` 可查。
- `size > maxPacketSize`（默认 8 MiB）→ 抛一个 `{ code: 'oversize' }` 事件并置
  `parser.resetRequired = true`，后续 push 只回 `{ code: 'reset-required' }`：流已失步，
  必须 `reset()` 或重连，继续解析没有意义。
- 任意字节的包头都不抛（0xFF 全置位会被当 session 包，宽高按 u32 读）。
- `codec 0/1` 与未知 codec 都走 `errors` 数组，不影响后续包。

### 3.4 裸 H.264 → 分片 MP4 → 浏览器 MSE（`stream.js` + `page.js`）

`stream.js` 把 scrcpy 的裸 H.264 喂给宿主 `ffmpeg` 重排成 fMP4，再按 ISO-BMFF box 边界切分：

```
ffmpeg -flags low_delay -use_wallclock_as_timestamps 1 -f h264 -i pipe:0 \
       -copyts -start_at_zero -c copy -frag_duration <fragMs*1000> \
       -movflags empty_moov+default_base_moof -flush_packets 1 -max_delay 0 -f mp4 pipe:1
```

- `-use_wallclock_as_timestamps 1` **必须写在 `-i` 之前**，写在后面等于没写：裸流没有时间戳，
  不加这个参数 ffmpeg 会按 1200000fps 自己编时间轴，播起来像定格（实测 132 s 的流只走 14 s 时间轴）。
- `-frag_duration` 决定一片多长，默认 `fragMs = 10`（即 `-frag_duration 10000`），硬边界
  `Math.min(200, Math.max(10, fragMs))`。碎片越短，攒片等的时间越少；代价是每个 fragment 的
  `moof` 开销。静止画面 scrcpy 不出帧，这时自然没有流量，**不要**把它当卡住。
- 编码参数默认收在 `max_size=1600` / `max_fps=60` / `videoBitRate=8000000`：设备原生
  3200×2136 全量编码会把宿主和链路跑满，实际协商到 **1600×1068**（`video.videoWidth` 已核对）。
  这三个值由 `ScrcpyChannel` → `_spawnServer` → `buildServerShellCommand` 一路透传，
  早期只在 `DEFAULT_OPTIONS` 里写、没透传下去，等于没设，表现为「改了参数设备分辨率不动」。
- socket 帧格式：5 字节头（`type` + BE32 长度），`0 META` / `1 INIT` / `2 MEDIA` / `3 END`。
  INIT（`ftyp`+`moov`）必须在任何 MEDIA 之前；新观众进来先补发 INIT，再按「从一张 IDR 起头的
  连续 GOP」补最近一段（`subscribe` → `sendPrelude`），否则解码器从 P 帧起头直接报错。
- 客户端拼包**只能线性扫一遍**：追加时一次拷贝、解析用游标（`buf.subarray(off)`）。
  早期写成每帧 `Array.from(buf)` + `[].concat` 是 O(n²)，1 MB 的关键帧一多就追不上，
  被服务端按 2 MB 积压断开、重连后又补同一个 GOP，表现为「播 6 秒后永久卡住」。
- MSE 的 `sourceopen` 里**先把 INIT 排进队列，再 `addSourceBuffer`/`attach`**：
  反过来会先把 `sourceopen` 之前排队的分片吐给解复用器，它拿不到 `moov` 就报
  `CHUNK_DEMUXER_ERROR_APPEND_FAILED`，画面全黑。
- MIME 要写全：`video/mp4; codecs="avc1.640034"`（从 SPS 的 profile/level 推），
  只用 `video/mp4` 在部分 Chrome 上 `addSourceBuffer` 直接 `NotSupportedError`。
- 直播边缘靠 `updateend` 里的滞后量维持：`end - currentTime > 0.6 s` 就跳到 `end - 0.06`，
  `> 0.15 s` 用 `playbackRate 1.25` 追。**新页面接上已经跑了一阵的流时，时间轴不是从 0 开始**，
  这时不主动跳进缓冲区间就会停在 `currentTime = 0`、`readyState = 1`，画面永远黑。
- 卡死判定只能看「有没有进展」，不能看「有没有字节」：静止画面本来就不出片。三条判据
  （`page.js` / `client.js` 各一份）：连接后 2.5 s 还没收到 META → 重连（冷启动时 stream 未就绪）；
  队列里还有活但 2 s 没 `updateend` → 重连；缓冲到边缘、`readyState ≥ 3`、2.5 s 时间不走 → 先跳边缘再重连。

## 4. 控制消息字节布局（v5.0.1，`app/src/control_msg.c`）

类型枚举从 0 顺序编号（`CONTROL_MSG_TYPE`）：`0 INJECT_KEYCODE`、`1 INJECT_TEXT`、
`2 INJECT_TOUCH_EVENT`、`3 INJECT_SCROLL_EVENT`、`4 BACK_OR_SCREEN_ON` … `22 SCAN_FILE`。

| 消息 | 长度 | 布局 |
| --- | --- | --- |
| 按键 | 14 | `type u8` · `action u8` · `keycode u32be` · `repeat u32be` · `metastate u32be` |
| 文本 | `5 + len` | `type u8` · `len u32be` · UTF-8 正文；单条上限 **300 字节**，按字符边界截断 |
| 触控 | 32 | `type u8` · `action u8` · `pointerId u64be` · `x i32be` · `y i32be` · `screenWidth u16be` · `screenHeight u16be` · `pressure u16`（0–65535 定点） · `actionButton u32be` · `buttons u32be` |
| 返回/亮屏 | 2 | `type u8` · `action u8` |

`action`：按键 `0 down / 1 up / 2 multi`；触控 `0 down / 1 up / 2 move / 3 cancel / 4 outside`。
特殊 `pointerId`：鼠标 `0xFFFF_FFFF_FFFF_FFFF`、普通手指 `0xFFFF_FFFF_FFFF_FFFE`、
虚拟手指 `0xFFFF_FFFF_FFFF_FFFD`。

坐标必须是**设备屏幕坐标**（不是画面坐标）；侧栏缩放/旋转的换算仍归 `client.js`，
本模块只负责“给定设备坐标 → 字节”。

## 5. 实测延迟（本机 adb，2026-10，7 次取 min/中位/均值）

设备：serial `15ca9736`，Xiaomi Pad 8（`product:yupei`，Android 17，arm64-v8a）。
命令都走完整 `adb -s 15ca9736 shell …` 往返，单位毫秒：

| 操作 | min | 中位 | 均值 |
| --- | ---: | ---: | ---: |
| `shell true`（基线） | 27.8 | 38.0 | 37.3 |
| `input tap 1 1` | 69.1 | 72.1 | 76.0 |
| `input motionevent DOWN 1 1` | 70.5 | 75.1 | 85.8 |
| `input motionevent UP 1 1` | 59.3 | 65.8 | 65.2 |
| 同一条 shell 里 `DOWN;UP` | 92.6 | 103.3 | 106.5 |
| `input keyevent KEYCODE_BACK` | 56.9 | 67.0 | 70.9 |

设备端 `time` 显示 `input tap` ≈0.03 s、`input motionevent` ≈0.02 s，所以成本几乎全在
adb 往返（≈35 ms 基线）+ 每次 `input` 重新拉起 `app_process`（≈20–30 ms）。
把 DOWN/UP 合进一条 shell 省掉一次往返（≈2× 便宜），但仍然每事件一次 JVM。

→ 这正是 scrcpy 控制 socket 的价值：通道建好后，一次触控 = 一个 32 字节写包，
没有 adb 往返、没有 JVM 启动。**上面的数字是 adb 路线，不是 scrcpy 路线的实测值**。

### 5.1 镜像链路实测（scrcpy → ffmpeg → fMP4 → 浏览器 MSE）

测量方式：页面里用 `video.requestVideoFrameCallback` 取每个「已经上屏」的帧的 `mediaTime`，
与宿主侧的 PTS 换算基准对齐：`latency = (performance.timeOrigin + frameCallbackTime) -
(ptsOriginMs + mediaTime * 1000)`。`ptsOriginMs = Date.now() - lastPts * 1000` 由 `stream.info()`
给出，是「宿主时钟 ↔ 分片时间轴」的真实原点。

> 早先版本拿 `stream.started` 当原点，而同一份 ffmpeg 会跨多次订阅复用、PTS 继续往前涨，
> 于是算出来的 152–168 ms 里混进了几十秒的时间轴偏移，属于**测错**，不是链路慢。以本节为准。

设备 `15ca9736`，1600×1068 编码上限，开设置页连续上下滑、采 6.7 秒：

| 指标 | 值 |
| --- | --- |
| 上屏帧数 / 帧率 | 363 帧 / 53.9 fps |
| 单帧端到端（采集→编码→重排→传输→解码→上屏）最小值 | 8 ms |
| 中位 | 39 ms |
| p90 | 46 ms |
| 最大 | 66 ms |
| `readyState` / 缓冲余量 | 4 / ≈0.02–0.1 s |
| 6.7 s 内 `stalls` / `connects` | 0 / 1 |

`ptsAgeMs` 在静止画面上会涨到 1 s 以上：scrcpy 只在画面变化时出帧，静止时「最近一片的
年龄」就是「上一次画面变化距今多久」，不是延迟，别拿它当卡顿证据。

## 6. API

`scrcpy.js`（ESM，零第三方依赖）：

```js
// 常量
SCRCPY_SERVER_VERSION            // '5.0.1'
DEVICE_NAME_FIELD_LENGTH = 64
PACKET_HEADER_SIZE = 12
MAX_PACKET_SIZE = 8 MiB
SCRCPY_PROTOCOL = { V3: 'v3', V5: 'v5' }
CODEC_IDS / PACKET_FLAG / LEGACY_PACKET_FLAG / CONTROL_MSG_TYPE
TOUCH_ACTION / KEY_ACTION / POINTER_ID / ANDROID_KEYCODE
TOUCH_MSG_SIZE = 32 / KEYCODE_MSG_SIZE = 14 / INJECT_TEXT_MAX_LENGTH = 300

// 解析
parseFrameHeader(header12, { protocol }) → { kind:'media', pts, keyFrame, config, size }
                                       | { kind:'session', width, height, clientResized }
new VideoStreamParser({ protocol = 'v5', maxPacketSize = 8MiB })
  .push(chunk) → { header, sessions[], packets[], errors[] }
  .reset() / .state / .buffered / .resetRequired / .info / .stats
avccToAnnexB(buffer, { nalLengthSize = 4 }) → Buffer | null

// 编码（纯函数）
encodeTouch({ action, pointerId, x, y, screenWidth, screenHeight, pressure, actionButton, buttons }) → 32B
encodeKeycode({ action, keycode, repeat, metastate }) → 14B
encodeText(text, { maxLength = 300 }) → 5+len B
encodeBackOrScreenOn(action) → 2B
keycodeFor('BACK' | 'a' | '7' | 66) → number | null
clampU16(v) / floatToU16Fp(v) / codecName(id) / truncateUtf8(text, maxBytes)

// 启动参数
buildServerArgs({ version, scid, logLevel, tunnelForward, video, audio, control, maxSize, maxFps, videoBitRate }) → string[]
buildServerShellCommand({ deviceServerPath, ...同上 }) → string

// 生命周期壳
new ScrcpyChannel({ serial, adbPath, serverPath, deviceServerPath, serverVersion,
                    protocol, host, port, pushServer, video, control, logLevel,
                    readyTimeoutMs, commandTimeoutMs, scid, log })
  await channel.start() → boolean          // 永不 reject
  channel.stop() → true                    // 幂等，残缺/敌对对象也不抛
  channel.pushTouch(input) → boolean
  channel.pushKeycode(input) → boolean
  channel.pushText(text, { maxLength }) → boolean
  channel.pushBackOrScreenOn(action) → boolean
  channel.state / isRunning() / videoConnected / controlConnected / stats
  events: 'video-header' 'video-session' 'video-packet' 'ready' 'closed'
```

事件名是 `video-*` 前缀、载荷是普通对象（`video-packet` 带 `data: Buffer`）。
监听器抛异常会被 `emitSafe` 吞掉：host 不允许有未捕获异常（会 exit 1）。

### 崩溃红线怎么守的

- 所有定时器 / socket / 子进程回调都套 `guardCall(this._logSafe, where, run)`
  （`guardCall` 来自 `stream.js`，签名 `(log, where, run) => boolean`，**返回“没抛”而不是 `run()` 的返回值**，
  所以要拿值的路径都用闭包变量接）。
- `stop()` 先置 `_stopped`/`_state` 再清理，`_dispose()` 逐项 `removeAllListeners` → `destroy()`/`close()`/`kill()`，
  每项单独 guard；清理完把引用置 null，所以重复调用什么都不做。
- 日志回调自己抛异常也不会传播出去（`_logSafe` 内层 try/catch）。
- `start()` 全程 `try/catch`，任何失败统一 `_fail()` → 日志 + `stop()` + 返回 `false`。

## 7. 已验证 / 未验证

已经对着 `15ca9736` 真机跑通并留下数字的：

- `adb push` + `app_process` 起 server、forward 拓扑、video/control socket 顺序（video 先到）。
- 首帧解码 → fMP4 重排 → MSE 上屏；编码上限协商到 1600×1068。
- 触控/滑动/手势/文本/按键经 `/tap` `/scroll` `/swipe` `/gesture` `/input` `/key` 落地。
- 端到端延迟与帧率（第 5.1 节）、断流恢复（`stalls`/`connects` 计数可观测）。
- 人手在侧栏的操作会进宿主时间线，且时间线落盘、热重载后仍在（`/actions` 可查）。

仍然没做或没测的：

- 音频（`audio=true`）、H.265/AV1/VP8/VP9 码流。
- 多指并发（多个 pointerId 同时按下）。
- 开流之后再转屏：坐标空间会失效，目前不自动重算。
- 真手指触摸的坐标：`/dev/input` 的 `getevent` 需要 root，本机虽已 root，但没有真人示范数据，
  所以只记录了「面板动作 + 系统事件」，物理屏触摸仍不可还原。

## 8. 后续可做

1. 手势流式下发（`/touch` 单连接持续喂 DOWN/MOVE/UP），替代每次 `adb shell input` 的进程启动开销。
2. 转屏后自动重建坐标映射（监听 `wm_size` 再算一次缩放）。
3. UHID / 剪贴板 / 旋转控制消息。

## 9. 回归测试

```sh
node test/scrcpy.test.mjs      # 纯内存，不连设备、不 spawn 进程
# === 全部通过 ===（54 项），exit 0
```

覆盖：包头位布局（v5 媒体/session、v3 config）、逐字节重组、半包缓冲、oversize 拒绝、
可用 codec 禁用标记、AVCC→Annex-B、32/14/5+N/2 字节控制消息、UTF-8 边界截断、
server 参数拼装、`stop()` 幂等与敌对对象（child 无 `kill`、socket `destroy` 抛、log 抛）、
未连控制 socket 时 push 返回 false。

## 10. 静止画面出画要几秒？（2026-11 实测，已修）

现象：设备端首包几十毫秒就到宿主，但浏览器侧要到 ~6.3 秒才看见第一帧，且每次冷启动都一样。宿主日志里量「moov 距首包」= **+5184 ms**。

成因不在 scrcpy，也不在 MSE，而在转封装那一段：`ffmpeg -f mpegts -i pipe:0` 默认 `probesize=5000000`、`analyzeduration=5000000`。探测阶段要攒够数据或攒够 5 秒才肯认定流格式，静止桌面几乎没有新帧，于是每次都是 5 秒超时才吐 moov，之后浏览器才有初始化段。

改法：喂给 ffmpeg 的是我们自己封的 TS，第一包就带 PAT/PMT + SPS/PPS，不需要它猜：

```
-probesize 32000 -analyzeduration 0 -f mpegts -i pipe:0
```

改完后同一台设备、同一份代码：

| 场景 | 改前 | 改后 |
| --- | --- | --- |
| 冷启动首帧（宿主 reload / 显式 stop 后） | 6297–6325 ms | 1261–1511 ms |
| 面板关掉再打开（120 秒宽限内，采集还活着） | 6290 ms | 252 ms |

回归判据：调试日志里 `moov 就绪 +Nms（自首包）` 应 < 200 ms；若又回到几秒，先查这两项有没有被别处覆盖。

### 10.1 顺带修掉的两个连带问题

- **显式 stop 之后的失败冷却**：`/stream/stop?confirm=1` 只清了通道对象，没清 `failed` 冷却（10 秒）。冷却期内 `channelFor()` 一律返回 null，只能退回 `screenrecord`，于是「停一下再开」反而慢且糊。现在停流时连冷却一起清，冷却也从 10 秒收到 4 秒。
- **设备端残留**：`adb forward --remove` 不会杀死设备端的 scrcpy-server，它会一直占着编码器（下一次启动表现为「没有帧」）。现在 `ScrcpyChannel._dispose()` 按 scid 精确收掉：`pkill -9 -f 'scid=<hex8>'`，再用 `ps | grep -F` 兜底。screenrecord 回退路径同理，会在 stop 时按 pid 文件前缀横扫一遍，逐个核对 `/proc/<pid>/comm` 是 `screenrecord` 才杀。

## 11. 给模型看的人话时间线（`deviceStory`）

`logcat -b events` 的原始行模型读起来很费劲（`am_focused_activity [...] am_proc_died ...`）。`describe_device_event()` 把七类事件翻成一句中文：切页 / 启动 / 退出 / 崩溃 / 无响应 / 被系统杀掉；`deviceStory(serial, windowMs)` 再去掉系统组件噪声、合并「同一次退出的 am_kill + am_proc_died」、按时间倒序给最多 6 条。

两处入口都在用同一份实现，别各写一套：

- `adb_events` 工具输出末尾追加「人话时间线（倒推，直接照着回答用户）」；
- 侧边栏标注 `annotate()` 回给模型的本来就是这份时间线；
- 调试直读：`GET /dsh-mobile-use/story?serial=<serial>`。

## 12. 冷启动黑屏三连坑（2026-10-28 实测）

**先记住两条口径**：关掉右栏不会停流，`ADBM_IDLE_GRACE_MS`（默认 120s）内再打开就是暖启动（253ms）；要复现冷启动只能打 `POST /dsh-mobile-use/stream/stop?confirm=1`，它是唯一立刻断流的入口。

症状：面板打开先黑 6–13 秒，出来的是 720p（screenrecord），过一会儿才切回 1600×1068；日志里 `看门狗：8 秒没有初始化段，重建采集链路` 反复出现。三个独立原因叠在一起，缺一个都修不好：

1. **sweep 杀掉刚 spawn 的 recorder。** `spawnRecorder()` 里调过一次 `sweepOwnRecorders()`，它是异步的（`adb shell ps` 再 `kill -9`），`ps` 回来时新 recorder 已经在，于是自己杀自己：`spawn session=N` → `recorder-exit code=0` → 无限重建。修法：spawn 路径不再 sweep，只在 `stop()` 里清。
2. **通道 entry 被 `closed` 清空后永不重建。** `channelFor()` 只在 `entry === undefined` 时 new 通道；`closed` 把 `entry.channel` 置 null 但 entry 还在，于是永远 `ready = null`、永远不重连，采集源退回 screenrecord。修法：`channel === null && !starting && !failed` 时扔掉 entry 重造。
3. **`sourceWaitFailed` 是永久判决。** 冷启动时等通道超时一次，标志永不复位，之后每次 spawn 直接跳过等通道，钉死在回退路径。修法：换成时间戳 `sourceWaitAt`，8 秒窗口后允许再等。

配套等待策略：通道还在连（`starting`/`idle`/`none`）就继续等，最多 12 秒，只有明确 `failed` 才退回 screenrecord。提前起 screenrecord 会抢走设备编码器，反而让 scrcpy 彻底起不来——这是「越等越慢」的真因，不是等太久。

冷启动顺带省两处时间：设备上已有同尺寸 server 就跳过 `adb push`（省 300–600ms，`ADBM_FORCE_PUSH=1` 强制重推）；设备端 jar 改用独立路径 `/data/local/tmp/dsh-mobile-use-scrcpy-server.jar`，避免和别的 scrcpy 工具互相覆盖导致尺寸判断失真。

修完实测（`/stream/stop?confirm=1` 后重新打开）：

| 场景 | 首帧时间 | 分辨率 |
| --- | --- | --- |
| 冷启动 ×3 | 1006 / 1509 / 1516 ms | 1600×1068 |
| 暖启动（120s 空闲宽限内再打开） | 253 ms | 1600×1068 |

## 13. 低延迟手势通道（实测）

`POST /dsh-mobile-use/gesture`（同族还有 `/tap`、`/swipe`、`/raw`、`/pinch`）：通道活着时直接往 scrcpy 控制 socket 注入触摸序列，不走 `input`/u2。响应里的 `engine` 说明实际走的哪条路：

| 路径 | 往返耗时（含 16ms 动作时长） |
| --- | --- |
| `engine: "scrcpy"` | p50 20ms / p90 177ms（14 次）；120ms 动作时 p50 142ms ≈ 下发开销 22ms |
| `engine: "adb-input"`（通道不可用回退） | p50 172ms |

回退要如实标注：`{"ok":true,"engine":"adb-input"}`。两条路差一个数量级，模型据此判断手感对不对，别让它猜。
