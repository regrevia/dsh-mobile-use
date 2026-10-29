# Agent 操作层：成熟项目能力对比与优先级

> 范围只覆盖「一个 agent 用工具直接操作真机」的**操作层**：语义定位、等待、文本输入、手势、观测、失败归因。
> 不涉及推流画质与录屏（见 [scrcpy.md](scrcpy.md)），不重复 [roadmap-gaps.md](roadmap-gaps.md) 的工程排期（那边按投入产出排，多点触控/端到端延迟/CI 已列）。
> 本文只回答三件事：**该抄谁、先抄哪条、抄完怎么证明变快了。**

口径标记：`【实测】` = 本机量过（[bench.md](bench.md)）；`【官方口径】` = 项目文档/源码写明；`【厂商口径】` = 项目自称、无第三方复现；`【估算】` = 结构性推算；`【未核实】` = 未找到一手来源。

## 0. 结论

1. **模型侧成本 ≈ 调用次数 × 每次返回的 token**。把「找 → 滑 → 找 → 点 → 确认」压成一次调用，收益远大于把 120 ms 压到 90 ms；所以优先级按「减少回合数 / 减少失败重试」排，不按毫秒排。
2. 值得整条抄的有三件：uiautomator2 的「选择器 + 等待 + 稳定判定」三件套；Appium 的**动作回执**语义（点击后等 AccessibilityEvent 确认，而不是 sleep）；scrcpy 的**单通道二进制输入协议**（一次连接发完，无 fork）。
3. 不值得抄的三件：XPath 当主定位（Appium 自评 `⭐⭐⭐`，最慢一档）；`-android uiautomator` 策略（Google 已宣布将移除 `UiSelector`/`UiScrollable`，押它等于押弃用 API）；Appium 的 XML page source 作模型输入（同样一棵树，XML 体积是紧凑文本行的 10 倍量级）。
4. 本插件在「给模型看懂界面」这层已经领先：整树 96–129 ms、59 行紧凑文本、`snapshot_id` 防旧 ref 误点【实测】。差距集中在**动作合成、等待语义、输入通道、失败归因**四处，全在操作层，不动推流。

## 1. 能力矩阵

列 = 被对比项目；格 = 具体 API，不是形容词。

