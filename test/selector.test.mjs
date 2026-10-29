/**
 * 选择器语义测试：selectNodes / nearMiss / collapseSameSpot。
 * 这几条是 agent 每次点东西都要走的判定，错了就是点错地方；设备无关，纯函数直接测。
 */
import assert from 'node:assert/strict'
import { __internals } from '../index.js'

const { selectNodes, nearMiss, matches, nodeStateOk, findBlocker, failureSuffix, selectXPath, collapseSameSpot, spotList, displaySizeFrom, scrollFrames, swipeLine, guardOutput, tapMissReason, describeTapMiss, diffLines, digestLine, validateSteps, retryBudget, parseNodes, compactTree, awaitStable, acquireDirect, DIRECT_GATE } = __internals

let pass = 0
const it = (label, run) => {
  try {
    run()
    pass += 1
    console.log(`  ✅ ${label}`)
  } catch (error) {
    console.log(`  ❌ ${label}\n     ${error.message}`)
    process.exitCode = 1
  }
}

/** 造一个节点：给文字和位置就够了，其余按默认值。 */
const node = (text, x1 = 0, y1 = 0, extra = {}) => ({
  text,
  desc: '',
  id: '',
  cls: 'android.widget.TextView',
  pkg: 'com.example',
  x1,
  y1,
  x2: x1 + 100,
  y2: y1 + 40,
  clickable: false,
  enabled: true,
  ...extra,
})

const state = {
  nodes: [
    node('设置', 0, 0, { id: 'com.example:id/settings', clickable: true }),
    node('设置壁纸', 0, 100),
    node('登录', 0, 200, { id: 'com.example:id/login_btn', clickable: true }),
    node('', 0, 300, { desc: '更多选项', id: 'com.example:id/more', clickable: true }),
    node('隐藏项', 0, 400, { x2: 0, y2: 400 }),
  ],
  refs: [],
}

it('文字默认包含匹配', () => {
  assert.equal(selectNodes(state, { text: '设置' }).length, 2)
})

it('exact 只留完全相等', () => {
  const hits = selectNodes(state, { text: '设置', exact: true })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].id, 'com.example:id/settings')
})

it('regex 打字也能命中', () => {
  assert.equal(selectNodes(state, { text: '^设', regex: true }).length, 2)
})

it('id 写后半段就能命中', () => {
  const hits = selectNodes(state, { id: 'login_btn' })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].text, '登录')
})

it('文字和 id 是 AND 不是 OR', () => {
  assert.equal(selectNodes(state, { text: '设置', id: 'login_btn' }).length, 0)
})

it('desc 可搜，也可当文字搜', () => {
  assert.equal(selectNodes(state, { desc: '更多' }).length, 1)
  assert.equal(selectNodes(state, { text: '更多' }).length, 1)
})

it('clickable 只留能点的', () => {
  const hits = selectNodes(state, { clickable: true })
  assert.equal(hits.length, 3)
})

it('visible 去掉零面积的', () => {
  assert.equal(selectNodes(state, { text: '隐藏项', visible: true }).length, 0)
  assert.equal(selectNodes(state, { text: '隐藏项' }).length, 1)
})

it('同一处的多层只留最精确那层', () => {
  /* 中心相距 12px 内算同一处；留下面积小的那层，也就是更精确的按钮本体。 */
  const stacked = [node('外层', 0, 0, { x2: 200, y2: 100 }), node('内层', 90, 40, { x2: 110, y2: 60 })]
  const kept = collapseSameSpot(stacked)
  assert.equal(kept.length, 1)
  assert.equal(kept[0].text, '内层')
})

it('all=true 不归并，原样给全部', () => {
  const stacked = [node('外层', 0, 0, { x2: 200, y2: 100 }), node('内层', 90, 40, { x2: 110, y2: 60 })]
  assert.equal(selectNodes({ nodes: stacked }, { text: '', all: true }).length, 2)
})

it('index 从 0 开始，越界说清有几个', () => {
  assert.equal(selectNodes(state, { text: '设置', index: 0 }).length, 1)
  assert.equal(selectNodes(state, { text: '设置', index: 1 })[0].text, '设置壁纸')
  assert.throws(() => selectNodes(state, { text: '设置', index: 5 }), /只有 2 个匹配/)
})

it('within_ref 只在容器里找', () => {
  const box = node('容器', 0, 150, { x2: 400, y2: 400, id: 'com.example:id/list' })
  const withRef = { ...state, refs: [{ ref: 7, node: box }] }
  const hits = selectNodes(withRef, { text: '登录', within_ref: 7 })
  assert.equal(hits.length, 1)
  assert.equal(selectNodes(withRef, { text: '设置', within_ref: 7 }).length, 0)
  assert.throws(() => selectNodes(state, { text: '登录', within_ref: 99 }), /不在当前快照里/)
})

