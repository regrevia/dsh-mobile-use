/**
 * 选择器语义测试：selectNodes / nearMiss / collapseSameSpot。
 * 这几条是 agent 每次点东西都要走的判定，错了就是点错地方；设备无关，纯函数直接测。
 */
import assert from 'node:assert/strict'
import { __internals } from '../index.js'

const { selectNodes, nearMiss, collapseSameSpot, spotList, displaySizeFrom, scrollFrames, swipeLine, guardOutput, tapMissReason } = __internals

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

console.log(`\n${pass} 项通过\n`)
