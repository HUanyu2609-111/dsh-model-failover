#!/usr/bin/env bash
set -euo pipefail
runtime="${DSH_FAILOVER_RUNTIME_DIR:-$(cygpath -u "$LOCALAPPDATA")/Programs/DeepSeek Harness}"
export DSH_SDK_ANCHOR="$(cygpath -m "$runtime")/resources/app.asar/dsh/package.json"
export ELECTRON_RUN_AS_NODE=1
cd -- "$(dirname -- "$0")"
"$runtime/DeepSeek Harness.exe" --input-type=module - <<'JS'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire, registerHooks } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setImmediate } from 'node:timers/promises'

const sdk = createRequire(process.env.DSH_SDK_ANCHOR)
const pluginUrl = pathToFileURL(resolve('index.js')).href
registerHooks({ resolve(specifier, context, next) {
  return context.parentURL === pluginUrl && specifier.startsWith('@deepseek-ai/')
    ? { shortCircuit: true, url: pathToFileURL(sdk.resolve(specifier)).href }
    : next(specifier, context)
} })
const load = name => sdk('@deepseek-ai/' + name)
const { Context } = load('cordis')
const { SessionId } = load('dsh-session')
const { createUserMessage } = load('dsh-llm')
const failover = await import(pluginUrl)
const live = process.env.DSH_FAILOVER_LIVE === '1'
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const yaml = sdk('js-yaml')
const schema = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: () => null }),
])
const patch = yaml.load(readFileSync(join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'), { schema })
const config = id => patch.find(entry => entry.id === id)?.config
const { enabled, fallbackModels } = config('dsh-model-failover')
assert.ok(enabled && fallbackModels.length === 2, 'Expected two enabled fallback routes')
const { provider, model } = config('agent-default-model')
const primary = { provider, model }
const [first, second] = fallbackModels
const routes = [primary, first, second]
assert.equal(new Set(routes.map(({ provider }) => provider)).size, 3, 'Expected distinct providers')
const configuredProviders = config('llm-pi-ai').providers
const idleMs = 350
const dummyKeyRef = 'DSH_FAILOVER_PROBE_KEY'
const retryPolicy = {
  mode: 'normal', maxRetries: 5, retryableCodes: ['TIMEOUT'],
  backoff: { initialDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 },
}

function reply(res, model, text) {
  const envelope = { id: 'probe', object: 'chat.completion.chunk', model, created: 1 }
  const chunk = (delta, finish_reason) => res.write('data: ' + JSON.stringify({
    ...envelope, choices: [{ index: 0, delta, finish_reason }],
  }) + '\n\n')
  chunk({ role: 'assistant', content: text }, null)
  chunk({}, 'stop')
  res.end('data: [DONE]\n\n')
}

function texts(messages, role) {
  return messages.filter(message => message.role === role).map(({ content }) =>
    typeof content === 'string' ? content : (content ?? []).map(block => block.text ?? '').join(''))
}

async function run(firstStalls) {
  const expected = firstStalls ? second : first
  const label = firstStalls ? 'second-backup' : 'first-backup'
  const marker = 'DSH-' + randomUUID().slice(0, 8).toUpperCase()
  const initial = 'Remember this verification code for my next message: ' + marker
  const question = 'Reply with only the verification code from my previous message.'
  const checkContext = messages => ({
    earlierUser: texts(messages, 'user').includes(initial),
    earlierAssistant: texts(messages, 'assistant').includes('Code stored.'),
    promptCopies: texts(messages, 'user').filter(text => text === question).length,
  })
  const requests = []
  const liveRequests = []
  let fixtureErrors = 0
  const cleanups = []
  const server = createServer((req, res) => {
    void (async () => {
      const buffers = []
      for await (const data of req) buffers.push(data)
      const body = JSON.parse(Buffer.concat(buffers))
      const provider = req.url.split('/')[1]
      const context = checkContext(body.messages)
      const row = { provider, model: body.model, context, stall: context.promptCopies > 0 &&
        (provider === primary.provider || (firstStalls && provider === first.provider)) }
      requests.push(row)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.flushHeaders()
      if (row.stall) {
        const start = performance.now()
        res.once('close', () => { row.idleMs = Math.round(performance.now() - start) })
      } else {
        reply(res, body.model, context.promptCopies === 0 ? 'Code stored.' : context.earlierUser ? marker : 'Code missing.')
      }
    })().catch(() => { fixtureErrors++; res.destroy() })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const port = server.address().port
    const ctx = new Context()
    const mount = async (plugin, config) => {
      const fiber = ctx.plugin(plugin, config)
      cleanups.push(() => fiber.dispose())
      await fiber
    }
    ctx.provide('settings', { configure: () => () => {} })
    const synthetic = { value: 'test-only-failover-key', source: 'fixture' }
    if (live) {
      process.env[dummyKeyRef] = synthetic.value
      await mount(load('dsh-credentials-local').default, { dshHome, watch: false })
      assert.ok((await ctx.credentials.resolve(dummyKeyRef))?.value === synthetic.value, 'Expected fixture-only credential')
      const { apiKeyEnv, baseURL } = configuredProviders[expected.provider]
      const endpoint = new URL(baseURL)
      assert.ok(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password, 'Expected HTTPS provider URL')
      assert.ok(apiKeyEnv && (await ctx.credentials.describe(apiKeyEnv)).configured, 'Provider credential is unavailable')
      ctx.on('llm/stream', function (options, next) {
        if (options.provider === expected.provider) liveRequests.push({
          sessionId: options.sessionId, model: options.model, context: checkContext(options.messages),
        })
        return next()
      })
    } else {
      ctx.provide('credentials', { resolve: async () => synthetic })
    }
    for (const [plugin, config] of [
      [load('dsh-session').default],
      [load('dsh-session-projection').default],
      [load('dsh-system-prompt').default, { includeHarnessIdentity: false, includeRuntimeContext: false }],
      [load('dsh-tools').default],
      [{ ...load('dsh-tool-executor-native') }],
      [load('dsh-agent').default],
      [load('dsh-llm').default],
      [{ ...load('dsh-llm-retry') }, {}],
      [load('dsh-agent-loop').default, { agents: [] }],
      [{ ...load('dsh-llm-pi-ai') }, { providers: Object.fromEntries(routes.map(route => [route.provider,
        live && route.provider === expected.provider ? {
          ...configuredProviders[route.provider], timeoutMs: 18000, streamIdleTimeoutMs: 17000,
          retryPolicy: { mode: 'normal', maxRetries: 0 },
        } : {
          apiKeyEnv: dummyKeyRef, api: 'openai-completions',
          baseURL: `http://127.0.0.1:${port}/${route.provider}/v1`, models: [{ id: route.model }],
          streamIdleTimeoutMs: idleMs, retryPolicy,
        },
      ])) }],
      [{ ...failover }, { enabled, fallbackModels }],
    ]) await mount(plugin, config)
    const sessionId = SessionId('probe-' + label + '-' + marker.slice(4))
    const { agent, dispose } = await ctx.agents.create({ sessionId, agentOptions: { ...primary, maxTokens: 128 } })
    cleanups.push(dispose)
    const session = agent.session
    for (const text of [initial, question]) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'fixture' } }))
      for (let i = 0; i < 4; i++) { await agent.whenIdle(); await setImmediate() }
    }
    const events = session.snapshotEvents()
    const timeline = events.flatMap(event => {
      if (event.type === 'turn/end') return [`end:${event.data.reason.error?.code ?? event.data.reason.kind}`]
      if (event.type === 'model/selection') return [`switch:${event.data.provider}/${event.data.model}`]
      return []
    })
    const stalled = requests.filter(row => row.stall)
    const context = (live ? liveRequests : requests).at(-1)?.context
    const recovered = texts(session.deriveMessages(), 'assistant').at(-1)?.includes(marker) === true
    const delays = stalled.map(row => row.idleMs).filter(Number.isFinite)
    const sameSession = agent.session === session && (!live || liveRequests.every(row => row.sessionId === sessionId))
    const result = { label, live, sessionId, sameSession, timeline, context, recovered, liveRequests: liveRequests.length,
      stallCounts: Object.fromEntries(routes.map(route => [route.provider, stalled.filter(row => row.provider === route.provider).length])),
      stallCloseMs: delays.length ? [Math.min(...delays), Math.max(...delays)] : [], fixtureErrors }
    console.log(JSON.stringify(result))
    assert.deepEqual(result.stallCounts, { [primary.provider]: 6, [first.provider]: firstStalls ? 6 : 0, [second.provider]: 0 })
    assert.deepEqual(context, { earlierUser: true, earlierAssistant: true, promptCopies: 1 })
    assert.deepEqual(agent.model.current(), expected)
    assert.ok(sameSession && recovered && !fixtureErrors && timeline.at(-1) === 'end:completed')
    if (live) assert.equal(liveRequests.length, 1)
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup()
    server.closeAllConnections()
    await new Promise(done => server.close(done))
  }
}
for (const firstStalls of [false, true]) {
  try { await run(firstStalls) } catch (error) {
    const diagnostic = error.code === 'ERR_ASSERTION' ? error.message : error.code ?? error.name
    console.error(JSON.stringify({ firstStalls, live, diagnostic }))
    process.exitCode = 1
  }
}
JS