it('within_rect 只留中心落在框里的', () => {
  assert.equal(selectNodes(state, { text: '设置', within_rect: [0, 90, 400, 200] }).length, 1)
})

it('nearMiss 给相近候选，不是空话', () => {
  const hint = nearMiss(state, { text: '置壁' })
  assert.match(hint, /相近的有/)
  assert.match(hint, /设置/)
  assert.equal(nearMiss(state, { text: 'zzz' }), '')
})

it('spotList 给可点坐标，多了说等几处', () => {
  const twice = spotList([node('a', 0, 0), node('b', 0, 100)])
  assert.match(twice, /@50,20/)
  assert.match(twice, /@50,120/)
  assert.match(spotList([1, 2, 3, 4, 5].map((i) => node('x', 0, i * 100))), /等 5 处/)
})

it('横屏/分屏按当前显示尺寸算滑点，不拿物理竖屏尺寸', () => {
  const dump = ['  init=1600x1068 1dpi cur=1600x1068 app=1600x1068', '  init=2136x3200 440dpi cur=3200x2136 app=3200x2136'].join('\n')
  assert.deepEqual(displaySizeFrom(dump, { width: 2136, height: 3200 }), { width: 3200, height: 2136 })
  assert.deepEqual(displaySizeFrom(dump, null), { width: 3200, height: 2136 })
  assert.equal(displaySizeFrom('no display info', null), null)
  assert.equal(displaySizeFrom(dump, { width: 1600, height: 1068 }).width, 1600)
})

it('分屏里只滑真正可滚的容器，嵌套留最内层，没有就退回中间', () => {
  const size = { width: 3200, height: 2136 }
  const outer = { scrollable: true, x1: 0, y1: 0, x2: 900, y2: 2136 }
  const inner = { scrollable: true, x1: 0, y1: 300, x2: 900, y2: 2000 }
  const right = { scrollable: true, x1: 1000, y1: 100, x2: 3100, y2: 2000 }
  const plain = { scrollable: false, x1: 0, y1: 0, x2: 3200, y2: 2136 }
  const boxes = scrollFrames({ nodes: [outer, inner, right, plain] }, size)
  assert.equal(boxes.length, 2)
  assert.deepEqual(boxes.find((b) => b.w === 900), { x: 0, y: 300, w: 900, h: 1700 })
  assert.deepEqual(scrollFrames({ nodes: [plain] }, size), [{ x: 480, y: 427, w: 2240, h: 1282 }])
  assert.deepEqual(swipeLine({ x: 0, y: 300, w: 900, h: 1700 }, 'up'), [450, 1745, 450, 555])
  assert.deepEqual(swipeLine({ x: 0, y: 300, w: 900, h: 1700 }, 'down'), [450, 555, 450, 1745])
})

it('输出守卫：必填补空值、选填丢 null、多余字段丢掉，别让成功动作变硬错误', () => {
  const schema = {
    type: 'object',
    properties: { ok: { type: 'boolean' }, swipes: { type: 'integer' }, ref: { type: 'integer' }, note: { type: 'string' }, list: { type: 'array', items: { type: 'object', properties: { at: { type: 'integer' }, id: { type: 'string' } }, required: ['at'], additionalProperties: false } }, maybe: { type: ['string', 'null'] } },
    required: ['ok', 'swipes', 'ref', 'note', 'list', 'maybe'],
    additionalProperties: false,
  }
  const got = guardOutput(schema, { ok: true, swipes: null, ref: undefined, note: null, list: [{ at: 2, id: null, junk: 1 }], maybe: null, extra: 'x' })
  assert.deepEqual(got, { ok: true, swipes: 0, ref: 0, note: '', list: [{ at: 2 }], maybe: null })
  const opt = { type: 'object', properties: { ok: { type: 'boolean' }, point: { type: 'string' } }, required: ['ok'], additionalProperties: false }
  assert.deepEqual(guardOutput(opt, { ok: true, point: null }), { ok: true })
})