| 能力 | uiautomator2 (3.x) | Appium UiAutomator2 | adbutils / adb-shell | scrcpy | 本插件 `adb_*` |
| --- | --- | --- | --- | --- | --- |
| 选择器语义 | `text` `textContains` `textMatches` `textStartsWith` `resourceId(Matches)` `className(Matches)` `description*` `instance` `index` | `id` / `accessibilityId` / `className` / `-android uiautomator` / `xpath`，官方标速度 `⭐⭐⭐⭐⭐→⭐⭐⭐` | 无（只到 shell） | 无（按坐标/像素） | `text` `id` `desc` `cls` + `exact`/`regex` + `index` + `clickable`/`enabled`/`visible`/`within_ref`/`all` |
| 状态属性过滤 | `checkable` `checked` `clickable` `longClickable` `scrollable` `enabled` `focusable` `focused` `selected` `packageName` | 元素属性 30+：`checked` `checkable` `scrollable` `password` `input-type` `hint` `bounds` `displayed` `contentSize` `extras` `a11y-important` `drawing-order` `text-entry-key` `heading` `live-region` `max-text-length` | 无 | 无 | 行尾标记 `*` 可点 / `~` 可滚 / `[x]` 勾选 / `[off]` 不可用；**不能按这些属性过滤** |
| 结构关系 | `child()` `sibling()` `child_by_text()` `child_by_description()` `parent()` `right/left/up/down()` | XPath 轴（`//*[@text="x"]/..`） | 无 | 无 | 仅 `within_ref`（范围限定），无父子/兄弟/序号链 |
| 等待 | `wait()` `wait_gone()` `must_wait()` `click_gone()` `click_exists(timeout)` `implicitly_wait()` `d.settings` 全局超时；`Watcher.wait_stable(seconds,timeout)` 等画面稳定 | `waitForIdleTimeout` 默认 **10 000 ms**（每次查找先等 idle）；`waitForSelectorTimeout`；`actionAcknowledgmentTimeout` 默认 **3 000 ms**；`scrollAcknowledgmentTimeout` 默认 **200 ms**【官方口径】 | 无 | 无 | `wait_for_text` / `wait_for_id` / `wait_for_activity` / `wait_until_gone`（`adb_ui`、`adb_tap`、`adb_do` 都有） |
| 文本输入 | `set_input_ime()` + `send_keys()` + `send_action()`（Enter/Search/Done）+ `clear_text()`；`keyInjectionDelay` 逐字符间隔 | `keyInjectionDelay` 默认 0 ms；`mobile: performEditorAction` | 只能 `input text` / `am broadcast` | `INJECT_TEXT`（type 1）、`SET_CLIPBOARD`（type 9，带 `sequence`+`paste`+`copyKey`） | ASCII 直发；中文走剪贴板粘贴 ~1.5 s【实测】；`key`（ENTER/BACK/DEL/TAB/DPAD_*）；`clear` |
| 手势 | `click()` `long_click()` `drag()` `swipe()` `swipe_points()` `gesture(s1,s2,e1,e2,steps)` **双指**、`pinch_in()` `pinch_out()`、`fling()`、元素内 `swipe(direction)` | W3C Actions 多指；`mobile: clickGesture` / `longClickGesture` / `swipeGesture` / `scrollGesture` / `pinchOpenGesture` / `pinchCloseGesture` / `scroll` | 无（要自己拼 `sendevent`/`input`） | `INJECT_TOUCH_EVENT`（type 2）带 `pointerId`/`pressure`/`actionButton`/`buttons` ⇒ **同通道多指**；`UHID_CREATE`(12)/`UHID_INPUT`(13)/`UHID_DESTROY`(14) 走内核 HID | `adb_tap`（ref/text/id/desc/point，`long`/`repeat`/`interval_ms`/`dry_run`）、`adb_gesture` 逐点轨迹（3–40 点，可按住再拖）；**多指不支持**（README 明示） |
| 观测 | `dump_hierarchy(compressed, pretty, max_depth, root_in_active)` 返回 XML；`window_size()`；元素 `screenshot()`；`info` 含 `sdkInt`/`displayRotation` | `getPageSource`（XML）+ 30 属性；`enableMultiWindows`、`enableNotificationListener`（toast 文本进树，保留 **3 500 ms**）、`ignoreUnimportantViews`、`allowInvisibleElements`、`snapshotMaxDepth` | `logcat` 流、`dumpsys` | 像素画面（无树） | 整树 96–129 ms / 59 行【实测】；`adb_window`（多窗口/悬浮窗）、`adb_web`（CDP 直读 WebView DOM）、`adb_anim`/`adb_motion`/`adb_watch`（动效量化）、OCR 兜底 1771 ms【实测】、`changed_only` 树 diff |
| 诊断 | 异常 `UiObjectNotFoundError`；`jsonrpc_call(timeout=10)`；`d.shell` | 报错码 + server log；`mobile: deviceInfo` / `batteryInfo` / `getDeclaredOrientation` / `listWindows` / `listDisplays` / `resetAccessibilityCache` | `AdbConnection` 长连接可跑任意 shell | 客户端日志 | `adb_crash`（FATAL + dropbox）、`adb_events`（人/agent 动作时间线）、`adb_proc`（top/mem）、`adb_sh logcat`、`adb_state`（前台 Activity/键盘/方向） |
| 连接与延迟定位 | 设备端 jar + HTTP，9008 端口；每条命令一次 HTTP + jsonrpc【官方口径 源码】 | Appium server → driver → 设备 server，三段转发 | `AdbClient` 一条 TCP 到 adb server，`forward/reverse/push/pull/logcat` 同连接复用；`adb-shell` 纯 Python 直连设备，不要 adb 二进制 | 设备端 `app_process` 跑 dex，video/audio/control 三 socket，control 双向 | 常驻 shell 20 ms vs 一次性 `adb shell true` 40 ms【实测】；mirror HTTP `/tap` 84 ms、`/text` 41 ms【实测】 |

