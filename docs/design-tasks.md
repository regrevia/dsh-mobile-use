# 实时ADB 栏 · 整改清单

来源：`DESIGN.md`。只改 `client.js` 一个文件，按 P0 → P1 → P2 顺序做。
行号是写这一刻的实测值（`client.js` 1356 行），**按选择器定位，不要按行号盲改**：这个文件当前有人同时在改。
`CSS` 是一个字符串数组（91–114 行），每条规则是数组里的一行字符串，改的时候连着引号和逗号一起换。

| # | 优先级 | 一件事 | 改哪里 |
| --- | --- | --- | --- |
| 1 | P0 | 帧框尺寸与帧像素解耦 | `.adbm-frame` / `.adbm-img` / `.adbm-video`，JSX 画面框 |
| 2 | P0 | 两个不存在的宿主变量 | `.adbm-btn` / `.adbm-key` / `.adbm-input` / `.adbm-mark` |
| 3 | P0 | 四个空态没有落点 | JSX 画面区 |
| 4 | P0 | 状态行抢宽度、空着也占位 | `.adbm-bar` / `.adbm-said` |
| 5 | P1 | 没有主按钮 | 工具条 `send` |
| 6 | P1 | 缩放控件挤在设备键里 | `.adbm-keys` 尾部 |
| 7 | P1 | 日志只能看一条 | `.adbm-log` |
| 8 | P1 | 文案与硬编码字符串 | `DICT`、重载提示 |
| 9 | P2 | 三档圆角、硬写字号 | 圆角 / 字号 |
| 10 | P2 | 页签标题与面板标题重复 | 页签 title 槽 |

---

## P0-1 帧框尺寸只由容器决定

**改哪里**：CSS `.adbm-frame`（99 行）、`.adbm-img`（107 行）、`.adbm-video`（108 行）；JSX 画面框（996 行起，`className: 'adbm-frame'` 那个 div）。

**改成什么**：给帧框一个由设备屏幕比例算出的固定比例盒，画面在盒内 `contain`。盒子的宽高不再来自 `<img>`/`<video>` 的内在像素，帧换源时不会重排。

```js
// CSS 数组里整条替换
'.adbm-frame{position:relative;display:block;width:100%;height:auto;aspect-ratio:var(--adbm-ar,9 / 16);max-height:100%;line-height:0;transform-origin:0 0}',
'.adbm-img{display:block;width:100%;height:100%;object-fit:contain;background:var(--dsw-alias-bg-layer-1);border-radius:var(--dsw-radius-sm);-webkit-user-drag:none;user-select:none}',
'.adbm-video{display:block;width:100%;height:100%;object-fit:contain;background:var(--dsw-alias-bg-layer-1);border-radius:var(--dsw-radius-sm)}',
```

