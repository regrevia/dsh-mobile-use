/**
 * 回归：清理路径不允许把异常抛出到 host 顶层。
 *
 * 背景（2026-10-27，两次 host 退出码 1）：空闲回收定时器回调调了不存在的
 * `this.killStale()`，`stop()` 里又直接调 `closeRemuxer()`，于是未捕获的
 * TypeError 直接把整个 DSH 打崩。这里固定三件事：
 *   1. guardCall 吞掉回调里的任何异常，连写日志失败也不能再抛；
 *   2. stop() 幂等，重复调用不抛；
 *   3. 清理方法缺失 / 对象已销毁（字段为 undefined）时 stop() 仍然不抛。
 */

import { guardCall, LiveStream } from '../stream.js'

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    pass += 1
    console.log(`  ✅ ${name}`)
  } catch (error) {
    fail += 1
    console.log(`  ❌ ${name}: ${error?.message ?? error}`)
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}

console.log('=== 清理路径兜底 ===')

check('guardCall 吞掉 TypeError 并记一条日志', () => {
  const lines = []
  const ok = guardCall((note) => lines.push(note), 'idle-stop', () => {
    throw new TypeError('this.killStale is not a function')
  })
  assert(ok === false, '应该返回 false')
  assert(lines.length === 1, `应该记 1 条日志，实际 ${lines.length}`)
  assert(lines[0].includes('idle-stop'), '日志要带路径')
  assert(lines[0].includes('killStale'), '日志要带原始错误')
})

check('写日志本身抛错也不会冒出去（对象已销毁）', () => {
  let threw = false
  try {
    guardCall(() => {
      throw new Error('debug 已失效')
    }, 'recorder-exit', () => {
      throw new Error('原错误')
    })
  } catch {
    threw = true
  }
  assert(threw === false, 'guardCall 不得抛出')
})

check('log 未注入（undefined）也不抛', () => {
  assert(guardCall(undefined, 'restart', () => {
    throw new Error('boom')
  }) === false, '应该返回 false')
})

/** 造一个只够 stop() 用的实例，字段可被覆盖成「缺失」。 */
function fakeStream(overrides = {}) {
  const s = Object.create(LiveStream.prototype)
  Object.assign(s, {
    generation: 3,
    idleTimer: null,
    restartTimer: null,
    stopping: false,
    recorder: null,
    intentional: false,
    init: { moov: true },
    lastKeyChunks: [{ a: 1 }],
    lastKeyBytes: 9,
    waiting: new Map([['k', 1]]),
    config: { codec: 'avc1' },
    firstFrameAt: 42,
    serial: 'test',
    sessions: 0,
    clients: new Map(),
    error: '',
    notes: [],
    debug(note) {
      this.notes.push(note)
    },
    closeRemuxer() {},
    closeJpeg() {},
    killOwnRecorder() {},
  }, overrides)
  return s
}

check('stop() 幂等：连调两次不抛，gen 递增两次', () => {
  const s = fakeStream()
  s.stop()
  s.stop()
  assert(s.generation === 5, `generation 应为 5，实际 ${s.generation}`)
  assert(s.recorder === null, 'recorder 应为空')
  assert(s.init === null, 'init 应清空')
  assert(s.waiting.size === 0, 'waiting 应清空')
  assert(s.lastKeyBytes === 0 && s.lastKeyChunks.length === 0, 'GOP 缓存应清空')
})

check('清理方法没注入（历史 killStale 事故形状）不抛', () => {
  const s = fakeStream({ closeRemuxer: undefined, closeJpeg: undefined, killOwnRecorder: undefined })
  let threw = false
  try {
    s.stop()
  } catch {
    threw = true
  }
  assert(threw === false, 'stop() 不得抛出')
  assert(s.notes.length >= 3, `三条清理路径都应记日志，实际 ${s.notes.length}`)
  assert(s.notes.join('|').includes('TypeError'), '日志里要留下真实错误')
})

check('对象已销毁（字段缺失）不抛', () => {
  const s = fakeStream({ waiting: undefined, init: undefined, lastKeyChunks: undefined, debug: undefined })
  let threw = false
  try {
    s.stop()
    s.stop()
  } catch {
    threw = true
  }
  assert(threw === false, '已销毁对象上 stop() 不得抛出')
})

check('定时器回调里调缺失方法：包一层 guard 就不崩', () => {
  const s = fakeStream({ killStale: undefined })
  const timers = []
  const original = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms) => {
    timers.push({ fn, ms })
    return 1
  }
  try {
    globalThis.setTimeout(() => s.guard('idle-stop', () => s.killStale()), 10)
  } finally {
    globalThis.setTimeout = original
  }
  assert(timers.length === 1, '应登记 1 个定时器')
  let threw = false
  try {
    timers[0].fn()
  } catch {
    threw = true
  }
  assert(threw === false, '定时器回调不得把异常抛给 host')
  assert(s.notes.some((n) => n.includes('idle-stop')), '应记下 idle-stop')
})

check('stop() 之后的迟到回调不会复活（generation 已换代）', () => {
  const s = fakeStream()
  s.stop()
  const gen = s.generation
  assert(gen > 3, 'stop() 必须换代')
  assert(s.intentional === true, 'intentional 置位')
  assert(s.stopping === false, 'stopping 复位')
})

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
if (fail > 0) {
  console.log('=== 未通过 ===')
  process.exit(1)
}
console.log('=== 全部通过 ===')