**矩阵读出来的三件事**：

1. **选择器字段的差距不在数量，在「结构化」**。u2 把 `index`/`instance`/`childOrSibling` 做进选择器位掩码，一次请求表达「第 2 个 `checked=true` 的 Switch 的兄弟节点」；本插件目前只能「先 dump 全树、模型读行、再用 ref 点」。
2. **Appium 真正值钱的不是定位，是「动作回执」**：点击后等对应 AccessibilityEvent 再返回（`actionAcknowledgmentTimeout`），以及查找前先等 idle（`waitForIdleTimeout`）。这正是 agent 反复「点了没反应 → 再 dump 一次 → 再点」的根因，本插件目前靠调用方显式传 `wait_for_*`。
3. **scrcpy 的多指不是「支持多指」四个字，是协议层设计**：一条 control socket 上多个 `pointerId` 并发，客户端一次连接连续发，没有 fork、没有第二次握手 ⇒ 这才是「按得住、捏得动」的手感来源，也是插件 `adb_gesture` 逐点 shell 注入所缺的底层。

## 2. 本插件现状假设

本节只写**公开可查的事实**（工具描述、README、docs、量过的数），不推断内部实现；标「缺」的都以当前工具参数表为准。

**已有（公开工具面）**：

- 定位：`adb_find` 支持多字段 AND（`text`/`id`/`desc`/`cls`/`pkg`）+ `exact`/`regex`/`text_matches` + `index` + `within_ref` + `clickable`/`enabled`/`visible` + 同处去重。
- 防误点：`adb_ui` 给 `snapshot_id`，`adb_tap` 带 `snapshot_id` 校验，快照过期直接报错不拿旧 ref 点；`dry_run` 只算落点。
- 等待：`adb_ui`/`adb_tap` 内建 `wait_for_text` / `wait_for_id` / `wait_for_activity` / `wait_until_gone`，`adb_do` 每步可带 `wait_text` / `wait_gone`。
- 观测：整树 96–129 ms（25.7 KB XML 量级 → 59 行文本）【实测】；`changed_only` 增量 diff；`adb_window` 按窗口 dump；`adb_web` 读 WebView DOM；`adb_anim`/`adb_motion` 把动效变成数字；OCR 仅在树近空时兜底。
- 诊断：`adb_crash`、`adb_events`、`adb_proc`、`adb_sh`。

**缺（按能力点名）**：

| 缺口 | 现状证据 | 影响 |
| --- | --- | --- |
| 滚动到目标（scroll-into-view） | 无 `adb_scroll*` 工具；`adb_input` 只能给绝对像素 swipe | 长列表要点第 15 项，模型得「滑 → 看 → 滑」，回合数 ×3 |
| 动作回执与失败归因 | `adb_tap` 返回 `ok/target/activity/matched`，`wait_for_*` 需调用方显式给 | 「点了没反应」只能靠模型自己再 dump 判断，重试一次 = 多 1 次往返 + 全树 token |
| 界面稳定判定 | 只有 `wait_for_text` 等「出现/消失」，没有「等动画停」 | 惯性滚动/转场中读到半截状态，误判概率高 |
| 状态属性过滤 | 行尾有 `[x]` `[off]` `~`，但 `adb_find` 不能按 `checked`/`selected`/`scrollable`/`editable` 过滤 | 「找到那个已勾选的 Switch」只能模型逐行读 |
| 结构关系 | 只有 `within_ref` | 「输入框右边的发送按钮」只能靠 ref 邻近推断 |
| 中文输入通道 | README：中文走剪贴板 ~1.5 s；`adb_input` 无 IME 选项 | 每填一个输入框多 1.5 s，且剪贴板被占用 |
| 多指 | README 明示「多指不支持」 | 双指缩放/捏合任务直接失败（roadmap 已排期） |
| 规则化处置弹窗 | 无 watcher 类机制 | 权限弹窗/升级提示每出现一次，模型都要重新看一遍树 |
| 树深度/压缩开关 | `adb_ui` 只有 `full`/`max_nodes` | 超大页面（千节点）只能截断，不能按 depth 压 |

