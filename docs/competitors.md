# dsh-mobile-use 竞品能力矩阵（2026-10）

> 结论：镜像/低延迟这一层 **scrcpy 生态仍是最强基线**（35–70 ms 自述、30–120 fps、音频转发、虚拟显示），我们只在其上是「够用」；观测与「给模型看懂界面」这一层 **我们领先且没有直接对手**——文本树 120 ms、圈选回传、动效量化三件在同类里找不到等价物；我们最缺的是**多点触控、音频、端到端延迟实测**。

## 0. 口径

| 标记 | 含义 |
| --- | --- |
| 【实测】 | 本仓库 `docs/bench.md` 的数字，或作者在小米平板 8（3200×2136 / Android 15 / USB）上的工具自报耗时 |
| 【厂商口径】 | 官方 README / 官方文档自述，未在本机复现 |
| 【未核实】 | 没有找到一手来源，不给数字、不下结论 |

三张表分开是因为「镜像类」和「自动化类」解决的不是同一个问题，硬塞一张表会把空白误读成劣势。

## 1. 镜像与人机交互类

| 维度 | scrcpy | QtScrcpy | Escrcpy | AS Running Devices | AS Layout Inspector | Vysor | AirDroid | Genymotion | WSA | 证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 可交互延迟 | ✔ 35–70ms【厂商口径】 | ✔ 1080p<30ms【厂商口径】 | 部分 继承 scrcpy【未核实】 | 部分 无公开数字【未核实】 | — | 部分 无公开数字【未核实】 | 部分 走网络【未核实】 | 部分 本地虚拟屏【未核实】 | 部分 无数字【未核实】 | [scrcpy README](https://github.com/Genymobile/scrcpy/blob/master/README.md)、[QtScrcpy README](https://github.com/barry-ran/QtScrcpy) |
| 画面编码路径 | ✔ 设备 H.264/H.265 编码→宿主解码 | ✔ 同 scrcpy | ✔ 同 scrcpy | 部分 未公开【未核实】 | — | 部分 自研编码，免费档限画质【厂商口径】 | 部分 自研/网络编码【未核实】 | 部分 虚拟显示直读 | 部分 虚拟化+自绘 | [scrcpy video.md](https://github.com/Genymobile/scrcpy/blob/master/doc/video.md)、[Vysor 画质说明](https://github.com/koush/vysor.io/wiki/Video-Quality-Guide) |
| 需装 APK / 开端口 | ✔ 不装应用、不留残留、不开端口（临时推 server jar） | ✔ 同 | ✔ 同 | ✔ 仅 adb | ✔ 仅 adb | ✘ 需装 APK/桌面端 | ✘ 需装 App + 账号 | ✔ 虚拟设备 | ✔ 内置 | [scrcpy README](https://github.com/Genymobile/scrcpy/blob/master/README.md)、[Vysor](https://github.com/koush/vysor.io)、[AirDroid](https://www.airdroid.com/personal/) |
| 多端同时看 | 部分 未见多客户端说明【未核实】 | ✔ 多设备/批量、OTG 单机 500+【厂商口径】 | ✔ 多设备并行+广播输入【厂商口径】 | 部分 多设备窗口 | — 单进程快照 | 部分 有分享/多设备【未核实】 | ✔ 多设备管理 | ✔ 多实例 | — | [QtScrcpy](https://github.com/barry-ran/QtScrcpy)、[Escrcpy](https://github.com/viarotel-org/escrcpy) |
| 鼠标键盘映射 | ✔ 含鼠标按键绑定/物理键盘 HID | ✔ 含按键映射脚本 | ✔ 含按键映射 | ✔ | — | ✔ | ✔ | ✔ | 部分 | [scrcpy mouse.md](https://github.com/Genymobile/scrcpy/blob/master/doc/mouse.md) |
| 多点触控/双指捏合 | 部分 文档未明示捏合手势【未核实】 | ✔ 官方特性「multi-touch」【厂商口径】 | 部分 靠按键映射模拟【厂商口径】 | 部分 未核实手势覆盖 | — | 部分 未核实 | 部分 未核实 | 部分 未核实 | — | [QtScrcpy](https://github.com/barry-ran/QtScrcpy)、[scrcpy control.md](https://github.com/Genymobile/scrcpy/blob/master/doc/control.md) |
| 滚动映射 | ✔ 滚轮 | ✔ | ✔ | ✔ | — | ✔ | ✔ | ✔ | 部分 | [scrcpy control.md](https://github.com/Genymobile/scrcpy/blob/master/doc/control.md) |
| 剪贴板双向 | ✔ 双向自动同步 | 部分 继承【未核实】 | ✔ 继承 | 部分 未核实 | — | 部分 未核实 | 部分 未核实 | 部分 未核实 | 部分 | [scrcpy control.md#copy-paste](https://github.com/Genymobile/scrcpy/blob/master/doc/control.md) |
| 文件推拉 | 部分 拖放推送/装 APK，无拉取 | ✔ 文件传输+装 APK | ✔ 文件管理器 | 部分 Device Explorer | — | 部分 未核实 | ✔ 强项 | ✔ | 部分 | [QtScrcpy](https://github.com/barry-ran/QtScrcpy)、[AirDroid](https://www.airdroid.com/personal/) |
| 音频转发 | ✔ Android 11+ | 部分 开发中【厂商口径】 | ✔ 继承 | ✔ 有 Audio redirection | — | ✔ 新版本含音频【厂商口径】 | 部分 未核实 | 部分 未核实 | ✔ | [scrcpy audio.md](https://github.com/Genymobile/scrcpy/blob/master/doc/audio.md)、[AS device mirroring](https://developer.android.com/studio/run/device) |
| 录屏/回放 | ✔ `--record` | ✔ | ✔ | 部分 未核实 | — | 部分 未核实 | 部分 未核实 | 部分 未核实 | — | [scrcpy recording.md](https://github.com/Genymobile/scrcpy/blob/master/doc/recording.md) |
| 截图 | 部分 未核实专门入口 | ✔ | ✔ | 部分 未核实 | — | ✔ | ✔ | ✔ | 部分 | [QtScrcpy](https://github.com/barry-ran/QtScrcpy) |
| 文本树/控件树 | — | — | — | — | ✔ 仅可调试应用、实时层级 | — | — | — | — | [Layout Inspector](https://developer.android.com/studio/debug/layout-inspector) |
| 崩溃/ANR 采集 | — | — | — | 部分 Logcat 窗口，无崩溃摘要 | — | — | — | — | — | [AS device mirroring](https://developer.android.com/studio/run/device) |
| 性能(CPU/内存/帧率) | 部分 `--print-fps` | 部分 未核实 | 部分 未核实 | 部分 Profiler 需可调试应用 | — | — | — | — | — | [scrcpy video.md](https://github.com/Genymobile/scrcpy/blob/master/doc/video.md) |
| 动效逐帧测量 | — | — | — | — | — | — | — | — | — | 上述官方文档均无此能力 |
| 给 LLM 的结构化遥测 | — | — | 部分 内置 Copilot（消费侧）【厂商口径】 | — | 部分 层级是给人看的 | — | — | — | — | [Escrcpy](https://github.com/viarotel-org/escrcpy) |
| 在画面标注并回给对话 | — | — | — | — | — | — | — | — | — | 无竞品提供 |
| 无头/CI 可用 | 部分 `--no-playback --no-window` | — | — | — | — | — | — | 部分 | — | [scrcpy recording.md](https://github.com/Genymobile/scrcpy/blob/master/doc/recording.md) |
| 许可与成本 | Apache-2.0 免费 | 开源免费【未核实具体条款】 | 部分 基础免费、高级功能付费【厂商口径】 | 随 Studio 免费 | 同左 | 部分 免费档+Pro【未核实价格】 | 部分 免费+订阅（官网标 3.99 美元/月起）【厂商口径】 | 商业付费【未核实价格】 | 已于 2025-03-05 停服【厂商口径】 | [scrcpy LICENSE](https://github.com/Genymobile/scrcpy)、[WSA 停服](https://learn.microsoft.com/en-us/windows/android/wsa/)、[AirDroid](https://www.airdroid.com/personal/) |
| 备注 | 生态事实标准 | 群控/按键映射 | GUI+AI | 开发向镜像 | 层级调试 | 老牌闭源 | 设备管理 | 虚拟设备 | 已停服 | |

## 2. Agent / 自动化类（+ 云真机对照）

| 维度 | adb+uiautomator 原生 | Appium | Maestro | uiautomator2(py) | Auto.js | mobile-mcp | Mobilerun(droidrun) | 云真机(Device Farm/BrowserStack/FTL) | 证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 可交互延迟 | 部分 dump 350ms 级；单动作进程级【实测】 | 部分 HTTP 往返叠加【未核实】 | 部分 驱动层直连【未核实】 | 部分 HTTP 客户端→设备端服务【未核实】 | 部分 设备内无障碍，低【未核实】 | 部分 adb 直连【未核实】 | 部分 adb 直连【未核实】 | ✘ 跨网络，秒级【未核实】 | [uiautomator2](https://github.com/openatx/uiautomator2)、本仓库 bench.md |
| 画面编码路径 | — 无连续画面（screencap 单帧） | 部分 screenshot 单帧 | 部分 screenshot 单帧 | 部分 screenshot 单帧 | — 设备内，无宿主画面 | 部分 screenshot 单帧 | 部分 screenshot/多模态截图 | 部分 云端视频流【厂商口径】 | [mobile-mcp](https://github.com/mobile-next/mobile-mcp)、[uiautomator2](https://github.com/openatx/uiautomator2) |
| 需装 APK / 开端口 | 部分 u2 需推 jar/装 apk | ✘ 需 appium server（默认开端口） | ✘ 驱动/服务端 | ✘ 推 apk+jar，HTTP 端口 | ✘ 装 App（无障碍服务） | 部分 需 npx MCP 进程 | 部分 需装 portal APK【未核实】 | ✘ 需上传 App | [Appium](https://github.com/appium/appium)、[Maestro](https://github.com/mobile-dev-inc/maestro)、[uiautomator2](https://github.com/openatx/uiautomator2) |
| 多端同时看 | — | ✔ 多 session | 部分 多设备并行 | ✔ 多设备 | — | ✔ 多设备列表 | ✔ Android+iOS | ✔ 设备池 | 同上 |
| 鼠标键盘映射 | — | 部分 无真人映射概念 | — | — | — | 部分 按键/输入非映射 | 部分 | 部分 云端网页交互 | [mobile-mcp](https://github.com/mobile-next/mobile-mcp) |
| 多点触控/双指捏合 | 部分 u2 `gesture` 支持多指 | 部分 W3C multi-action | 部分 swipe 组合 | ✔ 多指手势 | 部分 手势 API | 部分 swipe/gesture【未核实捏合】 | 部分 | 部分 未核实 | [uiautomator2](https://github.com/openatx/uiautomator2) |
| 滚动映射 | 部分 坐标滚动 | ✔ | ✔ scroll | ✔ | ✔ | ✔ | ✔ | 部分 | 同上 |
| 剪贴板双向 | 部分 需 shell 命令 | 部分 UiAutomator2 get/setClipboard【厂商口径】 | 部分 输入文本 | 部分 setClipboard（本仓库即用此路）【实测】 | 部分 | 部分 未核实 | 部分 | 部分 | [appium-uiautomator2-driver](https://github.com/appium/appium-uiautomator2-driver) |
| 文件推拉 | ✔ adb push/pull | 部分 pushFile/pullFile | 部分 | ✔ push/pull | 部分 | 部分 仅 install【未核实】 | 部分 | 部分 上传/下载 | [Appium](https://github.com/appium/appium)、[uiautomator2](https://github.com/openatx/uiautomator2) |
| 音频转发 | — | — | — | — | — | — | — | — | 均无 |
| 录屏/回放 | 部分 screenrecord 单段 | ✔ startRecordingScreen | ✔ 录制 | ✔ screenrecord 封装 | 部分 | ✔ 录屏工具 | 部分 | ✔ 云端录像 | [mobile-mcp](https://github.com/mobile-next/mobile-mcp)、[Maestro](https://github.com/mobile-dev-inc/maestro) |
| 截图 | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | 同上 |
| 文本树/控件树 | ✔ 原始 XML，慢 | ✔ page source | ✔ 无障碍层 | ✔ 快、支持 XPath | ✔ 设备内无障碍 | ✔ 结构化快照 | ✔ 树+截图 | 部分 需脚本自取 | [mobile-mcp](https://github.com/mobile-next/mobile-mcp)、[Maestro](https://github.com/mobile-dev-inc/maestro) |
| 崩溃/ANR 采集 | 部分 logcat 自己解析 | 部分 logcat | — | 部分 | — | ✔ 崩溃列表/详情 | 部分 | ✔ 云端日志 | [mobile-mcp](https://github.com/mobile-next/mobile-mcp) |
| 性能(CPU/内存/帧率) | 部分 dumpsys 自取 | 部分 | — | 部分 | — | 部分 device logs | 部分 | ✔ 性能报告/帧率图【厂商口径】 | [Firebase Test Lab](https://firebase.google.com/docs/test-lab/android/robo-ux-test) |
| 动效逐帧测量 | — | — | — | — | — | — | — | — | 均无 |
| 给 LLM 的结构化遥测 | 部分 原始 XML 需自压 | 部分 JSON 但为测试协议 | 部分 YAML/Studio | 部分 结构化但非 LLM 口径 | — | ✔ 无障碍快照为首选 | ✔ 树+截图融合 | 部分 | [mobile-mcp](https://github.com/mobile-next/mobile-mcp)、[Mobilerun](https://github.com/droidrun/mobilerun) |
| 在画面标注并回给对话 | — | — | — | — | — | — | — | — | 均无 |
| 无头/CI 可用 | ✔ | ✔ 强项 | ✔ 强项（CI 集成） | ✔ | — | 部分 需 MCP 宿主 | 部分 CLI/Docker | ✔ 强项 | [Maestro](https://github.com/mobile-dev-inc/maestro)、[AWS Device Farm](https://aws.amazon.com/device-farm/features/) |
| 许可与成本 | Apache-2.0 | Apache-2.0 | Apache-2.0/商业云 | MIT/Apache | 部分 开源版+付费 Pro | Apache-2.0【未核实】 | 开源+云 | 按分钟/设备计费【厂商口径】 | [Maestro](https://github.com/mobile-dev-inc/maestro)、[BrowserStack App Live](https://www.browserstack.com/app-live) |
| 备注 | 底层能力，不是产品 | 测试协议标准 | YAML 流程 | 我们借它的设备端 | 脚本化 RPA | 与我们最像的 MCP 竞品 | LLM 原生 agent | 对照项，非本地方案 | |

## 3. dsh-mobile-use 逐维度对照（vs 该维度最强竞品）

| 维度 | dsh-mobile-use | 最强竞品 | 判定 | 证据 |
| --- | --- | --- | --- | --- |
| 可交互延迟 | 22.9 fps、帧间隔 p50 41 ms / p90 42 ms（**这是出帧节奏，不是端到端输入延迟**，端到端未测）【实测】 | scrcpy 35–70 ms【厂商口径】 | 输（口径不同，不能直接比） | [bench.md](./bench.md)、[scrcpy](https://github.com/Genymobile/scrcpy/blob/master/README.md) |
| 画面编码路径 | 设备 screenrecord H.264 裸流 → 宿主 ffmpeg 抽帧转 JPEG → 长轮询 | scrcpy 设备编码→宿主直接解码上屏 | 输（多一次转码，带宽高） | [bench.md](./bench.md) |
| 需装 APK / 开端口 | 不装 App；HTTP 只监听 127.0.0.1，peer/Host/Origin 三重校验，伪造来源实测 403 | scrcpy 同 | 平 | [README.md](../README.md) |
| 多端同时看 | 观看者集合按连接计数，多人看同一设备不多抓帧【未核实并发实测】 | QtScrcpy 群控 500+【厂商口径】 | 输 | [QtScrcpy](https://github.com/barry-ran/QtScrcpy) |
| 鼠标键盘映射 | 点/长按/拖拽/滚轮/键盘/中文输入，坐标按真实媒体矩形归一化 | scrcpy 全量+游戏按键映射 | 平（缺按键映射脚本） | [README.md](../README.md) |
| 多点触控/双指捏合 | — `input motionevent` 单指，明确不支持 | uiautomator2 `gesture` 多指 | 输（明确短板） | [README.md](../README.md#L82)、[uiautomator2](https://github.com/openatx/uiautomator2) |
| 滚动映射 | ✔ `/scroll` 60 ms 合并，实测 146 ms | scrcpy 滚轮 | 平 | [bench.md](./bench.md) |
| 剪贴板双向 | 部分 只写不读（`setClipboard` 注入中文） | scrcpy 双向自动同步 | 输 | [scrcpy control.md](https://github.com/Genymobile/scrcpy/blob/master/doc/control.md) |
| 文件推拉 | 部分 仅 APK 安装（`adb_app install`），无通用 push/pull | adb 原生、AirDroid、Escrcpy | 输 | [README.md](../README.md) |
| 音频转发 | — | scrcpy Android 11+ | 输 | [scrcpy audio.md](https://github.com/Genymobile/scrcpy/blob/master/doc/audio.md) |
| 录屏/回放 | 部分 本地环形 3 分钟（10 s×18 段）+ 6 帧拼图，无导出成片 | scrcpy `--record` 任意时长 | 输（无归档导出） | [bench.md](./bench.md)、[scrcpy recording.md](https://github.com/Genymobile/scrcpy/blob/master/doc/recording.md) |
| 截图 | ✔ 612–665 ms 落盘；直播在放时 1 ms 取最新帧 | 各家单帧截图 | 平/略赢（1 ms 复用） | [bench.md](./bench.md) |
| 文本树/控件树 | ✔ uiautomator2 常驻 96–129 ms、120 ms 返回可点树；`adb_window` 全部可见窗口；OCR 兜底 1771 ms；CDP 读 H5 DOM | Layout Inspector 仅可调试应用且面向人 | **赢** | [bench.md](./bench.md)、[Layout Inspector](https://developer.android.com/studio/debug/layout-inspector) |
| 崩溃/ANR 采集 | ✔ `adb_crash` 165–194 ms：FATAL 摘要+dropbox/anr | mobile-mcp 有崩溃列表/详情 | 平/略赢（含现场文件） | [bench.md](./bench.md)、[mobile-mcp](https://github.com/mobile-next/mobile-mcp) |
| 性能采集 | ✔ `adb_proc` 49 ms（top/mem/list） | AS Profiler 需可调试 | 赢（真机非可调试也能看） | [bench.md](./bench.md) |
| 动效逐帧测量 | ✔ `adb_watch`/`adb_anim`/`adb_motion`：抖动、超调、稳定耗时；`adb_motion` 380 ms（磁盘段）/3.4–4.7 s（现录） | 无同类 | **赢（唯一）** | [bench.md](./bench.md) |
| 给 LLM 的结构化遥测 | ✔ 树压成 200–1300 token 文本+坐标+可点标记；`adb_do` 多步一回合（2 步 318 ms） | mobile-mcp 无障碍快照 | 平/略赢（token 更省、含中文 OCR） | [README.md](../README.md)、[mobile-mcp](https://github.com/mobile-next/mobile-mcp) |
| 在画面标注并回给对话 | ✔ 圈选→圈内控件+前 12 s 操作时间线+6 帧拼图，回传 `~/.dsh/adb-mirror/annotations/` | 无 | **赢（唯一）** | [README.md](../README.md) |
| 无头/CI 可用 | 部分 依赖 DSH 宿主；`selftest.mjs` 只读但非 CI 产品 | Maestro/Appium/云真机 | 输 | [Maestro](https://github.com/mobile-dev-inc/maestro) |
| 许可与成本 | MIT，零外部服务，全本机 | scrcpy Apache-2.0 免费 | 平 | [LICENSE](../LICENSE) |

## 4. 我们领先的 3 件事

1. **文本优先的观测链**（`adb_ui` 120 ms / `adb_window` 全窗口 / OCR 兜底 / `adb_web` 读 DOM）。镜像类竞品没有控件树；自动化类有树但没有画面。我们把「树 + 画面 + 坐标」放在同一条时间线上，且成本压在 200–1300 token。【实测】
2. **人在画面上标注 → 结构化上下文回给模型**。圈选区域、圈内控件、前 12 秒操作时间线、最近 6 秒 6 帧拼图（365–443 ms，不碰设备）一起进对话。这是「人机协同调试」缺的一环，15 个对照项里没有任何一家提供。【实测】+【无竞品】
3. **动效与性能的量化工具**（`adb_motion` / `adb_watch` / `adb_proc` / `adb_crash`），把「看着有点抖」变成「9 次方向反转、单帧跳变 157 px、稳定 620 ms」。所有竞品要么只给帧率，要么只给原始 dumpsys。【实测】

## 5. 我们还差的 5 件事（按投入产出排序）

| # | 差距 | 现状 | 竞品做法 | 投入产出判断 |
| --- | --- | --- | --- | --- |
| 1 | 多点触控/双指捏合 | 单指 `input motionevent`，明确不支持 | uiautomator2 `gesture`、QtScrcpy multi-touch、Appium multi-action | 高：移动端「缩放/双指」是日常动作，u2 设备端已在跑，接入面小 |
| 2 | 端到端延迟未测 + 帧路径多一次转码 | 22.9 fps / p50 41 ms 只是出帧节奏；H.264→ffmpeg→JPEG→长轮询 | scrcpy 设备编码→宿主硬解直上屏（35–70 ms 自述） | 高：先补「输入→画面」的量化口径，再决定要不要 MSE/WebCodecs 直通 |
| 3 | 音频转发 | 无 | scrcpy `--audio`（Android 11+） | 中高：`screenrecord` 已占编码通道，音频要另开 `--audio-source` 或 u2 路 |
| 4 | 剪贴板单向 + 无通用文件推拉 | 只 `setClipboard` 写；只有 APK 安装 | scrcpy 双向剪贴板、QtScrcpy/Escrcpy 文件管理 | 中：读回剪贴板一条 shell；push/pull 是 `adb` 两行封装 |
| 5 | 无头/CI 与可脚本化流程 | 依赖 DSH 宿主，`selftest.mjs` 只读 | Maestro YAML、Appium、云真机 | 中低：短期价值在于「回归自测」而不是对外卖 CI |

补充（第 6–7 项，不进前五）：多设备并行/群控（QtScrcpy 500+）、录制归档导出（scrcpy `--record` 任意时长，我们只有 3 分钟环形）。

## 6. 需要补的核实

- scrcpy 是否支持双指捏合、是否有独立截图入口——官方文档未明示，需在真机上跑一次。
- Vysor / AirDroid 的延迟与画质档位只有营销页，未找到一手实测。
- Android Studio Running Devices 的镜像编码路径未公开。
- 云真机三家的「可交互延迟」没有官方数字，只能标注为跨网络、非本地方案。

## 7. 2026-10-29 复评（对 v1.4.1 外部审查的回应）

审查原话是「具备较完整的手机操控能力，但还不能判定为可长期稳定使用的 Android 开发调试系统，
也没有超过所有竞品」。这一节的结论**同意审查**，并把能改的和改不了的写清楚。

### 7.1 已修：触控坐标空间（审查没抓到，比它列的更致命）【实测】

scrcpy 的 `PositionMapper` 是按**编码尺寸**建的：
`ScreenCapture.java:165` → `PositionMapper.create(videoSize, transform, deviceSize)`，
`Controller.java:493` 收到触控时先比对 `position.getScreenSize()` 与 `positionMapper.getVideoSize()`，
不一致就打一行 `Ignore positional event generated for size …` 把事件丢掉；一致才按 video→device 矩阵放大。
默认 `--max-size 1600` 把 2136×3200 压成 1068×1600，我们之前一直发设备尺寸 + 设备坐标。

本机实测（设备 `15ca9736`，视频 1068×1600，verbose 日志，只发 MOVE 不按下）：

| 发法 | server 日志 | 结果 |
| --- | --- | --- |
| `screenWidth/Height = 2136x3200`，点位设备像素（旧） | `Ignore positional event generated for size …` | 事件被丢弃 |
| `screenWidth/Height = 1068x1600`，点位缩到视频像素（新） | 无该行 | 事件被接收 |

这条修掉之后，「agent 点的位置和它想点的控件对不上」这一类鬼故事才算有了解释；
`deviceToVideoPoint` 有单测（2136×3200→1068×1600 的边角/夹取/尺寸缺失），回归 56 项。

### 7.2 仍然不领先的地方（不用口径糊过去）

| 维度 | 我们 | 最强对照 | 判定 |
| --- | --- | --- | --- |
| 可交互延迟（人肉镜像） | agent 侧「看到屏」已进两位数毫秒：颜色网格 41–127 ms、OCR 112 ms【实测】；人肉镜像端到端仍未在客户端测【未核实】 | scrcpy 35–70 ms【厂商口径】 | 观测侧打平/反超，镜像侧不宣称 |
| 多点/捏合手势 | 有 `adb_pinch`/多指 gesture 命令，scrcpy 通道也支持多 pointerId【实测】 | QtScrcpy 多指【厂商口径】 | 打平，缺真机逐点验证 |
| 长稳（≥8 h） | 内存 / 进程 / 临时文件三条链路的实测见 §7.2.2【实测】；连续 8 h 单次运行仍未跑完 | 无竞品公开长稳数据 | 接近，不宣称 8 h |
| 资源治理（所有者/取消入口、代际校验、配额） | 每个缓存/缓冲都有显式上限；僵尸解码进程 6 s 自愈【实测】 | — | 已补上主要缺口 |
| Windows 宿主 | 只有 macOS 实测【未核实】 | scrcpy 三平台 | 缺口 |
| 音频、双向剪贴板、通用文件推拉 | 剪贴板双向、文件推/拉已有【实测】；音频仍无 | scrcpy、QtScrcpy | 仅差音频 |

### 7.2.1 替代视觉通道（不进视觉模型也能看屏）【实测】

| 通道 | 冷启 | 热（第二次起） | 内容 |
| --- | --- | --- | --- |
| 控件树 `adb_ui` | 171–233 ms | 同左（每次都真读设备） | 节点 id/文本/可点/坐标 |
| 文本树 `adb_find` | 99 ms | — | 文本命中节点 |
| 颜色网格 `adb_look` | ~900 ms（首次要起推流） | 41–127 ms | 12×18 字母网格 + 图例，模型按字母认布局 |
| OCR `adb_ocr` | 1656 ms（起推流 + 原图） | 112 ms（复用推流帧） | 21–24 段文字与坐标 |
| 原图 OCR（不走上表） | 820 ms/次 | 无复用 | 24/24 段，作为准确性兜底 |
| 状态 `adb_state` | 145 ms（125–195 ms） | 同左 | 前台页/焦点窗口/窗口栈/键盘/方向/亮度/电量；七条 `dumpsys` 并发跑，串行要 371 ms |

推流帧按**当前朝向**取尺寸（解析 `dumpsys window displays` 的 `cur=WxH`，90 s 缓存）：
这台平板竖着 2400×1602、横过来 3200×2136 都能拿到整屏，不再出现「帧里 60% 是黑边」。
原始流长边 2400，JPEG 桥接再缩到长边 1400（实测 1400×935，横屏比例 1.497），
因此 OCR 能直接认桥接帧：全帧 22 段，纯识别热态 118–122 ms。
没人在看侧栏时，第一条工具调用点火推流、下一次起就是 0 ms 取帧，空闲 120 s 自动回收。

### 7.2.2 稳定性：内存、栈、僵尸进程、临时文件【实测】

外部审查说「还不能判定可长期稳定使用」，逐条用实测回应（设备 15ca9736，2026-10-31）：

| 风险 | 结论 | 证据 |
| --- | --- | --- |
| 堆泄漏 | 1000 轮 `adb_ui` 后堆增量 **1.59 MB**（1.63 KB/轮），曲线在第 400 轮后走平 | `--expose-gc` 每轮 dump 后 `heapUsed`：9.28→9.61 MB |
| 栈溢出 | 3 万层嵌套 XML 解析 **514 ms 不爆栈**、`compactTree` 限深 400 行正常 | `parseNodes` 是显式栈迭代，不是递归；无调用栈增长 |
| 宽度爆炸 | 12 万节点 XML 解析 **23 ms**，两万个节点处**硬截断**（`truncated` 标注、回执里说明），输出再被 `maxNodes` 截到 400 行 | 同一棵树同时要进 `lastTrees` 快照缓存，不截断就是按设备数吃宿主堆 |
| 僵尸解码进程 | 设备端录制器被杀后，宿主 ffmpeg 存活但不出帧 → **6 s 判死、自动重建**，恢复后取帧回到 37–139 ms | 杀 27145/17165 后观察：冷回退 828 ms，重建出新 `screenrecord` + 新转封装进程，热帧恢复 |
| 无主解码器（换代残留） | 解码器对象已经丢了、进程还挂在注册表里时，看门狗**收掉它并清掉 2 s 重建节流**；不处理时这个僵尸会一直占 CPU 和管道（实测 6 分钟 39 s CPU、`jpegFresh()` 恒 false），每次视觉读都掉回截图 | 1.4.10 实测：收掉后下一次读帧立即重建，热帧 **42 ms**（冷启动 985 ms → 42 ms）；同轮 `adb_look` 从「截图 662 ms」变为「推流帧 157 ms」；宽限过期后仍不出帧的解码器由看门狗就地收掉，`stop()` 再扫一遍注册表 |
| 换代残留的转封装进程 | 注册表补上「代」的身份：模块重载后上一代起的 ffmpeg **一眼认出、当场收掉**；此前只认 JPEG 解码器，转封装器漏网（实测宿主上留过一只跑了 **1 小时 23 分**的 TS 重封装进程，CPU 白烧、还占着它的管道） | 跨模块实例实测：上一代注册的子进程被新实例 `strayKids` **0 ms** 收掉；同代且有主人的子进程不动；`stop()` 收尾再扫一遍；`start()` 起新链路前先清旧代 |
| 临时文件 | OCR 帧、颜色网格、截图、`screencap` 落盘图统一按 **10 分钟**清理（此前只清 OCR 一类） | `pruneOcrTemp` → 覆盖 `dsh-mobile-use-ocr-*` / `adbm-look-*` / `adb-*.jpg` / `dsh-mobile-use/` |
| 等待者堆积 | JPEG 取帧等待者超配额立刻返回 `null` 并计数，不排队 | `MAX_JPEG_WAITERS` 硬配额 |
| 视觉通道独立可修 | 只用 OCR/颜色网格（没有镜像观众）时看门狗也生效，此前这条路径完全不巡检 | `checkHealth` 新增视觉分支，只在宽限内确实要帧时才重建 |

仍未给出的：单次连续 8 h 的运行数据（下一项），以及三平台里只有 macOS 实测。

### 7.3 站得住的三处领先（agent 侧，不是「人肉镜像」侧）

1. **不用视觉模型也能读界面**：控件树 171–233 ms【实测】，文本树稀疏时自动补 macOS Vision OCR
   （19 段文字 / 1009 ms 冷、529 ms 热【实测】），OCR 结果直接并进同一棵树当可点节点，
   模型拿 ref 就能点。竞品里没有等价物（Layout Inspector 只给可调试应用、且是给人看的）。
2. **一次调用跑完一段操作**：`adb_do` 把等待/断言/循环/失败继续收进同一次调用，
   回执带每步轮询次数；失败自动取证（页面 + 文字 + 截图 + 崩溃提示）。
   对照 Appium/Maestro 是「脚本 + 客户端库」，单次往返里做不到这么多。
3. **字节级正确的注入**：触控/按键/文本/手势都走 scrcpy 控制通道，字节布局有单测，
   坐标空间按上游源码校准（7.1）。这类错在同类工具里通常表现为「点不准」，很难被当成 bug 报出来。

### 7.4 结论

- 「超过所有竞品」目前**不成立**，能说的是：agent 操作这一层（观测 + 一次调用多步 + 取证）
  在开源同类里没有直接对手，镜像/延迟/长稳这三层仍在追赶 scrcpy 生态。
- 下一步按审查给的四条资源规则落地（所有者与取消入口、异步回调代际校验、`stop()` 先作废再回卷、
  字节/排队/订阅/进程四类配额），再做 ≥8 h 实时浸泡；这两件做完才够格谈「长期稳定」。