it('点空归因：键盘挡、弹窗挡、目标不可点、页面换了，各给一句话说清', () => {
  const node = (over) => ({ x1: 0, y1: 0, x2: 1080, y2: 200, text: '', desc: '', cls: 'android.view.View', pkg: 'com.demo', clickable: false, enabled: true, ...over })
  const tap = { x: 540, y: 1200 }
  const keyboard = { nodes: [node({ pkg: 'com.sohu.inputmethod.sogou', cls: 'android.inputmethodservice.KeyboardView', y1: 800, y2: 3000 })], activity: '.Main' }
  assert.match(tapMissReason(keyboard, tap, null, null), /键盘/)
  const dialog = { nodes: [node({ pkg: 'com.android.systemui', cls: 'android.widget.FrameLayout', y2: 3000 })], activity: '.Main' }
  assert.match(tapMissReason(dialog, tap, null, null), /挡住/)
  const plain = { nodes: [node({ pkg: 'com.demo', cls: 'android.widget.FrameLayout', y2: 3000 })], activity: '.Main' }
  const label = { nodes: [node({ pkg: 'com.demo', cls: 'android.widget.FrameLayout', y2: 3000 }), node({ text: '确定', pkg: 'com.demo', clickable: false })], activity: '.Main' }
  assert.match(tapMissReason(label, tap, { text: '确定', clickable: false, desc: '' }, null), /不能点|不可点/)
  assert.match(tapMissReason(plain, tap, { text: '已消失', clickable: true, desc: '' }, null), /不在这屏/)
  assert.match(tapMissReason(plain, tap, null, { activity: '.Other' }), /页面已经切换/)
  assert.match(tapMissReason({ nodes: [], activity: '' }, tap, null, null), /读不到/)
})

it('失败现场摘要：只取带文字的控件行、去重、截行数，空树给空串', () => {
  const lines = [
    ' 1 FrameLayout @540,1000',
    ' 2 TextView "登录" @540,400 *',
    ' 3 TextView "登录" @540,401 *',
    ' 4 TextView "我的设备" @540,800 *',
    '   5 EditText "账号或密码" @540,1200 ~',
    ' 6 TextView "这段文字很长很长很长很长很长很长很长很长很长很长很长" @540,1600',
  ]
  assert.equal(digestLine(lines, 3), '登录 | \u6211\u7684\u8bbe\u5907 | 账号或密码')
  assert.equal(digestLine([' 1 FrameLayout @1,2'], 4), '')
  assert.equal(digestLine([], 4), '')
  assert.equal(digestLine(null, 4), '')
  assert.match(digestLine(lines, 5), /…$/)
})

it('步骤预检：空 steps、一步两个动作、long 配错、swipe/ref/direction 写坏，都在连设备之前说清第几步', () => {
  assert.equal(validateSteps([]).ok, false)
  assert.match(validateSteps([]).problems[0], /至少要写一步/)
  assert.equal(validateSteps([{ tap: '登录' }, { wait_text: '首页' }]).ok, true)
  assert.equal(validateSteps([{ scroll_to: '关于手机' }, { wait_idle: true }]).ok, true)
  const both = validateSteps([{ tap: '登录' }, { tap: '确定', key: 'BACK' }])
  assert.equal(both.ok, false)
  assert.match(both.problems[0], /^第 2 步同时给了 tap 和 key/)
  assert.match(validateSteps([{ tap: '登录', long: true }, { text: '你好', long: true }]).problems[0], /long 只能配/)
  assert.match(validateSteps([{ ref: 0 }]).problems[0], /ref 要从 1 开始/)
  assert.match(validateSteps([{ swipe: [1, 2, 3] }]).problems[0], /swipe 要写/)
  assert.match(validateSteps([{ scroll_to: '设置', direction: 'up2' }]).problems[0], /direction 只能是/)
  assert.match(validateSteps([{ sleep_ms: -1 }]).problems[0], /sleep_ms 要写非负/)
  assert.match(validateSteps([{ note: 'x' }]).problems[0], /什么都没做/)
})

it('界面树解实体：换行、&、引号、十六进制都能还原，认不出的原样留着', () => {
  const xml = '<hierarchy><node text="按住&#10;说话" content-desc="A&amp;B &#x4e2d;" class="android.widget.TextView" resource-id="a&#47;b" bounds="[0,0][10,10]"/>'
    + '<node text="坏实体&#xZZ; 与裸&" class="android.view.View" bounds="[0,0][10,10]" /></hierarchy>'
  const nodes = parseNodes(xml)
  assert.equal(nodes.length, 2)
  assert.equal(nodes[0].text, '按住\n说话')
  assert.equal(nodes[0].desc, 'A&B 中')
  assert.equal(nodes[0].id, 'a/b')
  assert.equal(nodes[1].text, '坏实体&#xZZ; 与裸&')
})