**明示限制（不算缺陷，但要写进排期前提）**：`uiautomator dump` 类方案看不见 WebView 内部结构、Flutter 自绘画布、以及未开启 semantics 的 Compose 树——这三类只能靠 `adb_web`、OCR、像素比对兜底，属于结构性天花板而非实现问题。

## 3. 优先级清单

排序依据：**先降回合数与失败率，再降单次耗时**。每条给「能力 / 为什么 / 抄谁 / 接口草案 / 验证」。验证统一用现成量尺：单次返回的 `elapsed_ms`、`adb_events` 里的动作条数、以及任务成功率。

### P0（agent 任务成功率与回合数直接受益）

#### P0-1 语义选择器 + 滚动到目标：一次调用完成「找到就打」

- **为什么**：长列表/折叠区/无限滚动的目标是 agent 最常见的失败点；现状「滑一次 → dump 一次 → 再滑」把单步变成 3–5 个回合，每回合还附一整棵树。
- **抄谁**：u2 的 `UiScrollable` 思路已弃用，抄它的**语义**——`d(scrollable=True).fling()` 到 `d(text=...).exists` 循环；Appium 抄 `mobile: scrollGesture`（按方向+百分比+direction，不是像素坐标）与 `mobile: scroll`（`elementId` + `strategy: accessibility id`）。
- **接口草案**：
  ```json
  adb_tap { "text": "第 15 项", "scroll": { "max": 6, "container": "resource-id:list" }, "timeout_ms": 8000 }
  ```
  `scroll.max` 缺省 3，`container` 缺省「目标所在的最近可滚祖先」；命中即点，返回 `scrolled: 3, matches: 1`。
- **验证**：同一列表页做 20 次「点第 15 项」，`adb_events seconds=900` 数 `adb_ui`+`adb_input(swipe)`+`adb_tap` 条数：目标 p50 从 3+ 降到 1；单次 `elapsed_ms` 之和 p50 目标 < 900 ms（现状>2 s，按 bench 120 ms/次 dump + 250 ms/次 swipe 估）。

#### P0-2 动作回执：点击自己报告「生效没生效、为什么没生效」

- **为什么**：这是 agent 与「RPA 脚本」的分水岭。脚本只关心注入成功，agent 必须知道状态变了没有；否则只有两条路——盲目重试或整树重读，两条都贵。
- **抄谁**：Appium `actionAcknowledgmentTimeout`（等对应 AccessibilityEvent，默认 3 000 ms 上限）与 `waitForIdleTimeout`（查找前等 idle）；u2 的 `click_gone()` / `click_exists(timeout)` 是同一思想的轻量版。
- **接口草案**：`adb_tap` 缺省即回执，无需新参：
  ```json
  { "ok": true, "changed": true, "delta": ["+ 已保存", "- 编辑"], "reason": null, "activity": ".MainActivity", "elapsed_ms": 214 }
  ```
  `changed=false` 时必须给 `reason`：`unclickable` / `obscured`（落点被同级节点覆盖）/ `keyboard-covered` / `animating` / `same-screen`。判定素材全在现有能力里：点击前后各一次树 dump 的可比行、`adb_state` 的键盘与 Activity、落点矩形命中测试。
