import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { setImmediate } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

// Point to the installed rc.5 SDK if it is not available in local node_modules.
const anchor = process.env.DSH_SDK_ANCHOR
const sdk = createRequire(anchor || import.meta.url)
if (anchor) {
  registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === new URL('./index.js', import.meta.url).href && specifier.startsWith('@deepseek-ai/')) {
        return { shortCircuit: true, url: pathToFileURL(sdk.resolve(specifier)).href }
      }
      return next(specifier, context)
    },
  })
}

const { Context } = sdk('@deepseek-ai/cordis')
const { default: SessionStore, SessionId } = sdk('@deepseek-ai/dsh-session')
const { default: SessionProjections } = sdk('@deepseek-ai/dsh-session-projection')
const { default: SystemPrompt } = sdk('@deepseek-ai/dsh-system-prompt')
const { default: Tools } = sdk('@deepseek-ai/dsh-tools')
const nativeExecutor = sdk('@deepseek-ai/dsh-tool-executor-native')
const { default: Agents } = sdk('@deepseek-ai/dsh-agent')
const { default: Llm, LlmAdapter, LlmError, resolveRetryPolicy, createUserMessage } = sdk('@deepseek-ai/dsh-llm')
const retry = sdk('@deepseek-ai/dsh-llm-retry')
const { default: AgentLoop } = sdk('@deepseek-ai/dsh-agent-loop')
const failover = await import('./index.js')

const primary = { provider: 'fake-a', model: 'a' }
const backup = { provider: 'fake-b', model: 'b' }
const lastResort = { provider: 'fake-c', model: 'c' }
const efforts = [
  { id: 'custom-standard', name: 'Standard' },
  { id: 'custom-deep', name: 'Deep' },
  { id: 'custom-max', name: 'Max' },
]

function prompt(text) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'fixture' } })
}