```js
// JSX 画面框：比例只取设备屏幕，横竖转过来时交换分子分母
const ar = screen.w > 0 && screen.h > 0
  ? (turned() ? `${screen.h} / ${screen.w}` : `${screen.w} / ${screen.h}`)
  : '9 / 16'
const frameStyle = { '--adbm-ar': ar }
if (zoom !== 1) frameStyle.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`
```

**不要动**：帧像素的两个写入源（推流回调与 `/state` 的 `frame`）。设计上它们只服务点击映射，已经不参与布局，谁大谁小都不再影响盒子。`--adbm-ar` 是布局比例变量，不是配色。

**验收**：同一台设备上在两种取帧方式之间来回切，`.adbm-frame` 的 `getBoundingClientRect()` 宽高前后完全相等，右栏不再出现一大一小。

---

## P0-2 两个宿主变量根本不存在

**改哪里**：94、101、112 行的 `var(--dsw-alias-border-subtle)`；95、105 行的 `var(--dsw-alias-label-success)`。

**为什么**：这两个名字在宿主打包产物里一次都没有出现。`border` 简写里出现无效变量会让整条声明作废，所以现在按钮和输入框**没有边框**；选中态与点按圈的 `color`/`border-color` 也整条作废，**选中了看不出来，点一下的圈也看不见**。

**改成什么**：

```js
// 描边：静息 l1，悬停 l2
'.adbm-btn{font:inherit;font-size:var(--dsw-font-xxs-12);padding:2px 10px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;cursor:pointer;flex:none;white-space:nowrap}',
'.adbm-btn:hover:not([disabled]){border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover)}',
'.adbm-btn[data-on="1"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
'.adbm-key{font:inherit;font-size:var(--dsw-font-xxs-12);padding:2px 8px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;cursor:pointer;flex:none;white-space:nowrap}',
'.adbm-input{flex:none;font:inherit;font-size:var(--dsw-font-s-14);padding:5px 8px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit}',
'.adbm-input:focus-visible,.adbm-input:focus{border-color:var(--dsw-alias-border-l2);outline:none}',
```

```js
// 点按位标：颜色换成真实存在的 success
'.adbm-mark{position:absolute;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:var(--dsw-radius-md);border:2px solid var(--dsw-alias-state-success-primary);pointer-events:none;animation:adbm-ping .9s ease-out forwards}',
```

**验收**：选中「标注」后它的文字与描边变绿，再点「点按」它恢复次级色；在画面上点一下，那一圈绿环看得见；所有按钮和输入框有一圈可见描边。

---

## P0-3 四个空态给一行话

**改哪里**：JSX 画面区（995 行起）。现在 `serial === ''` 时直接 `null`，画面区就是一块纯色空白，人分不清是没设备、没授权还是坏了。

**改成什么**：画面区里按优先级只出一条状态句，句子里带修法。

```js
/* 一次只出一条，同一行给修法：空态说动作，不说原因。 */
const hintOf = () => {
  if (serial === '') return '没有连接设备，插上线就会自己出现'
  if (!devices.includes(serial)) return '设备已断开，插回来自动恢复'
  if (!ready) return sinceMs < 1200 ? '' : (sinceMs < 3000 ? '画面准备中' : '画面还没到，换一种方式取画面')
  return ''
}
const empty = serial === '' || !devices.includes(serial) || !ready ? hintOf() : ''
```

```js
h('div', { className: 'adbm-stage', ref: stageRef },
  empty === '' ? null : h('p', { className: 'adbm-empty' }, empty),
  h('div', { className: 'adbm-frame', ... }), ...
)
```

```js
'.adbm-empty{position:absolute;inset:auto 12px;margin:0;text-align:center;font-size:var(--dsw-font-xs-13);line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
```

未授权（USB 调试弹窗没点）在画面区表现为长时间没画面，走同一句第三档；`index.js` 的授权状态若有专门字段，把第一档换掉即可，界面结构不变。

**验收**：拔掉设备后画面区出现「没有连接设备，插上线就会自己出现」，插回来自动恢复画面且这句话消失。

---

## P0-4 状态行独占一行、不占位

**改哪里**：CSS `.adbm-bar`（93 行）、`.adbm-said`（97 行）；JSX 状态 span（986 行）。

**为什么**：现在 `.adbm-said` 是 `flex:1 1 auto;text-align:right`，夹在两组按钮中间，而且不管有没有话说都渲染一个占位 span。380px 宽时它只剩几个像素，「画面准备中」被压成省略号。

**改成什么**：

```js
'.adbm-bar{flex:none;display:flex;align-items:center;flex-wrap:wrap;gap:6px;row-gap:4px;font-size:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);min-height:26px}',
'.adbm-said{flex:1 1 100%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}',
```

```js
// 没话说就不渲染整个节点，换行时不占一行高度
const line = status !== '' ? status : (ready ? '' : L('state.starting'))
...
line === '' ? null : h('span', { className: 'adbm-said' }, line),
```

**验收**：把右栏拖到 380px 宽，工具条按钮换行且互不重叠；不说话时工具条只有一行高，出「已发送」时它左对齐独占下一行。

---

## P1-1 只留一个主按钮

**改哪里**：工具条 `send` 那颗按钮（`button({ label: L('act.send'), ... })`，当前 968 行附近）。

**为什么**：6 个胶囊同权重，「发送」与「近几秒」长得一样，人第一眼找不到主操作。

**改成什么**：

```js
// 让 button() 透传一个 data-primary
send: () => button({ label: L('act.send'), disabled: !ready, primary: true, onClick: send }),
```

```js
'.adbm-btn[data-primary="1"]{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-inverted)}',
'.adbm-btn[data-primary="1"]:hover:not([disabled]){background:var(--dsw-alias-button-primary-hover);border-color:transparent}',
'.adbm-btn[data-primary="1"][disabled]{background:transparent;border-color:var(--dsw-alias-border-l1);color:inherit}',
```

**验收**：工具条里只有一颗实底按钮，其余都是透明底描边；画面没起来时它退回描边样式。

---

## P1-2 缩放回到画面上

**改哪里**：`.adbm-keys` 尾部三颗（`act.fit` / `2×` / `3×`，当前 1066–1068 行附近）；CSS 新增 `.adbm-zoom`。

**为什么**：缩放改的是画面，不是设备键；它挤在键位行里既撑破窄栏，也让人误以为它控制手机。

**改成什么**：三颗移到画面区里做覆盖层，键位行只留设备键。

```js
h('div', { className: 'adbm-stage', ref: stageRef },
  h('div', { className: 'adbm-zoom' },
    zoomBtn('1', L('act.fit'), () => zoomTo(1)),
    zoomBtn('2', '2×', () => zoomTo(2)),
    zoomBtn('3', '3×', () => zoomTo(3)),
  ),
  ...
)
```

```js
'.adbm-zoom{position:absolute;right:8px;bottom:8px;display:flex;gap:4px;z-index:2;pointer-events:none}',
'.adbm-zoom > *{pointer-events:auto}',
```

**验收**：键位行只剩设备键与文字输入；画面右下角有三颗小按钮；点 `2×` 画面放大，键位行不重排。

---

## P1-3 日志看得到最近几条

**改哪里**：CSS `.adbm-log`（104 行）；JSX 日志（1070 行，`ops.slice(-2).join(' · ')`）。

**为什么**：单行 `ellipsis` 把内容截断，连续点几下只看得到半条。

**改成什么**：

```js
'.adbm-log{flex:none;font-size:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);line-height:1.6;max-height:calc(1.6em * 3);overflow-y:auto;white-space:normal;overflow-wrap:anywhere}',
```

```js
ops.length === 0 ? null : h('div', { className: 'adbm-log' }, ops.slice(-3).join(' · ')),
```

**验收**：连点 5 下画面，日志区高度不变、能滚动看到最近 3 条，画面尺寸不受影响。

---

## P1-4 文案按表落地

**改哪里**：`DICT`（28–73 行，zh 与 en 两份都要同步）；重载提示（597 行）。

**改成什么**：照 `DESIGN.md` §6.2 改这 7 条：`type.label` → 真机画面、`type.hint` → 点一下就是点手机、`act.recent` → 最近几秒、`state.failed` → 发送失败，再点一次发送、`ph.note` → 这是什么、`ph.text` → 要发的文字、`act.text` → 发送文字、`act.fit` → 适应画面。597 行 `setStatus('正在载入新版本…')` 整句删掉，自动重载不需要告知。

**验收**：面板上搜不到「实时ADB」「说一下这是什么」「输入文字」，也没有任何提示说正在载入新版本。

---

## P2-1 圆角两档、字号一档

**改哪里**：圆角 999px（94、105 行）→ `var(--dsw-radius-md)`；6px（101、107、108、112 行）→ `var(--dsw-radius-sm)`；字号 12px（93、94、101、104、112 行）→ `var(--dsw-font-xxs-12)`，输入框用 `var(--dsw-font-s-14)`。

**验收**：全页只有两档圆角值、两档字号，深浅主题切换后都不变样。

---

## P2-2 页签标题不重复

**改哪里**：页签 title 槽注册处（`TITLE_SLOT`，约 1197 行）与面板内标题。

**为什么**：页签上写一遍、面板里再写一遍同一句，等于没有标题。

**改成什么**：页签留 `L('type.label')`（真机画面），面板内不再渲染同名字段；`adbm-title` 这一层如果只是重复，直接不渲染。

**验收**：页签与面板内不同时出现同一句话。

---

## 完成后自检

```bash
node ~/.agents/skills/zh-ui-type-lint/scripts/zh-lint.mjs .
node ~/.dsh/tools/style-lint.mjs .
```

`zh-lint` 只认新增的 error（基线 0 error / 34 warning，warning 都是省略号写成三个点，属于存量）。
`style-lint` 基线是 passed，改完仍应 passed；`ui-copy-lint` 的 375 条 error 是存量注释与诊断字段，本轮不动，不要在同一个提交里顺手改它们。