- **验证**：构造 6 个「会失败」的页面（半透明遮罩、键盘遮挡、连点中间态、纯装饰文案），各跑 5 次：现状要人工/模型判断，目标在**同一次调用**里返回非空 `reason`；统计 `reason` 正确率与「因误判导致的重复调用」次数（目标 0）。

#### P0-3 文本输入走 IME 通道，替掉剪贴板长路径

- **为什么**：中文输入 1.5 s 是当前最贵的单点操作，表单类任务里出现频率最高；且剪贴板路径会覆盖用户剪贴板、部分 App 弹「粘贴自…」提示。
- **抄谁**：u2 `set_input_ime(True)` + `send_keys()` + `send_action()`（一个 IME 广播直接注入整串文本，不逐字符走 `input text`）；Appium 的 `keyInjectionDelay` 作为慢速兜底。代价要写清：需装一个 ~1 MB 的 IME APK（`adb install` 可逆，卸载即复原），默认仍保留剪贴板路径。
- **接口草案**：
  ```json
  adb_input { "text": "发票抬头", "ime": "auto|fastinput|clipboard", "submit": "search|done|enter", "verify": true }
  ```
  `verify:true` 时回读焦点框文本比对，不一致直接报错（比让模型下次 dump 才发现便宜得多）。
- **验证**：同一输入框连填 20 次 20 字中文，取每次 `elapsed_ms` p50：现状 ~1 500 ms【实测 描述】，目标 < 400 ms；并 `adb_sh cmd="dumpsys input_method | grep mCurMethodId"` 确认通道切换可回滚。

#### P0-4 等「界面稳定」，而不是等固定时长或等某个字符串 —— 已落地（`awaitStable`）

- **落地**：`adb_ui {wait_stable:true|wait_idle:true, idle_ms, timeout_ms}`、`adb_do` 每步 `wait_stable`；判据统一为「树签名连续 `idle_ms` 不变」，空树不算稳定；单测覆盖「一上来就静 / 先变后静 / 一直变 / 读不到控件」四种。

- **为什么**：惯性滚动、页面转场、骨架屏→内容的中间态，是「读到半截 → 点错位置」的主因；模型于是养成 `sleep` 习惯，而 sleep 是固定成本，页慢就失败、页快就浪费。
- **抄谁**：u2 `Watcher.wait_stable(seconds=5.0, timeout=60.0)`；Appium 的 idle 等待（`waitForIdleTimeout`）；底层判据本插件已有——`adb_motion`/`adb_recent` 就是按帧差量化变化的，把「帧差 < 阈值持续 N 帧」提成 API 即可，不必新造轮子。
- **接口草案**：
  ```json
  adb_ui { "wait_stable": true, "quiet_ms": 250, "timeout_ms": 5000 }
  adb_wait { "stable": true, "within": "text:加载中" }   // 等 loading 消失且画面不再变
  ```
- **验证**：在带动画的列表页与转场页各 20 次，比较「`sleep 800` + dump」与「`wait_stable` + dump」：前者「读到中间态」次数 >0（用连续两次 `adb_ui changed_only` 非空判定），目标 0 次且 p50 耗时下降 ≥30%。

### P1（显著省 token，但不改任务成败）

