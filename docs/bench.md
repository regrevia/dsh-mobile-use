# dsh-mobile-use 基准数据（本机实测）

设备：小米平板 8（`15ca9736`，3200×2136 竖屏，Android，已 root）
主机：macOS，DSH 桌面端本机回环（`http://127.0.0.1:<GUI 端口>/dsh-mobile-use`）
测法：每次调用记录工具自报耗时 + 外层 `curl` 计时；数字为单次典型值，抖动区间用 `–` 表示。
所有结论只在上述组合成立；换设备、换 USB/无线 adb、换编码器都可能不同。

## 零、怎么自己复测

不开宿主也能量设备侧原语，改完一处改动就能对比前后：

```bash
node test/device-bench.mjs --n 5            # 只读：dump / 读前台 / 等文字
node test/device-bench.mjs --n 5 --write    # 追加：滚动找字（会滑屏）
```

2026-10-29 等静止实测（同一屏，只读）：`awaitStable` `quiet_ms=400` 691 ms / 3 次 dump、`quiet_ms=200` 472 ms / 2 次、`quiet_ms=120` 524 ms / 2 次；单次轮询 dump 156–176 ms（均值 169）。所以「等静止」比「sleep 1 s 再 dump」省约 300 ms，且不会把动画中途读到的树当真。

2026-10-29 再测（前台 `com.whale.pet/HistoryActivity`，只读）：轮询用的 `pollDump`（`ocr:false`）单次 **155 ms**、连读 5 次 820 ms；`test/device-bench.mjs --n 2` 现在会正常退出（`EXIT=0`，dump 均值 164 ms、`foregroundActivity` 84 ms、`waitFor` 600 ms 超时实耗 713 ms）——之前「跑不完」是 u2 的 RPC 连接让事件循环不退出，不是设备慢，脚本末尾补了 `process.exit(0)`。

2026-10-29 复测（同一台机器，前台 `com.whale.pet/.MainActivity`）：`dumpState` 94–142 ms（均值 118）、`foregroundActivity` 63–77 ms、`adb_ui` 整屏 156 ms、`adb_find` 命中 5 个 86 ms、`waitFor` 600 ms 超时实耗 708 ms（一次 dump + 120 ms 轮询 + 一次 dump）。

## 一、工具往返

| 动作 | 实测 | 说明 |
| --- | --- | --- |
| `adb devices` 探测 | 17 ms | 设备是否在线 |
| `adb shell true` 一次性 | 40 ms | `execFile` 起进程的开销 |
| 常驻 shell（`shellQueues` 串行） | 20 ms | 同机多次命令复用一个 `adb shell` 会话 |
| uiautomator2 整树 dump | 96–129 ms | 25.7 KB / 约 59 节点；成本跟树大小走 |
| `adb_ui` | 约 120 ms | 复用上面那次 dump，只切前台页 |
| `adb_window` | 236 ms | dump + 按 depth 0 切窗口 + 前台 Activity |
| `adb_state` | 290–310 ms | 含窗口栈、键盘、亮屏、电量 |
| `adb_proc` | 49 ms | 纯 shell |
| `adb_crash` | 165–194 ms | 含 dropbox 扫描 |
| 截图 `screencap` + 回传（`adb_shot`） | 612–665 ms | 含缩放与落盘 |
| Vision OCR（兜底） | 1771 ms | 只在文本树几乎为空时跑 |

要点：文本树 100 ms 级、截图 600 ms 级，所以「页面对不对/有没有报错」永远先读树，别截图。

## 二、侧栏镜像输入通道（HTTP 直达，不走模型回合）

| 接口 | 实测 | 备注 |
| --- | --- | --- |
| `POST /tap` | 84 ms | 一次点击到设备（`long:true` 为长按） |
| `POST /key` | 63 ms | 单键（ENTER/BACK/DEL/TAB/DPAD_*） |
| `POST /text` | 41 ms | ASCII 直送；中文走 u2 剪贴板 + 长按粘贴 |
| `POST /scroll` | 146 ms | 滚轮一格（±4000 为上限） |
| `POST /swipe` | 253 ms | 带轨迹的滑动 |
| `GET /state` | 1.1 ms | 本机内存数据，不碰设备 |
| `GET /actions` | 0.6 ms | 页面每 2 s 读一次「刚做了什么」 |
| `GET /diag` | 0.6 ms | 页面自报现场（构建号、渲染异常） |

## 三、画面通道：H.264 采集 → 主机转 JPEG → 长轮询

设备侧 `screenrecord --output-format=h264` 直接吐裸流（不经文件、不落盘），主机 `ffmpeg` 按 `fps=15` 抽帧并转 JPEG，浏览器用 `/frame` 长轮询取最新帧。**这条路是现在实际跑的那条**。

| 指标 | 实测 |
| --- | --- |
| 稳态帧率（12 s 采样） | 22.9 fps |
| 帧间隔 p50 / p90 | 41 ms / 42–43 ms |
| 帧间隔 p99 / max | 162–197 ms / 188–317 ms |
| 平均帧大小 | 22.6–22.8 KB（960 长边，`-q:v 7`） |
| 取帧耗时（有缓存帧） | 2 ms |
| 取帧等待（无缓存帧） | 平均 46 ms（长轮询 ≤2500 ms） |

关键参数（缺一个就会退化成 1–4 fps 或积压）：

