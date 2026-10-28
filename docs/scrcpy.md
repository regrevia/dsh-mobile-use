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
- `-frag_duration` 决定一片多长：40 ms 左右延迟最低但碎片多；静止画面不出帧时就自然不产生流量。
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

测量方式：页面里用 `video.requestVideoFrameCallback` 取每个「已经上屏」的帧，
用它的 `mediaTime` 对 `stream.started` 与 `Date.now()` 算差（`stream.info().lastPts` /
`ptsAgeMs` 是同一套时间刻度的宿主侧对照）。设备 `15ca9736`，边连续滑动边采 4 秒、111 帧：

| 指标 | 值 |
| --- | --- |
| 单帧端到端（含采集、编码、重排、传输、解码、上屏）最小值 | 152 ms |
| 中位 | 168 ms |
| 最大（含一次重连后的追赶帧） | 436 ms |
| `readyState` / 缓冲余量 | 4 / ≈0.1–0.2 s |

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

## 7. 未验证（本轮明确没做的事）

- **真机端到端握手没跑过**：`adb push`、`adb reverse`、`app_process` 启动、设备连回本机端口、
  视频 socket 先到 / 控制 socket 后到的顺序，全部只在代码里实现，没有对着 `15ca9736` 联调。
  也没有在真机上解码过一帧。
- 没有实测 scrcpy 控制 socket 的注入延迟（第 5 节只有 adb `input` 路线的数字）。
- `tunnel_forward=true` 拓扑没测。
- 音频（`audio=true`）、H.265/AV1/VP8/VP9 的实际码流、`max_size`/`max_fps` 等编码参数的效果都没测。
- 控制消息里只实现了按键/文本/触控/返回四类；滚动、剪贴板、旋转、UHID 等只留了枚举值。
- 多指并发（多个 pointerId 同时按下）没测。
- `client.js` 侧的画面 ↔ 设备坐标换算没接；本模块只吃设备坐标。
- 没有接入 `index.js` / 任何插件入口，`package.json` 脚本也没加。

## 8. TODO（下一轮若要接进插件）

1. 先用真机跑一次 `ScrcpyChannel.start()`，确认 socket 顺序与 `video-header` 的 codec/宽高。
2. 把 `video-packet` 喂给 MSE / WebCodecs；`config` 包先构建 `avcC`（`parseAvcConfig` 已有）再做
   `avccToAnnexB`。
3. 侧栏点击 → `client.js` 现有坐标换算 → `pushTouch`，DOWN/MOVE/UP 走同一 pointerId。
4. 断流恢复：`video socket close` → `stop()` → 退避重连；`resetRequired` 时重建 parser。
5. 设备不在线 / 没 root 的降级路径：不能 push server 时退回 `adb shell input`（延迟见第 5 节）。
6. 补一条“真机冒烟”脚本（不进 CI，手动跑），把第 7 节的空白逐项打勾。

## 9. 回归测试

```sh
node test/scrcpy.test.mjs      # 纯内存，不连设备、不 spawn 进程
# === 全部通过 ===（52 项），exit 0
```

覆盖：包头位布局（v5 媒体/session、v3 config）、逐字节重组、半包缓冲、oversize 拒绝、
可用 codec 禁用标记、AVCC→Annex-B、32/14/5+N/2 字节控制消息、UTF-8 边界截断、
server 参数拼装、`stop()` 幂等与敌对对象（child 无 `kill`、socket `destroy` 抛、log 抛）、
未连控制 socket 时 push 返回 false。