it('报错建议按查找维度给：按 id 提示 id、按类名提示类名、按文字提示文字', () => {
  const screen = {
    nodes: [
      { text: '设置', desc: '', id: 'settingsHeader', cls: 'android.widget.LinearLayout', clickable: true },
      { text: '', desc: '', id: 'settingsRow', cls: 'android.widget.TextView', clickable: true },
      { text: '更多', desc: '', id: 'moreHeader', cls: 'android.widget.LinearLayout', clickable: false },
      { text: '', desc: '', id: 'plainBox', cls: 'android.widget.FrameLayout', clickable: false },
    ],
  }
  const byId = nearMiss(screen, { id: 'setting' })
  assert.match(byId, /settingsHeader/)
  assert.match(byId, /settingsRow/)
  assert.doesNotMatch(byId, /设置/)
  const byCls = nearMiss(screen, { cls: 'TextView' })
  assert.match(byCls, /TextView/)
  assert.doesNotMatch(byCls, /LinearLayout/)
  assert.match(nearMiss(screen, { text: '设置项' }), /设置/)
  assert.equal(nearMiss(screen, { text: '' }), '')
  assert.equal(nearMiss(screen, { cls: '' }), '')
  assert.equal(nearMiss({ nodes: [] }, { text: '设置' }), '')
})

it('等待条件能一次等多个 / 任一 / 某个包，缺失的单一条件都不算过', () => {
  const screen = {
    activity: 'com.whale.pet/.MainActivity',
    nodes: [
      { text: '加载完成', desc: '', id: 'okTip', pkg: 'com.whale.pet', cls: 'TextView' },
      { text: '重试', desc: '', id: 'retryBtn', pkg: 'com.whale.pet', cls: 'Button' },
      { text: '网络异常', desc: '', id: 'errTip', pkg: 'com.whale.pet', cls: 'TextView' },
    ],
  }
  assert.equal(matches(screen, { texts: ['加载完成', '重试'] }), true)
  assert.equal(matches(screen, { texts: ['加载完成', '确定'] }), false)
  assert.equal(matches(screen, { any_texts: ['确定', '重试'] }), true)
  assert.equal(matches(screen, { any_texts: ['确定', '取消'] }), false)
  assert.equal(matches(screen, { any_texts: [] }), true)
  assert.equal(matches(screen, { pkg: 'whale' }), true)
  assert.equal(matches(screen, { pkg: 'com.tencent.mm' }), false)
  assert.equal(matches(screen, { activity: 'mainactivity', texts: ['重试'] }), true)
  assert.equal(matches(screen, { gone: '网络异常' }), false)
  assert.equal(matches(screen, { gone: '网络异常', any_texts: ['加载完成'] }), false)
})

it('步骤预检认识 wait_all / wait_any：空数组、非文字、超 8 条都在连设备之前拒掉', () => {
  assert.equal(validateSteps([{ wait_all: ['加载完成', '确定'] }]).ok, true)
  assert.equal(validateSteps([{ tap: '确定', wait_any: ['已发送', '失败'] }]).ok, true)
  const empty = validateSteps([{ wait_all: [] }])
  assert.equal(empty.ok, false)
  assert.match(empty.problems[0], /wait_all 要写文字数组/)
  const bad = validateSteps([{ wait_any: ['好的', 42] }])
  assert.equal(bad.ok, false)
  assert.match(bad.problems[0], /每一项都要是非空文字/)
  const many = validateSteps([{ wait_all: Array.from({ length: 9 }, (_, i) => `条件${i}`) }])
  assert.equal(many.ok, false)
  assert.match(many.problems[0], /最多 8 条/)
})

it('步骤预检认识 wait_activity：等页面跳转，正则写错在连设备之前就报', () => {
  assert.equal(validateSteps([{ tap: '扫码绑定', wait_activity: 'ScanActivity' }]).ok, true)
  const empty = validateSteps([{ wait_activity: '  ' }])
  assert.equal(empty.ok, false)
  assert.match(empty.problems[0], /wait_activity 要写页面正则/)
  const bad = validateSteps([{ wait_activity: 'Scan(' }])
  assert.equal(bad.ok, false)
  assert.match(bad.problems[0], /不是合法正则/)
})

