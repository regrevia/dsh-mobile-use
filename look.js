/**
 * 文字之外的那层「看」：把一张截图压成颜色网格 + 色块区域 + 与上一次的差异。
 *
 * 存在的理由：canvas / 游戏 / 自绘界面里控件树只有一个空壳（PvZ 游戏内 99 个节点、0 段文字），
 * 而真要看清画面就得把整张图喂给视觉模型，一帧几百 KB、一次几百毫秒到几秒。
 * 这张网格是「像素的文本化」：模型拿到 A/B/C 三行图例 + 每格一个字母，
 * 就能判断「红色一片在左半边第 3 行」「绿色血条在右上角」，再配合格子的设备坐标直接点。
 *
 * 一次调用的成本是：截图（可复用实时帧，0–650 ms）+ ffmpeg 抽一次 RGB 原始像素（约 30–60 ms）。
 * 全程不碰视觉模型。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** 每格算完平均色之后映射到一个人眼和语言都能用的名字；名字只用于图例，坐标仍按格子走。 */
const NAMED = [
  ['黑', (r, g, b, v) => v < 0.12],
  ['白', (r, g, b, v, s) => v > 0.88 && s < 0.12],
  ['灰', (r, g, b, v, s) => s < 0.12],
  ['红', (r, g, b, v, s, h) => (h < 20 || h >= 340) && s >= 0.25],
  ['橙', (r, g, b, v, s, h) => h >= 20 && h < 45 && s >= 0.3],
  ['黄', (r, g, b, v, s, h) => h >= 45 && h < 70 && s >= 0.3],
  ['绿', (r, g, b, v, s, h) => h >= 70 && h < 165 && s >= 0.2],
  ['青', (r, g, b, v, s, h) => h >= 165 && h < 200 && s >= 0.2],
  ['蓝', (r, g, b, v, s, h) => h >= 200 && h < 260 && s >= 0.2],
  ['紫', (r, g, b, v, s, h) => h >= 260 && h < 300 && s >= 0.2],
  ['粉', (r, g, b, v, s, h) => h >= 300 && h < 340 && s >= 0.2],
  ['棕', (r, g, b, v, s, h) => h >= 20 && h < 45 && s >= 0.15],
]

function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const v = max
  const s = max === 0 ? 0 : (max - min) / max
  let h = 0
  if (max !== min) {
    if (max === r) h = ((g - b) / (max - min)) * 60
    else if (max === g) h = (2 + (b - r) / (max - min)) * 60
    else h = (4 + (r - g) / (max - min)) * 60
  }
  return [h < 0 ? h + 360 : h, s, v]
}

/** 一个 RGB 三元组 → `红`/`绿`/… 这类名字。网格图例和区域描述共用同一套。 */
export function nameOf(r, g, b) {
  const [h, s, v] = rgbToHsv(r / 255, g / 255, b / 255)
  for (const [name, test] of NAMED) {
    if (test(r, g, b, v, s, h)) return name
  }
  return '杂'
}

const hex = (r, g, b) => `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`

/**
 * 把 JPEG 压成 cols×rows 的平均色网格（每格一个 RGB）。
 *
 * 走 ffmpeg 而不是自己解 JPEG：宿主里已经有 ffmpeg（镜像通道在用），
 * 一条 `-f rawvideo` 只回 cols×rows×3 字节，几十毫秒，也不用为了几个像素引第三方解码库。
 *
 * @param {string} path 本机图片路径
 * @param {{cols?: number, rows?: number, crop?: [number, number, number, number]|null, ffmpeg?: string}} options
 * @returns {Promise<{cols: number, rows: number, cells: Array<[number, number, number]>}>}
 */