| 能力 | 为什么 | 抄谁 | 接口草案 | 验证 |
| --- | --- | --- | --- | --- |
| 规则化弹窗处置（watcher） | 权限/升级/评分弹窗是重复劳动，模型每见一次就重读一次树 | u2 `d.watcher.when("允许").click()` + `watcher.start(interval)` + `wait_stable` | `adb_rules { "when": "text:允许", "do": "tap", "scope": "device" }`，命中回 `handled:[...]` | 连跑 20 次含弹窗流程：模型侧 `adb_ui` 次数下降 ≥30%，且 `handled` 全命中 |
| 属性面扩展 | 「已勾选/可滚动/密码框/输入类型」现在是模型从行尾符号猜 | Appium 元素属性表（`input-type`/`hint`/`password`/`text-entry-key`） | `adb_ui` 行尾追加 `@edit` `#pwd` `%hint`；`adb_find` 加 `checked`/`selected`/`scrollable`/`editable` | 同一表单页：模型定位「密码框」所需读行数从全树 59 行降到 `filter` 后 2 行 |
| 树深度与压缩 | 千节点页面全量 dump 既慢又灌 token | u2 `dump_hierarchy(compressed, max_depth)`；Appium `snapshotMaxDepth`/`ignoreUnimportantViews` | `adb_ui { "depth": 3, "compact": true }` | 大页面 dump `elapsed_ms` p50 下降 ≥40%，且 `adb_tap` 命中率不降 |
| 手势与元素绑定 | 现在 `adb_gesture` 要绝对坐标，模型得先从树里算中心点 | Appium `mobile: swipeGesture`（元素 + 方向 + 百分比） | `adb_gesture { "ref": 12, "direction": "up", "percent": 0.8 }`；`scroll_by { "ref": 12, "direction": "down", "times": 3 }` | 列表翻页任务：坐标换算类失败（点了空白）从 N 次降到 0 |

### P2（有更好，没有也能跑）

| 能力 | 备注 |
| --- | --- |
| XPath 兜底 | 仅当选择器表达不了时用；Appium 自评最慢一档，且要额外 dump+解析，作为「逃生舱」而非主路径 |
| toast / 系统弹窗文本进树 | Appium `enableNotificationListener`（保留 3 500 ms）；本插件可用 `adb_events` 补，但文本进树更省一次调用 |
| 元素级截图 | u2 元素 `.screenshot()`；用于「这张卡片长什么样」这类必须看图的问题，避免整屏 612–665 ms【实测】 |
| 组合动作链（W3C 风格） | 长按拖动、双击后滑，一次提交多段轨迹；scrcpy 的 `INJECT_TOUCH_EVENT` 连续帧是参考实现 |
| 纯 Python 免 adb 二进制 | `adb-shell` 直连设备（TCP/USB），适合 CI 容器里没装 platform-tools 的场景；本机开发不必换 |

### 已落地（本轮，均有单测覆盖）

| 能力 | 竞品口径 | 本插件做法 | 落地 |
| --- | --- | --- | --- |
| 语义选择器 | Appium `checked/selected/…` 要配合 `findElements` + 属性断言；u2 靠 `d(checked=True)` | `selectNodes` 直接吃 `checked / selected / scrollable / focused / editable / password`，true=必须有、false=必须没有（一次挑「没勾上的复选框」），与 `text/id/cls/pkg` 等条件 AND | `cb678f2` |
| 控件状态可见 | Appium 要读 `element.getAttribute()` 逐个问 | 紧凑行行尾直接标 `* ~ [x] [s] [f] [pwd] [off]`，一次 dump 全知道；`adb_find` 行同样带这些标记 | `cb678f2` |
| 密码框识别 | 需要额外属性查询才知道是密码输入 | `parseNodes` 读 `password`，树上即标 `[pwd]`，模型不会把掩码当正文填 | `cb678f2` |
| 边滑边点 | Appium `mobile: scroll` 是独立动作，要自己拆成两次调用 | `adb_tap {scroll}`、`adb_do` 每步 `scroll/scroll_direction`：当前屏没有就边滑边找再点，只对「当前屏没有」滑（歧义/快照过期的滑了没用，原样报错） | `cb678f2` / `39388c2` |
| 一步内等跳转 | Appium 用 `waitForActivity` 单独一次 | `adb_do` 步骤自带 `wait_activity`（页面正则），`adb_app start/open` 同样带，本地先校验正则再跑 | `6aad1d1` |
| 隐式等待 | Appium `implicitlyWait` 是会话级全局开关 | 每个 `adb_tap` / `adb_do` 步默认自带 ≤900ms 有界等待（`wait_ms` 可调），不掩盖歧义与快照过期 | `52545f9` |
| 清空输入框 | `element.clear()` 走 W3C 一次往返 | 一次 Ctrl+A+DEL（约 120ms，与长度无关）+ 一次核对 dump；自绘控件忽略时退回单次 DEL 连发 | `52545f9` |
| 步骤预校验 | 走到一半才发现参数写错 | `validateSteps` 在注入前逐条查：动作冲突、regex、`scroll` 范围、`scroll_direction` 取值，一次报清「第几步要改什么」 | `6aad1d1` / `39388c2` |
| 按方向滑/按框滑 | Appium `mobile: swipeGesture` 的 direction+percent 写法 | 给了 direction 就按屏幕/控件框算直线，percent 控制行程（0.1–1，默认 0.7），不用模型手算坐标；`from` 给控件就滑它，否则挑最内层可滚容器 | `cb678f2` |
| 只等条件的等待工具 | u2 的 `Watcher` 要常驻注册；Appium 只有 `wait`+定位 | `adb_wait` 一次调用等文字/id/描述/消失/多个条件/页面/界面静止，成功只回一句结论（不端回整棵树）；超时回「停在哪个页面、能点几个、焦点在哪」，模型不用再读一次 | 本轮 |
| 等界面静止 | u2 `wait_stable(seconds=5.0)`；Appium `waitForIdleTimeout` 是会话级 | `awaitStable`：树签名连续 `idle_ms`（默认 400）不变才算静止，`adb_ui {wait_stable}` 与 `adb_do` 每步 `wait_stable` 共用同一判据；读不到控件不算静止（加载中的空树最会骗人），回执直接说「已静止 / 到点还在变 / 一直读不到控件」 | 本轮 |