it('选择器能按控件状态挑：勾选 / 选中 / 可滚 / 焦点 / 可输入，且 false 是「没这个状态」', () => {
  const mk = (over) => ({
    depth: 1, text: '', id: '', cls: 'TextView', desc: '', clickable: false, longClickable: false,
    scrollable: false, enabled: true, checked: false, selected: false, focused: false,
    x1: 0, y1: 0, x2: 100, y2: 40, parent: -1, ...over,
  })
  const nodes = [
    mk({ text: '记住我', cls: 'CheckBox', checked: true }),
    mk({ text: '记住我', cls: 'CheckBox', checked: false, y1: 40, y2: 80 }),
    mk({ text: '手机号', cls: 'EditText', focused: true, y1: 80, y2: 120 }),
    mk({ cls: 'RecyclerView', scrollable: true, y1: 120, y2: 400 }),
    mk({ text: '未读', cls: 'Tab', selected: true, y1: 400, y2: 440 }),
  ]
  const state = { nodes, refs: [], tree: { lines: [], refs: [], kept: nodes.length, total: nodes.length } }
  assert.equal(selectNodes(state, { text: '记住我', checked: true }).length, 1)
  assert.equal(selectNodes(state, { text: '记住我', checked: false }).length, 1)
  assert.equal(selectNodes(state, { scrollable: true })[0].cls, 'RecyclerView')
  assert.equal(selectNodes(state, { focused: true })[0].text, '手机号')
  assert.equal(selectNodes(state, { editable: true, focused: true }).length, 1)
  assert.equal(selectNodes(state, { editable: false, cls: 'CheckBox', text: '记住我' }).length, 2)
  assert.equal(selectNodes(state, { selected: true })[0].text, '未读')
  /* 状态选择器和别的条件一起用时是 AND：勾选 + 没勾上的文字不一样时不能串。 */
  assert.equal(selectNodes(state, { text: '未读', checked: true }).length, 0)
})

it('密码框在树上标 [pwd]，也能按 password 挑出来', () => {
  const xml = '<hierarchy><node class="android.widget.EditText" text="••••" password="true" focused="true" bounds="[0,0][400,120]" /><node class="android.widget.EditText" text="张三" bounds="[0,120][400,240]" /></hierarchy>'
  const nodes = parseNodes(xml)
  const tree = compactTree(nodes, {})
  assert.match(tree.lines[0], /\[pwd\]/)
  assert.equal(nodes[0].password, true)
  assert.equal(nodes[1].password, false)
  const state = { nodes, refs: tree.refs, tree }
  assert.equal(selectNodes(state, { password: true }).length, 1)
  assert.equal(selectNodes(state, { password: false }).length, 1)
})

it('adb_do 每一步能带 scroll 边滑边找，写错了当场报', () => {
  assert.equal(validateSteps([{ tap: '设置', scroll: 3 }]).ok, true)
  assert.equal(validateSteps([{ id: 'btn', scroll: 1, scroll_direction: 'down' }]).ok, true)
  assert.match(validateSteps([{ tap: '设置', scroll: 0 }]).problems[0], /scroll 要写 1–15/)
  assert.match(validateSteps([{ tap: '设置', scroll: 99 }]).problems[0], /scroll 要写 1–15/)
  assert.match(validateSteps([{ ref: 2, scroll: 3 }]).problems[0], /scroll 只能配 tap \/ id/)
  assert.match(validateSteps([{ tap: '设置', scroll: 2, scroll_direction: '斜着' }]).problems[0], /scroll_direction 只能是/)
})

it('可输入框在树上标 [edit]，密码框标 [pwd]，两者不重复标', () => {
  const xml = '<hierarchy><node class="android.widget.EditText" text="" bounds="[0,0][400,120]" /><node class="android.widget.EditText" text="••••" password="true" bounds="[0,120][400,240]" /><node class="android.widget.TextView" text="手机号" bounds="[0,240][400,360]" /></hierarchy>'
  const nodes = parseNodes(xml)
  const tree = compactTree(nodes, {})
  assert.match(tree.lines[0], /\[edit\]/)
  assert.match(tree.lines[1], /\[pwd\]/)
  assert.ok(!/\[edit\]/.test(tree.lines[1]))
  assert.ok(!/\[edit\]|\[pwd\]/.test(tree.lines[2]))
  assert.equal(selectNodes({ nodes, refs: tree.refs, tree }, { editable: true }).length, 2)
})

it('swipeLine 按方向与 percent 出直线，默认行程与旧版一致，越界会夹住', () => {
  const box = { x: 0, y: 0, w: 100, h: 200 }
  assert.deepEqual(swipeLine(box, 'up'), [50, 170, 50, 30])
  assert.deepEqual(swipeLine(box, 'down'), [50, 30, 50, 170])
  assert.deepEqual(swipeLine(box, 'left'), [85, 100, 15, 100])
  assert.deepEqual(swipeLine(box, 'right'), [15, 100, 85, 100])
  assert.deepEqual(swipeLine(box, 'up', 0.4), [50, 140, 50, 60])
  assert.deepEqual(swipeLine(box, 'up', 5), [50, 200, 50, 0])
  assert.deepEqual(swipeLine(box, 'up', 0), [50, 110, 50, 90])
  assert.deepEqual(swipeLine(box, 'up', NaN), [50, 170, 50, 30])
})