export async function sampleGrid(path, options = {}) {
  const cols = Math.max(2, Math.min(64, Math.round(options.cols ?? 12)))
  const rows = Math.max(2, Math.min(96, Math.round(options.rows ?? 24)))
  const ffmpeg = options.ffmpeg ?? process.env.FFMPEG ?? 'ffmpeg'
  const filters = []
  if (Array.isArray(options.crop) && options.crop.length === 4) {
    const [x, y, w, h] = options.crop.map((n) => Math.max(0, Math.round(n)))
    if (w > 1 && h > 1) filters.push(`crop=${w}:${h}:${x}:${y}`)
  }
  filters.push(`scale=${cols}:${rows}:flags=area`)
  const { stdout } = await run(
    ffmpeg,
    ['-y', '-loglevel', 'error', '-i', path, '-vf', filters.join(','), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 8 << 20, timeout: 20_000 },
  )
  const need = cols * rows * 3
  if (!Buffer.isBuffer(stdout) || stdout.length < need) throw new Error(`取色失败：拿到 ${stdout?.length ?? 0} 字节，需要 ${need}`)
  const cells = []
  for (let i = 0; i < cols * rows; i += 1) {
    const at = i * 3
    cells.push([stdout[at], stdout[at + 1], stdout[at + 2]])
  }
  return { cols, rows, cells }
}

/**
 * 网格 → 字母图 + 图例。
 *
 * 字母按「占用面积从大到小」分配（A 最大），并且颜色先聚类再上字母：
 * 一块蓝色渐变如果按 32 级量化会被拆成十几个字母，图例比网格还长、跨轮次也指不准。
 * 聚类做法是从面积最大的格子开始，逐个并到距离 48 以内最近的代表色，最多 `maxColors` 个；
 * 超出的并到最接近的代表色。这样同一屏两次调用的字母表基本稳定。
 *
 * @returns {{rows: string[], legend: Array<{letter: string, name: string, hex: string, share: number}>, letters: string[]}}
 */
export function gridArt(grid, options = {}) {
  const maxColors = Math.max(2, Math.min(16, Math.round(options.maxColors ?? 8)))
  const letters = new Array(grid.cells.length)
  const reps = []
  const LETTERS = 'ABCDEFGHIJKLMNOPQR'
  const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])
  for (let i = 0; i < grid.cells.length; i += 1) {
    const cell = grid.cells[i]
    let best = null
    let bestDist = Infinity
    for (const rep of reps) {
      const d = dist(cell, rep.rgb)
      if (d < bestDist) {
        bestDist = d
        best = rep
      }
    }
    if (best !== null && (bestDist <= 48 || reps.length >= maxColors)) {
      best.count += 1
      letters[i] = best.letter
      continue
    }
    const rep = { rgb: cell, count: 1, letter: LETTERS[reps.length] ?? '#' }
    reps.push(rep)
    letters[i] = rep.letter
  }
  /* 字母按面积重排，保证 A 是画面里最大那块，跨轮次对照读数更直观。 */
  const ranked = reps.filter((rep) => rep.count > 0).sort((a, b) => b.count - a.count)
  const remap = new Map(ranked.map((rep, index) => [rep.letter, LETTERS[index] ?? '#']))
  const legend = ranked.map((rep) => ({
    letter: remap.get(rep.letter),
    name: nameOf(rep.rgb[0], rep.rgb[1], rep.rgb[2]),
    hex: hex(rep.rgb[0], rep.rgb[1], rep.rgb[2]),
    share: +(rep.count / grid.cells.length).toFixed(3),
  }))
  const rows = []
  for (let y = 0; y < grid.rows; y += 1) {
    let line = ''
    for (let x = 0; x < grid.cols; x += 1) line += remap.get(letters[y * grid.cols + x]) ?? '#'
    rows.push(line)
  }
  return { rows, legend, letters: letters.map((letter) => remap.get(letter) ?? '#') }
}

/**
 * 同色连通块 → 区域（bbox + 占比）。
 *
 * 只做四邻域洪泛，网格本来就小（12×24 = 288 格），O(n) 无压力；
 * 递归改成显式栈，别在 288 格上试栈深度。
 */