## 崩溃防线（本机真实 OOM 沉淀）

宿主和插件同一个 Node 进程，内存问题不是「插件出错」而是「整个 DSH 没了」。三类崩溃分开算：

| 崩溃 | 证据 | 归属 | 状态 |
| --- | --- | --- | --- |
| `RangeError: Maximum call stack` | 栈里是 `stop()` / `emit('closed')` | 插件：关闭路径不幂等，stop→closed→stop 递归 | 已修（`scrcpy.js` 一次性清理保护 + 回归测试） |
| `node::OOMErrorHandler`、堆 ≈4GB、无插件栈 | `.ips` + `crash-*-host.log` | 宿主/核心（大会话恢复、其他插件） | 不归本插件；插件侧只做加固 |
| 插件侧内存放大点 | `adb()` 直连子进程默认各自 64MB 输出 | 插件：并发大输出叠成几百 MB | 已修（全局闸门：并发 ≤4、预留合计 ≤24MB、排队 ≤16、等 30s 明确报错） |

判读顺序：先 `.ips` 里是 `OOMErrorHandler` 还是 `RangeError`，再决定查缓存/并发还是查递归/关闭路径。两条不要混着归因。

### 明确不抄

- **Appium 整机那套**（server + session + W3C 协议）：为跨端一致性付的抽象税，对本插件是纯延迟。
- **XML page source 直喂模型**：同样信息量下 token 是紧凑行的 10 倍量级【估算】，本插件的行格式已经是更优解。
- **`-android uiautomator` / `UiSelector` / `UiScrollable`**：Google 已公告要移除，抄了就是技术债。
- **scrcpy 当 agent 主通道**：它没有语义树，只有像素；正确姿势是「语义层用树，输入层借它的协议」（对应 roadmap 的多点触控项）。
- **STF / DeviceFarmer 的设备农场模型**：解决的是多设备调度与远程共享（minitouch/minicap 注入），与本插件「单机 agent 操作」不同题；仅在将来做多设备群控时参考其设备状态机【未核实：未读其源码，只按项目定位描述】。

## 4. 性能基线

「一次操作要多久」必须分口径，否则数字没意义。下表左列是路径，右列数字带口径标记。