it('直连 adb 的内存闸门：并发与预留字节都封顶，排队满了立刻报错', async () => {
  const one = 8 << 20
  const first = await acquireDirect(one)
  const second = await acquireDirect(one)
  const third = await acquireDirect(one)
  let fourth = null
  const pending = acquireDirect(one).then((release) => { fourth = release; return release })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(fourth, null)
  first()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(typeof fourth, 'function')
  ;(await pending)()
  second()
  third()
  const held = []
  for (let index = 0; index < DIRECT_GATE.queueMax; index += 1) {
    held.push(acquireDirect(one).catch((error) => error))
  }
  await assert.rejects(() => acquireDirect(one), /排队 \d+ 条，已经到上限/)
  for (const item of held) item.then((value) => { if (typeof value === 'function') value() })
  await new Promise((resolve) => setTimeout(resolve, 60))
  const back = await acquireDirect(one)
  back()
})

const fakeState = (lines) => ({ tree: { lines }, nodes: lines.length === 0 ? [] : [{ text: lines[0] }], activity: 'A' })

it('awaitStable：一上来就不变，立刻算稳定', async () => {
  let calls = 0
  const r = await awaitStable(async () => { calls += 1; return fakeState(['1 Button "确定"']) }, { quietMs: 120, timeoutMs: 5000 })
  assert.equal(r.stable, true)
  assert.equal(r.empty, false)
  assert.ok(calls >= 1 && calls <= 3, `calls=${calls}`)
  assert.ok(r.ms < 1000, `ms=${r.ms}`)
})

it('awaitStable：先变后静，稳定时返回静下来的那棵树', async () => {
  /* 前两帧还在变（骨架屏 → 中间态），之后固定在「完成」：必须等它真静下来再把树交出去。 */
  const frames = [['1 TextView "加载中"'], ['1 TextView "加载中 30%"'], ['1 Button "完成"']]
  let index = 0
  const next = () => fakeState(frames[Math.min(index++, frames.length - 1)])
  const r = await awaitStable(next, { quietMs: 120, timeoutMs: 5000 })
  assert.equal(r.stable, true)
  assert.equal(r.state.tree.lines.join(), '1 Button "完成"')
  assert.ok(r.dumps >= 4, `dumps=${r.dumps}`)
})

it('awaitStable：一直变就到点报不稳定，不假装稳定', async () => {
  let n = 0
  const r = await awaitStable(async () => fakeState([`1 TextView "第 ${n++} 帧"`]), { quietMs: 120, timeoutMs: 320 })
  assert.equal(r.stable, false)
  assert.equal(r.empty, false)
  assert.ok(r.ms >= 300, `ms=${r.ms}`)
})

it('awaitStable：读不到控件时不算稳定（加载中的空树最会骗人）', async () => {
  const r = await awaitStable(async () => fakeState([]), { quietMs: 120, timeoutMs: 300 })
  assert.equal(r.stable, false)
  assert.equal(r.empty, true)
})

it('retryBudget：不给就只跑一次，retry 夹在 0–3', () => {
  assert.equal(retryBudget({}), 1)
  assert.equal(retryBudget({ retry: 0 }), 1)
  assert.equal(retryBudget({ retry: 2 }), 3)
  assert.equal(retryBudget({ retry: 9 }), 4)
  assert.equal(retryBudget({ retry: -5 }), 1)
  assert.equal(retryBudget(null), 1)
})

it('depth 只列到第 N 层：深树先看骨架，别让容器吃满行数', () => {
  const node = (over) => ({
    cls: 'android.widget.TextView', text: '', desc: '', id: '', clickable: false, longClickable: false,
    scrollable: false, checked: false, selected: false, focused: false, enabled: true, password: false,
    depth: 1, x1: 0, y1: 0, x2: 100, y2: 40, ...over,
  })
  const nodes = [
    node({ text: '设置', depth: 2 }),
    node({ text: 'WLAN', depth: 3, y1: 40, y2: 80 }),
    node({ text: '很深的说明', depth: 9, y1: 80, y2: 120 }),
  ]
  assert.equal(compactTree(nodes, {}).kept, 3)
  const shallow = compactTree(nodes, { depth: 3 })
  assert.equal(shallow.kept, 2)
  assert.ok(!shallow.lines.join('\n').includes('很深的说明'))
  assert.equal(compactTree(nodes, { depth: 0 }).kept, 0)
})