export function regionsOf(grid, letters, options = {}) {
  const minShare = Math.max(0.002, Math.min(0.5, options.minShare ?? 0.01))
  const limit = Math.max(1, Math.min(12, options.limit ?? 4))
  const cellLetter = Array.isArray(letters) ? letters : []
  const seen = new Uint8Array(grid.cells.length)
  const found = []
  for (let start = 0; start < cellLetter.length; start += 1) {
    if (seen[start] === 1) continue
    const letter = cellLetter[start]
    const stack = [start]
    seen[start] = 1
    let x1 = Infinity
    let y1 = Infinity
    let x2 = -Infinity
    let y2 = -Infinity
    let count = 0
    while (stack.length > 0) {
      const at = stack.pop()
      const x = at % grid.cols
      const y = (at - x) / grid.cols
      count += 1
      if (x < x1) x1 = x
      if (y < y1) y1 = y
      if (x > x2) x2 = x
      if (y > y2) y2 = y
      const neighbours = [x > 0 ? at - 1 : -1, x < grid.cols - 1 ? at + 1 : -1, y > 0 ? at - grid.cols : -1, y < grid.rows - 1 ? at + grid.cols : -1]
      for (const next of neighbours) {
        if (next < 0) continue
        if (seen[next] === 1) continue
        if (cellLetter[next] !== letter) continue
        seen[next] = 1
        stack.push(next)
      }
    }
    const share = count / grid.cells.length
    if (share >= minShare) found.push({ letter, share: +share.toFixed(3), x1, y1, x2, y2, cells: count })
  }
  return found.sort((a, b) => b.share - a.share).slice(0, limit)
}

/** 两次网格的逐格差异：返回变了哪些格、变了多少（0–1 的颜色距离均值）。 */
export function diffGrid(before, after) {
  if (!before || !after || before.cols !== after.cols || before.rows !== after.rows) return null
  const changed = []
  let sum = 0
  for (let i = 0; i < after.cells.length; i += 1) {
    const a = before.cells[i]
    const b = after.cells[i]
    const d = (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / (3 * 255)
    sum += d
    if (d >= 0.08) changed.push(i)
  }
  return {
    changedCells: changed.length,
    share: +(changed.length / after.cells.length).toFixed(3),
    mean: +(sum / after.cells.length).toFixed(4),
    at: changed.slice(0, 40).map((i) => ({ x: i % after.cols, y: Math.floor(i / after.cols) })),
  }
}

/** 网格格坐标 → 设备像素矩形，方便模型直接拿它当点击目标。 */
export function cellToDevice(grid, rect, cx, cy) {
  const w = rect.w / grid.cols
  const h = rect.h / grid.rows
  return {
    x1: Math.round(rect.x + cx * w),
    y1: Math.round(rect.y + cy * h),
    x2: Math.round(rect.x + (cx + 1) * w),
    y2: Math.round(rect.y + (cy + 1) * h),
  }
}

/**
 * 找画面里真正的内容框：转屏设备上录屏帧会在上下（或左右）留黑边，按整帧采样会让内容被压扁、
 * 坐标整体缩小。整行/整列都接近黑就当黑边，返回内容格的范围（含端点）。
 * @param {{cells: Array<Array<number>>, cols: number, rows: number}} grid - `sampleGrid` 的网格。
 * @returns {{ x0: number, y0: number, x1: number, y1: number } | null} 没有黑边给 null。
 */
export function trimBars(grid) {
  const cols = Number(grid?.cols) || 0
  const rows = Number(grid?.rows) || 0
  const cells = grid?.cells
  if (cols < 2 || rows < 2 || !Array.isArray(cells) || cells.length < cols * rows) return null
  const dark = (cell) => !Array.isArray(cell) || Math.max(Number(cell[0]) || 0, Number(cell[1]) || 0, Number(cell[2]) || 0) < 40
  const rowDark = []
  for (let y = 0; y < rows; y += 1) {
    let all = true
    for (let x = 0; x < cols; x += 1) {
      if (!dark(cells[y * cols + x])) { all = false; break }
    }
    rowDark.push(all)
  }
  const colDark = []
  for (let x = 0; x < cols; x += 1) {
    let all = true
    for (let y = 0; y < rows; y += 1) {
      if (!dark(cells[y * cols + x])) { all = false; break }
    }
    colDark.push(all)
  }
  const y0 = rowDark.indexOf(false)
  const y1 = rowDark.lastIndexOf(false)
  const x0 = colDark.indexOf(false)
  const x1 = colDark.lastIndexOf(false)
  if (y0 < 0 || x0 < 0) return null
  if (y0 === 0 && x0 === 0 && y1 === rows - 1 && x1 === cols - 1) return null
  return { x0, y0, x1, y1 }
}
