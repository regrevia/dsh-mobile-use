# dsh-mobile-use「实时ADB」右栏页 · 设计文档

本文件是这一页的唯一界面合约。改 `client.js` 前先读它，改完按 §7 自检。
页面是 DeepSeek Harness 的插件页，**视觉权限全部来自宿主**，本文件不定义任何新配色、圆角、阴影、渐变、光晕。

## 1. 这一页是什么

右栏一个页签：把真机画面搬过来，让人用鼠标代替手指。

一屏只回答三个问题，顺序不能变：

1. **这是我那台手机吗** —— 画面。
2. **我这一下点到哪了** —— 点按/标注，以及圈和位标。
3. **刚才那下生效了吗** —— 状态行与操作日志。

## 2. 信息层级

| 层 | 内容 | 判定 |
| --- | --- | --- |
| 主对象 | 设备画面（`.adbm-stage` 里的 `.adbm-frame`） | 占满剩余高度，四周留白最少 |
| 主操作 | 点按 / 标注两个模式，画面上的位标，`发送` | 常驻工具条左侧，`发送` 是唯一主按钮 |
| 次操作 | 标注说明输入、键位行（发送文字 / 返回 / 主屏 / 回车 / 删除 / 制表） | 画面下方，两行，可换行 |
| 辅助 | 设备切换、缩放、操作日志 | 工具条右端、画面角上、最底一行 |

层级靠留白、描边、字重做，不靠颜色堆。全页只有一个彩色重音：**当前生效的模式**与**刚点到的那一下**（同一支 success 色）。其余控件一律透明底 + 描边。

反面：现在工具条上 6 个胶囊按钮同权重，`发送` 与 `近几秒` 长得一模一样，人第一眼找不到主按钮。见 P1-2。

## 3. 布局约束

### 3.1 画面框尺寸契约（硬约束）

**帧框的宽高只由容器决定，任何时候都不随帧像素变化。** 用户原话「侧边栏不稳定 一直一大一小缩放」就是这个契约被破坏：现在 `.adbm-frame` 是 `display:inline-flex;max-width:100%`，盒子的固有尺寸来自 `<img>`/`<video>` 的内在像素，而两路画面像素不同（诊断日志里 `w:1080,h:720` 与 `w:1024,h:1534` 交替出现，同一台设备 `/state` 报 `stream 960×640`、`frame 1024×1534`、`screen 2136×3200`）。帧一换源，盒子重排，整栏就跳一下。

落地写法：

```css
.adbm-frame{
  position:relative;display:block;
  width:100%;height:auto;
  aspect-ratio:var(--adbm-ar,9 / 16);
  max-height:100%;
  line-height:0;
  transform-origin:0 0;
}
.adbm-img,.adbm-video{
  display:block;width:100%;height:100%;
  object-fit:contain;
  background:var(--dsw-alias-bg-layer-1);
  border-radius:var(--dsw-radius-sm);
}
```

- 比例只取一个来源：设备屏幕（`/state` 的 `screen`，横竖转过来时交换分子分母），不取帧。帧像素只用来算点击映射。
- `--adbm-ar` 是**布局比例**变量，不是配色/圆角/阴影，允许新增；宿主没有等价的"画面比例"token。
- `max-height` 生效时盒子保持容器宽度、画面在盒内居中留边。留边安全，因为点击映射走 `pictureRect()`（`client.js:623`）拿的是画面实际矩形，不是盒子。
- 盒子定了之后，缩放/平移只作用在 `transform`，不改布局尺寸。

### 3.2 窄栏（360–420 px，右栏被拖动时的常态）

```css
.adbm-bar{flex-wrap:wrap;row-gap:4px}
.adbm-said{flex:1 1 100%;text-align:left}
```

- 工具条允许换行，绝不允许压扁按钮：按钮 `flex:none`，`white-space:nowrap`。
- 状态行独占一行，且**只在有话说时才渲染**（空字符串不占位）。现在 `client.js:949` 恒渲染一个 `flex:1` 的空 span，把状态挤到 `text-align:right` 的尾巴上，窄栏里只剩几个字。
- 设备切换下拉框只用 `serial` 文本，不显示机型名，避免撑破；多设备时才渲染（现状 `devices.length > 1`，保留）。

### 3.3 画面下方的两行，优先级不同

| 顺序 | 元素 | 为什么在这 |
| --- | --- | --- |
| 1 | 标注说明输入（`ph.note`） | 服务主操作「标注」，而且「最近几秒」也复用它，必须紧贴画面 |
| 2 | 键位行（文字输入 + 6 个设备键） | 设备遥控是次操作，允许换行 |
| 3 | 操作日志 | 事后核对，可滚动、可完全没有 |

缩放控件（适应 / 2× / 3×）**不属于设备键**，它改的是画面。归到画面角上，不进键位行。见 P1-3。

