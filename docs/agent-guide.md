# Agent 操作手册

给驱动这台插件的模型看：怎么读界面、怎么点、镜像什么时候开、什么时候必须收。

## 一、判定顺序（省时且不误判）

1. `adb_state`（约 0.15 s）：前台 Activity、窗口栈、键盘、方向。先看有没有弹窗/键盘挡着。
2. `adb_ui`（约 0.2 s）：文字树。页面对不对、按钮在不在、有没有报错，全在这一层回答。
3. 找不到控件用 `adb_find`（一次给全部命中 + ref + 坐标），列表里没有用 `adb_scroll_to` 边滑边找。
4. 只有颜色、布局、相机取景、图表这类「文字树答不了」的问题才 `adb_shot`。文本树几乎全空（Flutter、自绘）时 `adb_ui` 会自动补一层 OCR，先让它跑。

不要用截图回答「跳没跳页 / 有没有报错 / 键盘挡没挡」。报错看 `adb_sh logcat -d -t 200`，崩溃看 `adb_crash`。

## 二、连着做的动作一次跑完

「点开 → 等加载 → 输入 → 发送」用 `adb_do` 一串发出去，每步带 `assert_text` / `assert_activity`，失败会停在出问题那一步并报当前页面。比一步一调省好几个回合，也不会把界面留在半路。

点击优先 `adb_tap ref=<编号>`（来自最近一次 `adb_ui`/`adb_find`）；ref 属于那次快照，界面重新 dump 就作废，跨回合点之前先读一次。

## 三、镜像：用户点名才开，走了就收

- 用户明说「看屏幕 / 用镜像 / 打开面板」才开右栏镜像。只给链接、只要结论，用 `web_fetch` / `adb_ui`，别开。
- 镜像靠宿主侧采集链：设备端一条 `screenrecord`（分段 10 s）+ 本机 ffmpeg remux + JPEG 桥。**没人看就不该有 ffmpeg**；关窗即停。
- 关窗/关页会发 `/close` beacon，宿主当场按台收尾；还有观众或镜像仍被要求时不停。
- 同一台设备只允许：1 条推流 `screenrecord`、1 条镜像分段 `screenrecord`（仅在被看时）、1 个 remux、1 个 JPEG 桥、1 个 scrcpy server。看到两条同类进程就是泄漏。
- 宿主被强杀后设备端进程不会自己退：下次开录前会按本插件 marker 精确清场，不要用 `pkill screenrecord` 这种泛杀。

## 四、改界面时的规矩

- 文案只写：标签、值、动作、会改变下一步的后果。实现细节（毫秒、worker、重试策略）、内部名词（宿主、token、端口）不上屏。
- 一屏一个主按钮；设置页 ≤ 7 行；状态一行一句，同一行给修复动作。
- 视觉沿用宿主 token，不新造配色/圆角/阴影。
- 改完跑三道门：`zh-lint`、`style-lint` 零 error；`npm test` 25 项全过。

## 五、延时的口径

- `adb_state` 126–225 ms，`adb_ui` 192–233 ms，`adb_find` 74–107 ms，`adb_look` 39–139 ms（冷启约 670 ms）。
- 推流健康看 `/stream/info` 的 `frameAgeMs`（最后一帧到达距今多少毫秒；30 fps 下约 33 ms，持续变大就是卡住了）。画面上屏延迟在页面里，看页面自己报的 `lag_ms`。
- 播放端追帧：落后 450 ms 直接跳尾；落后 140 ms 起 1.25×；追进 60 ms 放回 1×。倍速只跨线才改，避免每帧切换造成的停顿。

## 六、排障入口

- `/diag`：采集链状态、进程、队列、最近事件。
- `/stream/info`：观众数、代际、队列深度、`ptsAgeMs`。
- `/events`：SSE，页面靠它判断「还有没有人看」。
- 设备端 pid 文件：`/data/local/tmp/dsh-mobile-use-rec-*.pid`、`dsh-mobile-use-stream-*.pid`。只碰这两个前缀，别动用户自己录的屏。

## 七、不要做的事

- 不要 uninstall 用户应用；不要用输入注入改系统设置（能用 `adb_sh settings put` 就用它）。
- 不要 kill 泛化的 `scrcpy` / `uiautomator` / `screenrecord`。
- 不要为了「确认服务活着」去开浏览器：一个 HTTP 请求就够。
- 不要在 `npm test` 之后立刻 `npm publish`：测试会碰构建产物。