async function fixture(t, { routes = [backup], maxRetries = 7, enabled = true, afterDelta } = {}) {
  const ctx = new Context()
  const cleanups = []
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup()
  })
  async function mount(plugin, config) {
    const fiber = ctx.plugin(plugin, config)
    cleanups.push(() => fiber.dispose())
    await fiber
  }
  ctx.provide('settings', { configure: () => () => {} })
  await mount(SessionStore)
  await mount(SessionProjections)
  await mount(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
  await mount(Tools)
  await mount({ ...nativeExecutor })
  await mount(Agents)
  await mount(Llm)
  await mount({ ...retry }, {})
  await mount(AgentLoop, { agents: [] })
  await mount({ ...failover }, { enabled, fallbackModels: routes })

  const requests = []
  const failures = new Map()
  class FakeAdapter extends LlmAdapter {
    providerRetryPolicy() {
      return resolveRetryPolicy({
        mode: 'normal', maxRetries, retryableCodes: ['TIMEOUT'],
        backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      }, 'fixture.retryPolicy')
    }
    async listModels(provider) {
      const route = [primary, backup, lastResort].find(model => model.provider === provider)
      return route ? [{ provider, id: route.model, name: route.model }] : []
    }
    async resolveModel(provider, model, signal) {
      const info = await super.resolveModel(provider, model, signal)
      const defaultEffort = provider === primary.provider ? 'custom-standard' : 'custom-deep'
      return { ...info, reasoning: { efforts, defaultEffort } }
    }
    async *stream(request) {
      requests.push(request)
      if (failures.has(request.provider)) throw new LlmError('fixture failure', failures.get(request.provider))
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'fixture answer' }
      const outcome = await afterDelta?.(request)
      if (outcome) {
        yield { type: 'finish', reason: outcome }
        return
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fixture answer' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const providers = [...new Set([primary.provider, ...routes.map(route => route.provider)])]
  const unregister = ctx.llm.registerAdapter(providers, new FakeAdapter())
  cleanups.push(unregister)
  const { agent, dispose } = await ctx.agents.create({
    sessionId: SessionId('failover-fixture'), agentOptions: primary,
  })
  cleanups.push(dispose)
  return { agent, requests, failPrimary: (code = 'TIMEOUT') => failures.set(primary.provider, code),
    failProvider: (provider, code = 'TIMEOUT') => failures.set(provider, code) }
}

async function sendAndSettle(agent, text) {
  agent.followup(prompt(text))
  await agent.whenIdle()
  await setImmediate()
  await agent.whenIdle()
}

test('sixth TIMEOUT resumes the failed prompt and history on the backup in the same Session', { timeout: 5000 }, async t => {
  const { agent, requests, failPrimary } = await fixture(t)
  const session = agent.session
  await sendAndSettle(agent, 'Earlier instruction')
  failPrimary()
  await sendAndSettle(agent, 'Original prompt')

  assert.deepEqual(requests.map(r => r.provider), [...Array(7).fill(primary.provider), backup.provider])
  assert.equal(session.snapshotEvents().filter(e => e.type === 'llm/retry').length, 5)
  assert.equal(requests.at(-1).model, backup.model)
  assert.equal(requests[0].reasoningEffort, 'custom-standard')
  assert.equal(requests.at(-1).reasoningEffort, 'custom-deep')
  assert.equal(agent.model.current().reasoningEffort, undefined)
  const history = requests.at(-1).messages.flatMap(m => m.content.map(block => block.text))
  assert.ok(history.includes('Earlier instruction'))
  assert.ok(history.includes('fixture answer'))
  assert.equal(history.filter(text => text === 'Original prompt').length, 1)
  assert.match(history.at(-1), /^上一轮模型请求中断，已切换备用模型。.*继续完成原任务/)
  assert.equal(agent.session, session)
  const events = session.snapshotEvents()
  const timeout = events.findIndex(e => e.type === 'turn/end' && e.data.reason.error?.code === 'TIMEOUT')
  const switchModel = events.findIndex(e => e.type === 'model/selection')
  assert.ok(timeout >= 0 && switchModel > timeout, 'failed turn must close before switching')
})

test('five TIMEOUT failures do not switch the model', { timeout: 5000 }, async t => {
  const { agent, requests, failPrimary } = await fixture(t, { maxRetries: 4 })
  failPrimary()
  await sendAndSettle(agent, 'Stop after five failures')
  assert.equal(requests.length, 5)
  assert.ok(requests.every(request => request.provider === primary.provider))
  assert.equal(agent.model.current().provider, primary.provider)
})

test('unavailable configured models leave the native retry policy in control', { timeout: 5000 }, async t => {
  const { agent, requests, failPrimary } = await fixture(t, { routes: [{ provider: 'missing', model: 'x' }] })
  failPrimary()
  await sendAndSettle(agent, 'No route is available')
  assert.equal(requests.length, 8)
  assert.ok(requests.every(request => request.provider === primary.provider))
  assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry').length, 7)
  assert.equal(agent.model.current().provider, primary.provider)
})

test('QUOTA skips a route with a stale effort and applies the next route’s configured effort', { timeout: 5000 }, async t => {
  const stale = { ...lastResort, reasoningEffort: 'removed' }
  const chosen = { ...backup, reasoningEffort: 'custom-max' }
  const { agent, requests, failPrimary } = await fixture(t, { routes: [stale, chosen] })
  const session = agent.session
  failPrimary('QUOTA')
  await sendAndSettle(agent, 'Continue after insufficient balance')

  assert.deepEqual(requests.map(request => request.provider), [primary.provider, backup.provider])
  assert.equal(agent.session, session)
  assert.equal(requests[1].reasoningEffort, chosen.reasoningEffort)
  assert.deepEqual(agent.model.current(), chosen)
  const events = session.snapshotEvents()
  const failure = events.findIndex(e => e.type === 'turn/end' && e.data.reason.error?.code === 'QUOTA')
  const switchModel = events.findIndex(e => e.type === 'model/selection')
  assert.ok(failure >= 0 && switchModel > failure)
})

test('an interrupted stream passes its partial answer and a continuation prompt to the backup', { timeout: 5000 }, async t => {
  const { agent, requests } = await fixture(t, { afterDelta: ({ provider }) => provider === primary.provider
    ? { kind: 'error', failure: { code: 'TRANSPORT', message: 'Upstream response stream was interrupted' } }
    : undefined })
  const text = 'Continue after the stream disconnects'
  await sendAndSettle(agent, text)

  assert.deepEqual(requests.map(r => r.provider), [primary.provider, backup.provider])
  const messages = requests[1].messages
  assert.equal(messages.flatMap(m => m.content.map(block => block.text)).filter(value => value === text).length, 1)
  const continuation = messages.at(-1)
  assert.equal(continuation.role, 'user')
  assert.match(continuation.content.map(block => block.text).join('\n'), /fixture answer[\s\S]*继续完成/)
  assert.ok(messages.every(message => message.role !== 'assistant'))
  const events = agent.session.snapshotEvents()
  assert.ok(events.some(e => e.type === 'assistant/attempt'))
  assert.equal(events.filter(e => e.type === 'assistant/message').length, 1)
})

test('manually stopping an in-flight stream never starts a backup', { timeout: 5000 }, async t => {
  const { agent, requests } = await fixture(t, { afterDelta: () => { agent.cancel({ kind: 'user' }) } })
  await sendAndSettle(agent, 'Stop while streaming')

  assert.deepEqual(requests.map(r => r.provider), [primary.provider])
  assert.equal(agent.model.current().provider, primary.provider)
  assert.ok(agent.session.snapshotEvents().some(e => e.type === 'turn/end' && e.data.reason.kind === 'aborted'))
})

test('a timed-out backup advances once without cycling to a used route', { timeout: 5000 }, async t => {
  const routes = [primary, backup, lastResort]
  const { agent, requests, failPrimary, failProvider } = await fixture(t, { routes, maxRetries: 0 })
  failPrimary()
  failProvider(backup.provider)
  failProvider(lastResort.provider)
  for (let i = 0; i < 6; i++) await sendAndSettle(agent, 'Primary timeout ' + i)
  assert.equal(requests.at(-1).provider, backup.provider)

  // The automatic continuation already made the first attempt on each backup.
  for (let i = 0; i < 5; i++) await sendAndSettle(agent, 'Backup timeout ' + i)
  assert.equal(requests.at(-1).provider, lastResort.provider)

  for (let i = 0; i < 5; i++) await sendAndSettle(agent, 'Last route timeout ' + i)
  assert.deepEqual(requests.map(request => request.provider),
    [primary, backup, lastResort].flatMap(route => Array(6).fill(route.provider)))
  assert.equal(agent.model.current().provider, lastResort.provider)
})