- 设备侧：`screenrecord --output-format=h264 --time-limit=180 --size=... --bit-rate=... -`，输出进管道。
- 主机侧：`-flags low_delay -f h264 -i pipe:0 -vf fps=15,scale=-2:720 -flush_packets 1 -fps_mode passthrough -f mjpeg -q:v 7 pipe:1`
- `-flush_packets 1` 关掉 avio 缓冲、`-fps_mode passthrough` 不复制时间戳：没有这两项时 ffmpeg 会攒几帧再吐，表现为「画面一卡一跳」。

反例留档：旧的 `screencap -p /sdcard/t1.png` 一帧 **867 ms**（写盘 + 拉回），也就是 1–4 fps 的来源；屏幕静止时 `screenrecord` 只给约 1 fps（帧去重），做 fps 基准必须让画面动起来（页内滑动），否则会得出结论「推流很慢」而其实是没内容可编。

## 四、动效量化（`adb_motion`）

| 路径 | 实测 | 说明 |
| --- | --- | --- |
| 磁盘段够新（15 s 内） | 380 ms | 不碰设备，直接分析本机段 |
| 现场现录 3 s | 3.4–4.7 s | 其中录屏 3.4–4.4 s + 拉回 50–70 ms |
| 全屏抽帧 | 23 帧 / 3 s（约 7.3 fps 有效） | 静止画面屏录只给约 1 fps，按去重后有效帧算 |

桌宠（`petRoot` 462×594 @2738,424）一次点击后实测：变化 22/22 帧、外缘半径峰值 301px、落点 200px、最大单帧跳变 157px、方向来回 9 次 → 「偏抖」。
静态区域（600×80）对照：变化 2 帧、最大单帧 3px → 判定「变化太少，判不出抖动」（不硬凑结论）。

## 五、侧栏面板的交互能力

| 能力 | 实现 | 备注 |
| --- | --- | --- |
| 点按 | 按下/抬起归一化到真实媒体矩形再乘设备分辨率 | 缩放/平移后仍然准 |
| 长按 | 按住 600 ms 不动即长按 | 与点按同一套坐标映射 |
| 滚轮 | 页面滚轮 → `/scroll`，60 ms 合并一次 | 连续滚动不会灌爆设备 |
| 拖拽 | 按下后移动超过阈值转 `/swipe`，带真实轨迹 | 短距离按点按处理 |
| 键盘 | 画布 `tabIndex=0`，按键走 `/key` | 输入走输入框，不抢方向键 |
| 中文输入 | 输入框 → `/text` → u2 `setClipboard` + 长按「粘贴」 | ROM 没有 `input text` 的 CJK 通道 |
| 缩放 | Ctrl/⌘+滚轮 1–4×，2×/3×/「适应」按钮 | 以指针为锚点，边界不露出空白 |
| 平移 | 2× 以上按 Shift 拖动 | 自动夹在图像边缘内 |
| 最近操作 | 面板每 2 s 读 `/actions` | 对话里刚点的位置在面板上一行可见 |

## 五½、替代视觉：不调视觉模型的看屏通道（2026-10-31 实测，设备 15ca9736）

同一条命令连跑，第一次是冷启（要拉起设备端 screenrecord + ffmpeg 抽帧），之后走热帧：

| 通道 | 冷 | 热 | 备注 |
| --- | --- | --- | --- |
| `adb_state` | 145 ms | 125–195 ms | 七条 dumpsys 并发跑（串行 371 ms） |
| `adb_ui` 控件树 | 171 ms | 171–233 ms | 每次都真读 uiautomator |
| `adb_find` 文本树 | 99 ms | — | 复用上一次 dump |
| `adb_look` 颜色网格 | 915 ms | 41 ms / 42 ms | 热帧 108 ms 前拍的，注明「没碰设备」 |
| `adb_ocr` 文本+坐标 | 1550 ms | 110–116 ms | 热走推流帧，19–21/24 段；原图 OCR 820 ms 给 24/24 |

推流帧尺寸按设备真实分辨率算（长边封顶 2400 → 1602×2400），OCR 因此能直接认推流帧；
早期 540×960 帧 OCR 出 0 段，是尺寸不够而不是识别坏。

转码档位实测（同一屏，`adb_ocr` 热路径）：

| 出图长边 | 热路径耗时 | 认出段数 | 备注 |
| --- | --- | --- | --- |
| 960 | — | 0 | 帧太小，认不出字 |
| 1400（当前） | 110–116 ms | 19–21 / 24 | 帧稳；每次都能复用 |
| 1500 | 842–991 ms | 24 / 24 | 主机转码跟不上，帧总是过期，退回抓原图 |
| 1600 | 776–910 ms | 24 / 24 | 同上，偶发一次命中 |

所以取 1400 换稳定；要 24/24 精度就 `fresh: true`（抓原图，820 ms）或给 `region` 只认一块。空闲 120 s 自动回收，
回收后再用第一条调用重新点火（~1.2 s），第二条起回到两位数毫秒。

## 六、还没量到的

- 端到端「手指/鼠标动作 → 画面可见」的延迟（需要屏幕侧高速摄影或合成器时间戳）。
- MSE 播放分支：保留了 `/dev/mse` 诊断入口，但在这台设备 + Electron 侧栏上始终没进 `onReady`，所以默认路径是上面的 JPEG 长轮询；哪天补齐再单独量。
- 与 scrcpy / dsh-android / DesktopCommander 的同机对比，属于 Phase E，口径不同不能直接引用它们的宣传数字。
| 2026-10-29 | `dumpState` 全树 vs `depth:4` | 37/94 行 · 297 ms（两次 dump） | 实测宠物页内容在第 6–8 层，`depth` 给浅会一行为空，已加提示 |
