/**
 * 工具定义静态体检：用假 ctx 真跑一遍 apply，把 24 个工具定义全收上来再逐条查。
 * 宿主对 schema 不做兜底 —— 少写 required 的字段、名字撞车、render 漏挂，
 * 表现都是「工具调不动」，而不是启动报错，所以必须在这里拦住。
 */
import { apply, __internals } from '../index.js'

let pass = 0
const failures = []

async function it(label, body) {
  try {
    await body()
    pass += 1
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failures.push({ label, error })
    console.log(`  ❌ ${label}`)
    console.log(`     ${String(error?.message ?? error).split('\n').join('\n     ')}`)
  }
}

function expect(ok, message) {
  if (!ok) throw new Error(message)
}

/* 假 ctx：只认 tools.register / effect / logger，其余一律返回可调用的桩。 */
const stub = () => stub
const tools = []
const ctx = new Proxy({}, {
  get: (_target, key) => {
    if (key === 'tools') return { register: (def) => { tools.push(def); return () => {} } }
    if (key === 'effect') return (fn) => { fn(); return () => {} }
    if (key === 'logger') return () => {}
    return stub
  },
})
apply(ctx, {})

const EXPECTED = [
  'adb_ui', 'adb_wait', 'adb_tap', 'adb_gesture', 'adb_input', 'adb_app', 'adb_sh',
  'adb_scroll_to', 'adb_do', 'adb_anim', 'adb_find', 'adb_window', 'adb_watch', 'adb_proc',
  'adb_crash', 'adb_events', 'adb_web', 'adb_action', 'adb_shot', 'adb_recent', 'adb_motion',
  'adb_state', 'adb_device', 'adb_mirror',
  'adb_file',
  'adb_pinch',
]

/** 递归查 schema：类型得认识、required 得真在 properties 里、不许有 undefined 描述。 */
function auditSchema(schema, path, problems) {
  expect(schema !== null && typeof schema === 'object', `${path} 不是对象`)
  expect(Array.isArray(schema) === false, `${path} 是数组`)
  const known = ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  for (const type of types) {
    expect(type === undefined || known.includes(type), `${path} 的 type 是 ${String(type)}`)
  }
  /* 联合类型只允许带 null 的那种写法，别写成两个真类型糊一起。 */
  expect(types.length <= 2 && (types.length === 1 || types.includes('null')), `${path} 的 type 联合了 ${types.join('+')}`)
  const type = types.find((item) => item !== 'null')
  if (type === 'object') {
    expect(schema.properties === undefined || typeof schema.properties === 'object', `${path}.properties 不是对象`)
    const props = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      expect(Object.prototype.hasOwnProperty.call(props, key), `${path}.required 里的 ${key} 没在 properties 里`)
    }
    for (const [key, child] of Object.entries(props)) auditSchema(child, `${path}.${key}`, problems)
  }
  if (type === 'array') {
    expect(schema.items !== undefined, `${path} 是数组但没写 items`)
    if (schema.items !== undefined) auditSchema(schema.items, `${path}[]`, problems)
  }
  for (const [key, value] of Object.entries(schema)) {
    expect(value !== undefined, `${path}.${key} 是 undefined`)
  }
}

/** 按 schema 造最小样本：够 render 跑通就行。 */
function sampleOf(schema) {
  const types = Array.isArray(schema?.type) ? schema.type.filter((item) => item !== 'null') : [schema?.type]
  const type = types[0]
  if (type === 'string') return 'x'
  if (type === 'integer' || type === 'number') return 0
  if (type === 'boolean') return true
  if (type === 'array') return []
  if (type === 'object') {
    const value = {}
    for (const [key, child] of Object.entries(schema.properties ?? {})) value[key] = sampleOf(child)
    return value
  }
  return null
}

await it('24 个工具全部注册成功，名字唯一且都以 adb_ 开头', () => {
  expect(tools.length === EXPECTED.length, `注册了 ${tools.length} 个，应为 ${EXPECTED.length}`)
  const names = tools.map((tool) => tool.name)
  for (const name of EXPECTED) expect(names.includes(name), `少了 ${name}`)
  expect(new Set(names).size === names.length, '有重名工具')
  for (const name of names) expect(/^adb_[a-z_]+$/.test(name), `${name} 不符合 adb_ 命名`)
})

await it('每个工具都有非空说明、合法入参 schema、可渲染输出', () => {
  for (const tool of tools) {
    expect(typeof tool.description === 'string' && tool.description.trim().length >= 12, `${tool.name} 说明太短`)
    expect(tool.parameters !== null && typeof tool.parameters === 'object', `${tool.name} 没有 parameters`)
    const problems = []
    auditSchema(tool.parameters, `${tool.name}.parameters`, problems)
    expect(problems.length === 0, problems.join('；'))
    expect(typeof tool.execute === 'function', `${tool.name} 没有 execute`)
    expect(tool.output !== null && typeof tool.output === 'object', `${tool.name} 没有 output`)
    auditSchema(tool.output.schema, `${tool.name}.output`, [])
    expect(typeof tool.output.render === 'function', `${tool.name}.output.render 不是函数`)
    /* 用 schema 造一份最小样本再渲染：真跑一遍 render 才查得出漏字段的取值。 */
    const rendered = tool.output.render({}, sampleOf(tool.output.schema))
    expect(rendered !== undefined && rendered !== null, `${tool.name} 的 render 什么都没返回`)
  }
})

await it('入参都声明了 additionalProperties=false，未知参数会被宿主挡下', () => {
  for (const tool of tools) {
    expect(tool.parameters.additionalProperties === false, `${tool.name} 没声明 additionalProperties=false`)
  }
})

await it('工具说明里提到的参数名都真实存在（避免文档漂移）', () => {
  const missing = []
  for (const tool of tools) {
    const props = Object.keys(tool.parameters.properties ?? {})
    for (const m of tool.description.matchAll(/`([a-z][a-z0-9_]*)`/g)) {
      const word = m[1]
      if (props.includes(word)) continue
      if (/^(adb|com|android|sqlite|scrcpy|uiautomator)/.test(word)) continue
      missing.push(`${tool.name}: ${word}`)
    }
  }
  expect(missing.length === 0, missing.join('、'))
})

await it('内部导出面齐全：失败取证 / XPath / 控件截图', () => {
  for (const key of ['failureSuffix', 'annotateFailure', 'selectXPath', 'elementRegion', 'screenshot', 'nodeForRef']) {
    expect(__internals[key] !== undefined, `__internals 少了 ${key}`)
  }
})

console.log(`\n${pass} 项通过\n`)
process.exit(failures.length === 0 ? 0 : 1)
