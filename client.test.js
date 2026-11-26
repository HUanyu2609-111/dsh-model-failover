import assert from 'node:assert/strict'
import { test } from 'node:test'

const registrations = []
const state = []
let hook = 0
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useCallback: callback => callback,
  useEffect: effect => { effect() },
  useRef: initial => {
    const index = hook++
    return state[index] ?? (state[index] = { current: initial })
  },
  useState: initial => {
    const index = hook++
    if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial
    return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value }]
  },
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

globalThis.window = { __ModuleLoader__: { load({ id, factory }) {
  assert.equal(id, 'dsh-model-failover')
  const plugin = factory(name => {
    assert.equal(name, 'react')
    return React
  })
  registrations.push(plugin)
} } }
await import('./client.js')

function render(Component, props) {
  hook = 0
  return Component(props)
}

function find(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) { const result = find(child, predicate); if (result) return result }
    return undefined
  }
  if (!node || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  return find(node.children, predicate)
}

test('settings page displays native effort options and saves the chosen effort with its route', async t => {
  const plugin = registrations[0]
  const saved = []
  const listeners = new Set()
  const snapshot = { status: 'ready', value: { enabled: true, fallbackModels: [] }, revision: 4, writable: true }
  const ctx = {
    configForms: {
      get: id => { assert.equal(id, 'dsh-model-failover'); return {
        getSnapshot: () => snapshot,
        subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
        mutate: async (operations, revision) => { saved.push({ operations, revision }); return true },
      } },
      whileServed: (ids, callback) => { assert.deepEqual(ids, ['dsh-model-failover']); callback(); return () => {} },
    },
    remote: {
      session: { modelCatalog: async () => ({ ok: true, value: { groups: [
        { id: 'other-provider', name: 'Other Provider', models: [{ id: 'model-b', name: 'Model B', reasoning: {
          defaultEffort: 'standard-tier',
          efforts: [{ id: 'standard-tier', name: 'Standard' }, { id: 'deep-tier', name: 'Deep' }],
        } }] },
      ], failures: [] } }) },
      $on: () => () => {},
    },
    slots: { inject: (_name, callback) => { callback(); return () => {} }, register: (entry, Page) => { ctx.entry = entry; ctx.Page = Page; return () => {} } },
    on: () => () => {},
    effect: effect => effect(),
  }
  plugin.apply(ctx)
  t.after(() => { for (const listener of listeners) listener() })
  const props = ctx.entry.inject()
  let tree = render(ctx.Page, props)
  await new Promise(resolve => setImmediate(resolve))
  tree = render(ctx.Page, props)
  const select = find(tree, node => node.type === 'select')
  assert.ok(select, 'model picker should render')
  select.props.onChange({ currentTarget: { value: JSON.stringify(['other-provider', 'model-b']) } })
  tree = render(ctx.Page, props)
  const route = { provider: 'other-provider', model: 'model-b' }
  const picker = () => find(tree, node => node.type === 'select' && node.props['aria-label'] === '推理等级 Other Provider · Model B')
  const save = () => find(tree, node => node.type === 'button' && node.children.includes('保存')).props.onClick()
  assert.deepEqual(picker().children.filter(node => node?.type === 'option').map(node => [node.props.value, node.children[0]]), [
    ['', '跟随模型默认（Standard）'], ['standard-tier', 'Standard'], ['deep-tier', 'Deep'],
  ])
  assert.equal(picker().props.value, '')
  picker().props.onChange({ currentTarget: { value: 'deep-tier' } })
  tree = render(ctx.Page, props)
  assert.equal(picker().props.value, 'deep-tier')
  await save()
  assert.equal(saved.length, 1)
  assert.equal(saved[0].revision, 4)
  assert.deepEqual(saved[0].operations[1], {
    op: 'set', path: ['fallbackModels'], value: [{ ...route, reasoningEffort: 'deep-tier' }],
  })

  snapshot.value.fallbackModels = saved[0].operations[1].value
  snapshot.revision++
  tree = render(ctx.Page, props)
  assert.equal(picker().props.value, 'deep-tier')
  picker().props.onChange({ currentTarget: { value: '' } })
  tree = render(ctx.Page, props)
  await save()
  assert.equal(saved[1].revision, 5)
  assert.deepEqual(saved[1].operations[1].value, [route])
})