| 路径 | 数字 | 口径 |
| --- | --- | --- |
| `adb shell true`（起进程） | 40 ms | 【实测】bench.md |
| 常驻 shell 复用 | 20 ms | 【实测】bench.md |
| u2 整树 dump（本机实测场景，59 节点） | 96–129 ms | 【实测】bench.md |
| 本插件 `adb_ui` | ~120 ms | 【实测】bench.md |
| Appium `getPageSource` | 每次查找前先等 idle，上限 10 000 ms；实际 1–3 s | 上限【官方口径】settings 表；实际值【估算】 |
| Appium 点击 | 等 AccessibilityEvent 确认，上限 3 000 ms | 【官方口径】`actionAcknowledgmentTimeout` |
| u2 `click()` | 一次 HTTP + jsonrpc（客户端超时默认 10 s） | 机制【官方口径 源码】；耗时 60–150 ms【估算】 |
| scrcpy 输入注入到上屏 | 35–70 ms | 【厂商口径】README |
| 本插件 mirror `/tap` | 84 ms（`/text` 41 ms、`/scroll` 146 ms、`/swipe` 253 ms） | 【实测】bench.md |
| 中文输入（剪贴板路径） | ~1.5 s | 【实测】README/工具描述 |
| 中文输入（IME 直发，P0-3 目标） | < 400 ms | 【估算】 |
| 截图 `screencap` 回传 | 612–665 ms（旧 `screencap -p` 落盘路径 867 ms） | 【实测】bench.md |
| OCR 兜底 | 1 771 ms | 【实测】bench.md |
| 镜像通道稳态帧 | 22.9 fps，帧间隔 p50 41 ms / p99 162–197 ms | 【实测】bench.md |

**三条结论**：

1. 树 100 ms 级、截图 600 ms 级、OCR 1.8 s 级——**一个数量级一层**，所以「先读树」不是偏好而是算术。
2. 单次注入本身都不慢（84 ms 级），慢的是**往返与重试**：一次「点错 → 再 dump → 再点」= 200 ms + 一整棵树 token。故 P0 全部指向「少一次往返」。
3. 只有 scrcpy 的输入通道是「连一次、连续发」，其余方案每条命令都付一次进程/HTTP 开销；这是多点触控与按住拖动必须借它协议的原因（roadmap 已排期）。

## 5. 参考

- uiautomator2：[仓库](https://github.com/openatx/uiautomator2)、选择器字段与手势源码 [`uiautomator2/_selector.py`](https://github.com/openatx/uiautomator2/blob/master/uiautomator2/_selector.py)、设备 API [`__init__.py`](https://github.com/openatx/uiautomator2/blob/master/uiautomator2/__init__.py)、Watcher [`watcher.py`](https://github.com/openatx/uiautomator2/blob/master/uiautomator2/watcher.py)
- Appium UiAutomator2 driver：[仓库/README](https://github.com/appium/appium-uiautomator2-driver)（元素属性表、Settings、`mobile:` 扩展命令均在此；文档站 `reference/commands.html` 已 404，以 README 为准）
- adbutils：[仓库](https://github.com/openatx/adbutils)（README + `docs/PROTOCOL.md`）
- adb-shell（纯 Python 直连）：[仓库](https://github.com/JeffLIrion/adb_shell)
- scrcpy：[控制协议](https://github.com/Genymobile/scrcpy/blob/master/doc/control.md)、[开发者文档](https://github.com/Genymobile/scrcpy/blob/master/doc/develop.md)、[`ControlMessage.java`](https://github.com/Genymobile/scrcpy/blob/master/server/src/main/java/com/genymobile/scrcpy/control/ControlMessage.java)
- Android `AccessibilityNodeInfo`：[官方参考](https://developer.android.com/reference/android/view/accessibility/AccessibilityNodeInfo)
- 本仓库：[bench.md](bench.md)、[roadmap-gaps.md](roadmap-gaps.md)、[competitors.md](competitors.md)