### 3.4 日志

```css
.adbm-log{
  flex:none;font-size:var(--dsw-font-xxs-12);
  color:var(--dsw-alias-label-secondary);
  line-height:1.6;max-height:calc(1.6em * 3);
  overflow-y:auto;white-space:normal;
}
```

最多 3 行、超出滚动、只留最近 3 条。它永远不挤压画面（`flex:none`），无内容时整行不渲染。

## 4. 宿主 token 清单（白名单）

全部变量名取自宿主打包产物，**只允许用下面这些**。用途一栏写的是本页的落点。

| 用途 | 变量 | 现状 |
| --- | --- | --- |
| 面板底 | `--dsw-alias-bg-base` | 已用，保留 |
| 画面留边底 | `--dsw-alias-bg-layer-1` | 待用，替代硬编码黑 |
| 次级面（悬停、选中底） | `--dsw-alias-interactive-bg-hover` | 待用 |
| 描边（静息） | `--dsw-alias-border-l1` | 待用 |
| 描边（悬停、输入聚焦） | `--dsw-alias-border-l2` | 待用 |
| 主文字 | `--dsw-alias-label-primary` | 待用（现在靠继承，宿主换主题时可能吃不到） |
| 次文字 | `--dsw-alias-label-secondary` | 已用，保留 |
| 三级文字（日志、提示） | `--dsw-alias-label-tertiary` | 待用 |
| 主按钮底 | `--dsw-alias-button-primary-fill` | 待用 |
| 主按钮字 | `--dsw-alias-label-primary-inverted` | 待用 |
| 生效中 / 位标 | `--dsw-alias-state-success-primary` | 待用 |
| 失败 | `--dsw-alias-state-error-primary` | 待用 |
| 圆角（按钮、输入、画面） | `--dsw-radius-sm` | 待用 |
| 圆角（工具条胶囊） | `--dsw-radius-md` | 待用 |
| 字号 12 | `--dsw-font-xxs-12` | 待用（现在 6 处硬写 12px） |
| 字号 14 | `--dsw-font-s-14` | 待用（输入框正文） |
| 阴影 | `--dsw-shadow-lv1` | 不用。本页靠描边分层，零阴影 |

### 4.1 三处失效变量（必须改）

| 现用 | 宿主里是否存在 | 后果 |
| --- | --- | --- |
| `--dsw-alias-border-subtle`（94、101、112 行） | **不存在** | `border` 简写整条作废，所有按钮、输入框**没有边框**，看起来是一排裸文字 |
| `--dsw-alias-label-success`（95、105 行） | **不存在** | 模式选中态与位标圈的 `color`/`border-color` 作废，**选中了看不出来**，点一下的圈也看不见 |
| `#000`（107、108 行）、`999px`（94、105 行）、`6px`（101、107、108、112 行） | 非 token | 与宿主深浅主题无关，深浅切换后对比断层 |

替换对应：`--dsw-alias-border-subtle` → `--dsw-alias-border-l1`；`--dsw-alias-label-success` → `--dsw-alias-state-success-primary`。

### 4.2 内容色例外

标注笔迹（`client.js:355`、`375`）保留红色：它随标注图回传给对话，是**内容**不是界面，必须在任何 App 截图上都看得见。界面上的位标圈用 `--dsw-alias-state-success-primary`。

## 5. 状态与空态

优先级从高到低，一次只显示一条，同一行给修法。

| 条件 | 文案 | 落在哪 |
| --- | --- | --- |
| `serial === ''` | 没有连接设备，插上线就会自己出现 | 画面区中央，替换空白 |
| 设备在但未授权 | 手机上要允许 USB 调试，再插一次线 | 同上 |
| 设备在、1.2 秒内没画面 | 画面准备中 | 同上 |
| 3 秒仍没画面 | 画面还没到，正在换一种取帧方式 | 同上（不写"抓帧/MSF"这类实现词） |
| 设备断开 | 设备已断开，插回来自动恢复 | 同上 |
| 发送成功 | 已发送 | 工具条状态行，3 秒自动消失 |
| 发送失败 | 发送失败，再点一次发送 | 工具条状态行，常驻到下次操作 |

规则：空态给**动作**，不给**解释**。现在 `serial === ''` 时 `client.js:960` 直接 `null`，画面区是一块纯色空白，人不知道是没设备还是坏了。

## 6. 文案表

上屏字符串有两个来源：`locale/zh.json`（只有 2 条 `meta.*`）与 `client.js` 的 `DICT`（真实界面文字，28–73 行）。两张表都列。

### 6.1 `locale/zh.json`

