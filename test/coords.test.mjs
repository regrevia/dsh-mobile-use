/**
 * 坐标换算回归：从 client.js 里切出真实的 pictureRect / turned / devicePoint 源码，
 * 在 node 里用假 DOM 矩形跑。侧栏在右边时坐标曾经被减两次（视觉中心点成 0,600），
 * 这条测试就是那份审阅复现的固化版：改坏就红。
 *
 *   node test/coords.test.mjs
 */

import fs from 'node:fs'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')

const start = source.indexOf('/* 画面元素：MSE 用 video')
const end = source.indexOf('/* 平移边界')
assert.ok(start > 0 && end > start, '没找到几何换算那一段源码')

const geometry = source.slice(start, end)
const factory = new Function(
  'engine', 'videoRef', 'imgRef', 'canvasRef', 'screen', 'frameSize', 'Math',
  `${geometry}\n return { devicePoint, pictureRect, turned }`,
)

/**
 * 造一个用给定矩形假装的 DOM 元素。
 * @param {number} left - 视口左边缘。
 * @param {number} top - 视口上边缘。
 * @param {number} width - 宽。
 * @param {number} height - 高。
 * @returns {{ getBoundingClientRect: () => any }} 元素桩。
 */
const box = (left, top, width, height) => ({ getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height }) })

/**
 * 造一台设备状态下的换算器。
 * @param {{ device: {w: number, h: number}, frame: {w: number, h: number}, canvas: any, media: any, engine?: string }} config - 现场。
 * @returns {(point: {x: number, y: number}) => {x: number, y: number}} 换算函数。
 */
const make = ({ device, frame, canvas, media, engine = 'jpeg' }) => {
  const { devicePoint } = factory(engine, { current: null }, { current: media }, { current: canvas }, device, frame, Math)
  return devicePoint
}

let pass = 0
/**
 * 断言一点。
 * @param {string} label - 检查项。
 * @param {() => void} run - 断言体。
 * @returns {void}
 */
const it = (label, run) => {
  try {
    run()
    pass += 1
    console.log(`  ✅ ${label}`)
  } catch (error) {
    console.log(`  ❌ ${label}`)
    throw error
  }
}

console.log('\n坐标换算（源码级）\n')

/* 审阅给的复现：右栏里画面框 left=1000/top=100，显示 300x533.33，设备 1080x1920。
   取画面正中心，正确结果是 (540,960)；旧代码会算成 (0,600)。 */
it('右栏里点画面正中心 = 设备正中心', () => {
  const toDevice = make({
    device: { w: 1080, h: 1920 },
    frame: { w: 300, h: 533.333 },
    canvas: box(1000, 100, 300, 533.333),
    media: box(1000, 100, 300, 533.333),
  })
  assert.deepEqual(toDevice({ x: 150, y: 266.666 }), { x: 540, y: 960 })
})

it('画面有上下留边时按画面矩形换算（不是画布）', () => {
  const toDevice = make({
    device: { w: 1080, h: 1350 },
    frame: { w: 400, h: 500 },
    canvas: box(20, 40, 400, 600),
    media: box(20, 90, 400, 500),
  })
  assert.deepEqual(toDevice({ x: 200, y: 250 }), { x: 540, y: 540 })
})

it('画面有左右留边时按画面矩形换算', () => {
  const toDevice = make({
    device: { w: 1080, h: 1080 },
    frame: { w: 400, h: 400 },
    canvas: box(0, 0, 500, 400),
    media: box(50, 0, 400, 400),
  })
  assert.deepEqual(toDevice({ x: 250, y: 200 }), { x: 540, y: 540 })
})

it('画面外沿夹到边界，不会溢成负数', () => {
  const toDevice = make({
    device: { w: 1080, h: 1920 },
    frame: { w: 300, h: 533 },
    canvas: box(1000, 100, 300, 533),
    media: box(1000, 100, 300, 533),
  })
  assert.deepEqual(toDevice({ x: -50, y: 900 }), { x: 0, y: 1920 })
})

it('横屏画面 + 竖屏设备（转过 90°）映射到长边', () => {
  const toDevice = make({
    device: { w: 2136, h: 3200 },
    frame: { w: 2400, h: 1080 },
    canvas: box(0, 0, 2400, 1080),
    media: box(0, 0, 2400, 1080),
  })
  assert.deepEqual(toDevice({ x: 1200, y: 540 }), { x: 1068, y: 1600 })
})

it('MSE 走 video 元素，抓帧走 img，两条路都拿画面矩形', () => {
  const canvas = box(0, 0, 300, 500)
  const video = box(0, 0, 300, 500)
  const img = box(10, 20, 280, 460)
  const mse = factory('mse', { current: video }, { current: img }, { current: canvas }, { w: 1080, h: 1800 }, { w: 300, h: 500 }, Math)
  assert.deepEqual(mse.devicePoint({ x: 150, y: 250 }), { x: 540, y: 900 })
  const jpeg = factory('jpeg', { current: video }, { current: img }, { current: canvas }, { w: 1080, h: 1800 }, { w: 300, h: 500 }, Math)
  assert.deepEqual(jpeg.devicePoint({ x: 150, y: 250 }), { x: 540, y: 900 })
})

console.log(`\n${pass} 项通过\n`)