it('回执原因码：模型按码分支，不用解析中文；点生效时不该给码', () => {
  const node = (over) => ({ x1: 0, y1: 0, x2: 1080, y2: 200, text: '', desc: '', cls: 'android.view.View', pkg: 'com.demo', clickable: false, enabled: true, ...over })
  const tap = { x: 540, y: 1200 }
  const keyboard = { nodes: [node({ pkg: 'com.sohu.inputmethod.sogou', cls: 'android.inputmethodservice.KeyboardView', y1: 800, y2: 3000 })], activity: '.Main' }
  assert.equal(describeTapMiss(keyboard, tap, null, null).code, 'keyboard-covered')
  const dialog = { nodes: [node({ pkg: 'com.android.systemui', cls: 'android.widget.FrameLayout', y2: 3000 })], activity: '.Main' }
  assert.equal(describeTapMiss(dialog, tap, null, null).code, 'obscured')
  const plain = { nodes: [node({ pkg: 'com.demo', cls: 'android.widget.FrameLayout', y2: 3000 })], activity: '.Main' }
  assert.equal(describeTapMiss(plain, tap, { text: '已消失', clickable: true, desc: '' }, null).code, 'gone')
  assert.equal(describeTapMiss(plain, tap, null, { activity: '.Other' }).code, 'page-switched')
  assert.equal(describeTapMiss({ nodes: [], activity: '' }, tap, null, null).code, 'unknown-tree')
  const label = { nodes: [node({ pkg: 'com.demo', cls: 'android.widget.FrameLayout', y2: 3000 }), node({ text: '确定', clickable: false })], activity: '.Main' }
  assert.equal(describeTapMiss(label, tap, { text: '确定', clickable: false, desc: '' }, null).code, 'unclickable')
})

it('点后差异：多出/少了哪几行分开列，limit 只截总数', () => {
  const before = [' 1 TextView "A" @1,1 *', ' 2 TextView "B" @1,2 *']
  const after = [' 1 TextView "A" @1,1 *', ' 3 TextView "C" @1,3 *']
  assert.deepEqual(diffLines(before, after), ['-  2 TextView "B" @1,2 *', '+  3 TextView "C" @1,3 *'])
  assert.equal(diffLines(before, after, 1).length, 1)
  assert.deepEqual(diffLines([], after), after.map((line) => `+ ${line}`))
  assert.deepEqual(diffLines(before, before), [])
  assert.deepEqual(diffLines(undefined, []), [])
})

it('带状态的等待：控件出现了但还灰着不算等到，要同一个控件同时满足', () => {
  const node = (over) => ({ x1: 0, y1: 0, x2: 200, y2: 100, text: '', desc: '', id: '', cls: 'android.widget.Button', pkg: 'com.demo', clickable: false, enabled: true, ...over })
  const state = { activity: '.Main', nodes: [node({ text: '保存', enabled: false }), node({ text: '保存草稿', clickable: true })] }
  assert.equal(matches(state, { text: '保存' }), true)
  assert.equal(matches(state, { text: '保存', until: 'clickable' }), true)
  const grey = { activity: '.Main', nodes: [node({ text: '保存', enabled: false, clickable: false })] }
  assert.equal(matches(grey, { text: '保存' }), true)
  assert.equal(matches(grey, { text: '保存', until: 'enabled' }), false, '灰按钮不该算等到')
  assert.equal(matches(grey, { text: '保存', until: 'clickable' }), false)
  assert.equal(nodeStateOk({ enabled: false }, 'enabled'), false)
  assert.equal(nodeStateOk({ checked: true }, 'checked'), true)
  assert.equal(nodeStateOk({ focused: true }, 'focused'), true)
  assert.equal(nodeStateOk({}, 'visible'), true)
  assert.equal(nodeStateOk({}, '没这个状态'), true, '未知状态不拦，避免老参数静默失效')
})