| key | 现在 | 建议 |
| --- | --- | --- |
| `meta.title` | 真机调试（ADB） | 真机调试（ADB） |
| `meta.description` | 用界面文本树代替截图：读界面、按文字或控件点击、等界面变化、看日志、装包启停，只在需要看外观时截图。 | 读界面文字代替截图：读界面、按文字或控件点击、等界面变化、看日志、装包启停，只在看外观时截图。 |

`meta.description` 是工具清单描述（面向 agent），技术词保留，只删「用……代替……」的对比句与重复的「截图」。

### 6.2 `client.js` DICT

| key | 现在 | 建议 | 理由 |
| --- | --- | --- | --- |
| `type.label` | 实时ADB | 真机画面 | 页签名说"这里是什么"，不说缩写 |
| `type.hint` | 手机画面同步显示，点一下就是点手机 | 点一下就是点手机 | 前半句是结构自述 |
| `act.mark` | 标注 | 标注 | 保留 |
| `act.tap` | 点按 | 点按 | 保留 |
| `act.send` | 发送 | 发送 | 保留 |
| `act.clear` | 清除 | 清除 | 保留 |
| `act.recent` | 近几秒 | 最近几秒 | 补全 |
| `state.starting` | 画面准备中 | 画面准备中 | 保留，但 1.2 秒后才出现 |
| `state.sent` | 已发送 | 已发送 | 保留 |
| `state.failed` | 发送失败 | 发送失败，再点一次发送 | 状态行同一句给修法 |
| `ph.note` | 说一下这是什么 | 这是什么 | 删口语铺垫 |
| `ph.text` | 输入文字 | 要发的文字 | 说清去向 |
| `act.text` | 输入 | 发送文字 | 动作说清后果 |
| `act.fit` | 适应 | 适应画面 | 与设备键区分 |
| `key.back` | 返回 | 返回 | 保留 |
| `key.home` | 主屏 | 主屏 | 保留 |
| `key.enter` | 回车 | 回车 | 保留 |
| `key.del` | 删除 | 删除 | 保留 |
| `key.tab` | 制表 | 制表 | 保留 |
| `state.sending` | 发送中 | 发送中 | 保留 |

另：`client.js:567` 有一句硬编码 `正在载入新版本…`，不在 DICT 里。自动重载不需要告知，删掉这句字符串。

## 7. 自检（按 frontend-design-spec 第一节）

- **P1 对比**：`label-secondary` 在 `bg-base` 上 ≥ 4.5:1，日志与提示用它，不用更浅的色。
- **P2 单一重音**：success 只给「生效中」和「刚点的那下」，failed 只给失败，其余中性。
- **P4 圆角/阴影**：圆角只用 `--dsw-radius-sm` 与 `--dsw-radius-md`（两档），阴影零。
- **P5 字号**：12 与 14 两档，间隔 2px，够。
- **P7 三态**：空、加载、错误都在 §5 有独立一句。
- **P8 不重复**：页签标题与面板内标题不重复同一句话（现在 `adbm-title` 只做 `type.label`，见 P2-1）。
- **P9 不自述**：不写「左右分栏」「缩放面板」这类结构说明。

## 8. 存量问题（不改，只记账）

本节记录本轮之前就存在的问题与归属，避免被当成新写坏的地方。

| 工具 | 结果 | 归属 |
| --- | --- | --- |
| `ui-copy-lint.mjs` | 375 error / 212 warning（5 文件） | 主要是注释与内部状态对象被当成界面文案：`index.js` 307、`mirror.js` 24、`stream.js` 10、`client.js` 23，其余在 `ocr.js`/`selftest.mjs`。`client.js` 的 23 条全在文件头注释与 `report()` 诊断字段，不在渲染出的界面里 |
| `zh-lint.mjs` | 0 error / 34 warning | 省略号写成三个点：`index.js`、`mirror.js`、`stream.js` |
| `style-lint.mjs` | 通过（文字色 1、背景色 2、圆角 2、字号 1、阴影 0） | 无 error |

归属结论：

- `client.js` 的注释类 error 由 `client.js` 归属方（本轮为 Lead 在改的那一路）处理，本轮设计不碰该文件。
- `index.js`、`mirror.js`、`stream.js`、`ocr.js` 的 error 与本页界面无关，不在本轮范围。
- 本轮新增的两个 markdown 文件不进上述扫描器的扩展名集合（`ui-copy-lint` 只扫 `.js/.jsx/.ts/.tsx/.vue/.svelte/.html/.astro/.mdx`），`zh-lint` 会扫 `.md`，本轮已按它的规则写：全角标点、`……` 六点、无空转营销词。

## 9. 本轮不动

- 不碰 `client.js`、`locale/*.json`、`package.json`。
- 不碰帧来源判定（`engine` 在 `mse`/`jpeg` 之间的切换），那是 §3.1 契约之外的上游问题。
- 不碰标注落盘、录制、`/annotate` 报文。
- 不动键位集合与键码映射。
