# dsh-mobile-use 差距与路线（按投入产出排序）

> 排序口径：先做「用户每次操作都会碰到、且现有代码已经铺好路」的，再做「要新开设备端通道」的。每条给可验收的数字，不接受「更流畅了」这种结论。
> 竞品数字只有官方自述时标【厂商口径】；本仓库数字来自 `docs/bench.md`，标【实测】。

## 1. 双指/多点触控（最高优先级）

| 项 | 内容 |
| --- | --- |
| 现状 | `index.js` 的 `adb_gesture`（约 1449 行）与 `adb_input` 走 `input motionevent DOWN/MOVE/UP`，只有单指；README 第 82 行明确「多指不支持」。侧栏画布 `client.js` 只处理单一 pointer。【实测】`vendor/u2.jar` 是 dex 形态（`classes.dex`…`classes4.dex`），全包字符串里没有 `multiPointer`，只有 `PointerCoords`×2、`injectInputEvent`×2、`swipePoints`×1 ⇒ 现成 jar 没有现成的多指 RPC，这条不能靠调用已推送的 jar 直接拿到。 |
| 竞品做法 | uiautomator2 设备端 `gesture` 支持多指（[uiautomator2](https://github.com/openatx/uiautomator2)）；QtScrcpy 把 multi-touch 列为官方特性（[QtScrcpy](https://github.com/barry-ran/QtScrcpy)）；Appium 用 W3C multi-action（[Appium](https://github.com/appium/appium)）。 |
| 实现要点 | ① `index.js` 新增 `adb_gesture` 的 `pointers: [[{x,y,t}...], ...]` 形态，先确认设备端 jar 的多指入口（上面实测没有现成字符串，要么改 dex 自己加一个方法，要么只用其中的 `injectInputEvent` 拼 MotionEvent 序列——后者还要 dex 侧加胶水），确认不划算就直接走 `sendevent`（root，需按设备 tslib/协议 B 试参），失败报清楚原因。② `mirror.js` 的 `/swipe` 路由扩展成 `/gesture`，保留旧字段向后兼容。③ `client.js`：`Ctrl/⌘+拖动` 生成第二指，双指中心对称缩放，缩放系数按两指间距比算，松手发一次完整轨迹。 |
| 预估 | 设备端 1 人日 + 侧栏 1.5 人日，含真机调参 0.5 人日。 |
| 验收 | 在系统相册对同一张图做捏合：图片缩放从 1.0 到 ≥2.0 且中心不漂移 >5%；`adb_gesture` 返回的注入序列含 2 个 pointer id；真机 20 次捏合成功率 ≥19/20。 |

## 2. 端到端延迟量化 + 帧路径减一层转码

| 项 | 内容 |
| --- | --- |
| 现状 | `docs/bench.md` 第六节自认「端到端延迟还没量到」；22.9 fps、p50 41 ms 是**出帧节奏**。链路是 `screenrecord h264 → ffmpeg fps=15,scale=720 → mjpeg → /frame 长轮询`（`mirror.js` 的 live 管线，`/frame` 处理在约 1270 行），每帧 22.7 KB。MSE 分支 `stream.js`（`packFrame`/`parseAvcConfig`）与 `/dev/mse` 一直在，但没进 `onReady`。 |
| 竞品做法 | scrcpy 自述 35–70 ms、30–120 fps，设备编码后宿主直接解码上屏，不经二次转码（[scrcpy README](https://github.com/Genymobile/scrcpy/blob/master/README.md)）；QtScrcpy 自述 1080p <30 ms【厂商口径】。 |
| 实现要点 | ① 先补口径：用第二台设备 240 fps 录「屏幕变化 + 侧栏画面」同框，取 100 次点击的 p50/p90，写进 `docs/bench.md`（只改这一节，不动其他文件）。② 帧路径做 A/B：`-vf scale` 改在设备端 `--size`，宿主只做 `-c:v mjpeg`；再把 `-q:v 7` 与 `fps=15` 做成参数，验证「宿主少一次缩放」能降多少 CPU 与 p99。③ 再评估 `stream.js` MSE 直通（`FRAME_MEDIA` 路径 + fMP4 分片），成功才切换默认。 |
| 预估 | 口径 0.5 人日；A/B 1 人日；MSE 直通 3–5 人日（风险高，单独立项）。 |
| 验收 | 端到端 p50 有实测数字并可复现；同机对比「设备端缩放 vs 宿主缩放」的宿主 CPU 与 p99 帧间隔；目标 p50 ≤ 120 ms、p99 ≤ 250 ms（口径定了再改目标，不先写死）。 |

## 3. 剪贴板读回 + 通用文件推拉

| 项 | 内容 |
| --- | --- |
| 现状 | `index.js` 约 669 行只有 `setClipboard`（中文输入用），没有读回；文件能力只有 `adb_app install`（约 1603 行），没有 `adb push/pull` 工具。`adb_sh`（约 1681 行）跑的是设备端 shell，不能替宿主推文件。 |
| 竞品做法 | scrcpy 双向自动同步剪贴板（[control.md#copy-paste](https://github.com/Genymobile/scrcpy/blob/master/doc/control.md)）；QtScrcpy 文件传输+装 APK；AirDroid 把文件传输做成主打（[AirDroid](https://www.airdroid.com/personal/)）；adb 原生就有 `push/pull`。 |
| 实现要点 | ① 新增 `adb_clipboard`（`get` 走 u2 `getClipboard` 或 `service call clipboard`，`set` 复用现有路径），并在 `mirror.js` 的 `/text` 旁加 `/clipboard`。② 新增 `adb_file`（`push/pull/ls`），限制在 `/sdcard/Download`、`/sdcard/Pictures` 白名单 + 大小上限，`pull` 直接复用 `adb_shot` 的落盘与缩放工具函数。 |
| 预估 | 1 人日（含白名单与错误文案）。 |
| 验收 | 设备复制一段中文 → `adb_clipboard get` 返回全文且与原文一致；`adb_file push` 一个 5 MB 文件往返 md5 一致；一次 `pull` 一张 8 MB PNG 耗时 ≤1.5 s。 |

## 4. 录制归档导出（现在只有 3 分钟环形）

| 项 | 内容 |
| --- | --- |
| 现状 | `mirror.js` 的 `SEGMENT`（10 s × 18 段）只做环形缓冲，供 `adb_recent`/`adb_motion` 用；没有「导出 mp4/连拍序列」的入口。 |
| 竞品做法 | scrcpy `--record=file.mp4` 任意时长（[recording.md](https://github.com/Genymobile/scrcpy/blob/master/doc/recording.md)）；Escrcpy 录屏；Firebase Test Lab 自动产出测试录像（[Robo test](https://firebase.google.com/docs/test-lab/android/robo-ux-test)）。 |
| 实现要点 | 在 `mirror.js` 的段管理上新增 `export({from,to,format})`：段是独立文件，用现有 `pickFfmpeg` 走 `-f concat` 拼 mp4；`format=tiles` 复用 `tileFrames`/`grayFrames` 出连拍拼图。工具层加 `adb_record action=export`。文件落 `~/.dsh/adb-mirror/exports/`。 |
| 预估 | 1.5 人日（含时间轴对齐：段边界与真实时钟的偏差要标出来）。 |
| 验收 | 导出 30 s mp4 可被 QuickTime 播放，总时长误差 ≤0.5 s；连拍拼图 12 帧/张，单张生成 ≤600 ms；`adb_motion` 能直接吃导出的文件。 |

## 5. 多设备并行 / 群控

| 项 | 内容 |
| --- | --- |
| 现状 | `mirror.js` 的 `setupMirror` 以 serial 为单位建实例、`MIRROR_ROOT` 共用；`adb_device` 能列设备，但没有「一次操作打到 N 台」「同屏 N 路画面」的入口；侧栏是单一页签。 |
| 竞品做法 | QtScrcpy 群控，OTG 模式单机 500+【厂商口径】；Escrcpy 多设备并行+广播输入（[Escrcpy](https://github.com/viarotel-org/escrcpy)）。 |
| 实现要点 | ① `adb_do`/`adb_tap` 加 `serials: []` 参数，串行扇出并返回逐台结果（不允许一台失败就静默跳过）。② 侧栏 `/frame?serial=` 已按 serial 分实例，页面加设备切换条；不做 N 路同屏（成本高、收益低）。 |
| 预估 | 2 人日。 |
| 验收 | 2 台设备同一条 `adb_do` 各跑 3 步，逐台返回耗时与失败原因；切换设备后首帧 ≤300 ms（有缓存帧时 ≤5 ms）。 |

## 6. 音频转发

| 项 | 内容 |
| --- | --- |
| 现状 | 完全没有；`screenrecord` 只出视频裸流。 |
| 竞品做法 | scrcpy `--audio`（Android 11+，需设备端 server 用 AudioRecord 采集，[audio.md](https://github.com/Genymobile/scrcpy/blob/master/doc/audio.md)）；WSA 有系统级音频。 |
| 实现要点 | 先做可行性验证再排期：`adb shell screenrecord --audio` 在多数 ROM 不可用，现实路径是复用 scrcpy-server 的音频通道或 `AudioPlaybackCapture`（需应用配合）。本仓库定位是零外设、不装 App，因此**优先评估「只做音量/静音控制」是否够用**，不够再引入设备端进程。 |
| 预估 | 调研 0.5 人日；若要做真音频 3 人日以上，且会破坏「不装 App」卖点。 |
| 验收 | 调研结论先落地成文档：三种方案的 ROM 覆盖率与是否需要设备端进程；若实现，则 48 kHz 立体声、端到端延迟 ≤200 ms、与画面偏差 ≤100 ms。 |

## 7. 无头/CI 与可脚本化流程

| 项 | 内容 |
| --- | --- |
| 现状 | 插件依赖 DSH 宿主；`selftest.mjs` 只做只读自检，不是可编排的流程；没有 YAML/脚本化的回归用例。 |
| 竞品做法 | Maestro 单二进制 + YAML flow，明确面向 CI（[Maestro](https://github.com/mobile-dev-inc/maestro)）；Appium 是测试协议标准；云真机按分钟计费跑矩阵（[AWS Device Farm](https://aws.amazon.com/device-farm/features/)【厂商口径】）。 |
| 实现要点 | 不追 Maestro 的语法，先做「一次调用跑一段 JSON 步骤」：把 `adb_do` 的 steps 抽成可保存的 JSON，`selftest.mjs` 增加 `--flow file.json --serial`，断言用 `wait_for_text`/`wait_until_gone`；输出 JUnit XML 供 CI 读。 |
| 预估 | 2 人日（只做自测通道，不做产品化 CI 服务）。 |
| 验收 | 一条含 8 步的回归 flow 在 CI 里跑通，失败时输出截图+文本树快照；单条 flow 端到端 ≤15 s。 |

## 8. 按键映射脚本（游戏/固定操作）

| 项 | 内容 |
| --- | --- |
| 现状 | 侧栏只有通用键盘映射（按键直送 `/key`），没有「屏幕坐标 ↔ 键位」的映射配置。 |
| 竞品做法 | QtScrcpy 按键映射脚本、默认提供 PUBG 映射（[QtScrcpy](https://github.com/barry-ran/QtScrcpy)）；Escrcpy 内嵌映射编辑器【厂商口径】。 |
| 实现要点 | `client.js` 加一份 JSON 映射（键位 → 归一化坐标 + 点击/长按/拖动），命中的按键不再发 `/key` 而发 `/tap`/`/swipe`；配置存 `~/.dsh/adb-mirror/keymap.json`，按包名分组。 |
| 预估 | 2 人日。 |
| 验收 | 配置 4 个按键后，在目标游戏里按键触发对应坐标点击，命中率 10/10；未命中映射的按键仍走 `/key` 且不重复发送。 |

---

### 不做（明确止损）

- **云端设备池**：与「零外设、本机回环」定位冲突，且要账号与计费。
- **追逐 scrcpy 的虚拟显示/摄像头镜像**：收益集中在开发调试场景，我们已有 `adb_web` 与截图链覆盖大部分需求。
- **通用 RPA 编排器**：Maestro/Appium 已占位，做第 7 条的 JSON flow 就够自用。

### 与竞品的对应关系（一句话）

第 1、4、5 条补的是 scrcpy 生态的强项；第 2 条是把「我们慢在哪」从传闻变成数字；第 3 条是最便宜的体验补齐；第 6 条要先论证是否值得破坏「不装 App」；第 7、8 条是给自测与重度用户，不改变对外定位。