it('挡路弹窗：认出确认按钮，但不点掉自己要等的那一个', () => {
  const node = (over) => ({ x1: 0, y1: 0, x2: 200, y2: 100, text: '', desc: '', id: '', cls: 'android.widget.Button', pkg: 'com.demo', clickable: true, enabled: true, ...over })
  const dialog = { activity: '.Main', nodes: [node({ text: '允许' }), node({ text: '拒绝' })] }
  assert.equal(findBlocker(dialog, [])?.text, '允许')
  assert.equal(findBlocker(dialog, ['允许']), null, '正在等「允许」时不能把它当成弹窗点掉')
  assert.equal(findBlocker({ activity: '.Main', nodes: [node({ text: '允许', enabled: false })] }), null, '灰按钮点不动，不算')
  assert.equal(findBlocker({ activity: '.Main', nodes: [node({ text: '允许', clickable: false })] }), null)
  assert.equal(findBlocker({ activity: '.Main', nodes: [node({ text: '允许', enabled: undefined })] })?.text, '允许', 'enabled 缺字段按可用算')
  assert.equal(findBlocker({ activity: '.Main', nodes: [] }), null)
})

it('失败现场：一句话带页面、屏上内容、截图，已有的不重复拼', () => {
  assert.equal(failureSuffix({ message: '点不到' }), '点不到')
  assert.equal(
    failureSuffix({ message: '点不到', activity: 'com.a/.Main', digest: '确定 / 取消' }),
    '点不到 · 当前页面 com.a/.Main · 屏上 确定 / 取消',
  )
  assert.equal(
    failureSuffix({ message: '没有目标', activity: 'com.a/.Main', shotPath: '/tmp/x.jpg' }),
    '没有目标 · 当前页面 com.a/.Main · 截图 /tmp/x.jpg · 目标不在当前界面：用 adb_find 搜一下看现在有什么，或 adb_ui 看整屏再重试。',
  )
  const already = '超时，截图 /tmp/a.jpg'
  assert.equal(failureSuffix({ message: already, activity: 'com.a/.Main' }), already, '已带现场就不重复拼')
})

it('xpath：Appium 写法在本地一遍算完，含子节点与谓词', () => {
  // [0] 根 LinearLayout
  //  ├ [1] 标题 TextView "订单"
  //  └ [2] 行 LinearLayout  →  [3] 按钮 Button "确定"  [4] 按钮 Button "取消"
  const mk = (over) => ({ index: 0, parent: -1, depth: 0, text: '', id: '', desc: '', cls: '', pkg: '', clickable: false, enabled: true, checked: false, focused: false, selected: false, scrollable: false, password: false, ...over })
  const nodes = [
    mk({ index: 0, cls: 'android.widget.LinearLayout', pkg: 'com.a' }),
    mk({ index: 1, parent: 0, depth: 1, text: '订单', cls: 'android.widget.TextView' }),
    mk({ index: 2, parent: 0, depth: 1, cls: 'android.widget.LinearLayout' }),
    mk({ index: 3, parent: 2, depth: 2, text: '确定', id: 'com.a:id/ok', cls: 'android.widget.Button', clickable: true }),
    mk({ index: 4, parent: 2, depth: 2, text: '取消', id: 'com.a:id/cancel', cls: 'android.widget.Button', clickable: true, enabled: false }),
  ]
  const texts = (pool) => pool.map((node) => node.text)
  assert.deepEqual(texts(selectXPath(nodes, '//*[@text="确定"]')), ['确定'])
  assert.deepEqual(texts(selectXPath(nodes, '//node[@resource-id="com.a:id/ok"]')), ['确定'])
  assert.deepEqual(texts(selectXPath(nodes, '//*[contains(@text,"取")]')), ['取消'])
  assert.deepEqual(texts(selectXPath(nodes, '//LinearLayout/node[2]/Button[1]')), ['确定'])
  assert.deepEqual(texts(selectXPath(nodes, '//node[last()]')), ['取消'])
  assert.deepEqual(texts(selectXPath(nodes, '//*[@clickable="true"]')), ['确定', '取消'])
  assert.deepEqual(texts(selectXPath(nodes, '//*[@clickable="true"][@enabled="true"]')), ['确定'])
  assert.deepEqual(texts(selectXPath(nodes, '//node[not(@text)]')), ['', ''])
  assert.equal(selectXPath(nodes, '//*[@text="不存在"]').length, 0)
  assert.throws(() => selectXPath(nodes, 'xpath'), /以 \/\/ 或 \//)
  assert.throws(() => selectXPath(nodes, '//*[@text=确定]'), /谓词看不懂/)
  assert.throws(() => selectXPath(nodes, '//*[contains(@text)]'), /谓词看不懂/)
  // // 与 / 的差别：直接子 vs 任意后代
  assert.equal(selectXPath(nodes, '//LinearLayout[1]/Button').length, 0, '/ 只走直接子节点')
  assert.equal(selectXPath(nodes, '//LinearLayout[1]//Button').length, 2, '// 走全部后代')
})

console.log(`\n${pass} 项通过\n`)
