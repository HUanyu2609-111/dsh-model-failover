import z from '@deepseek-ai/schemastery'
import { createUserMessage, joinAssistantStreamText } from '@deepseek-ai/dsh-llm'

const TIMEOUT_LIMIT = 6
const INPUT_REPAIR_CODES = new Set(['CONTEXT_WINDOW_EXCEEDED', 'IMAGE_OFFLOAD_REQUIRED'])

export const name = 'dsh-model-failover'
export const inject = ['llm', 'settings']

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  fallbackModels: z.array(z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: z.string().min(1),
  })).default([]).volatile(),
})

function sameSelection(a, b) {
  return !!a && a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort
}

function interruptedReply(session, turn) {
  for (let seq = session.seq - 1; seq >= session.firstLiveSeq; seq--) {
    const event = session.eventAt(seq)
    if (event.type === 'turn/start' || event.type === 'assistant/message') break
    if (event.type !== 'assistant/attempt' || event.data.turn !== turn) continue
    const text = joinAssistantStreamText(event.data.stream)
    if (text.trim()) return text
  }
  return ''
}

export function apply(ctx, config) {
  const logger = ctx.logger('model-failover')
  const states = new WeakMap()
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  ctx.settings.configure({ auto: false })

  async function findFallback(state, signal) {
    const catalogs = new Map()
    for (const candidate of config.fallbackModels.get()) {
      if (signal.aborted) return
      if (state.attemptedProviders.has(candidate.provider)) continue
      try {
        if (!catalogs.has(candidate.provider)) {
          catalogs.set(candidate.provider, ctx.llm.listModels(candidate.provider))
        }
        const models = await catalogs.get(candidate.provider)
        if (signal.aborted) return
        if (!models.some(model => model.id === candidate.model)) continue
        // Validate the configured effort, keeping omitted defaults implicit in the Session selection.
        await ctx.llm.resolveCallConfig(candidate, signal)
        if (!signal.aborted) return candidate
      } catch (error) {
        if (!signal.aborted) logger.debug('Unavailable fallback %s/%s: %s', candidate.provider, candidate.model, error.message)
      }
    }
  }

  function canResume(agent, state, pending) {
    return !lifetime.signal.aborted && !pending.signal.aborted
      && states.get(agent.session) === state && state.pending === pending
      && config.enabled.get() && config.fallbackModels.get().some(route => sameSelection(route, pending.fallback))
      && sameSelection(agent.model.current(), state.route)
      && agent.inbox.nextTurn.length === 0 && agent.inbox.nextStep.length === 0
  }

  async function resumeAfterIdle(agent, state, pending) {
    try {
      await agent.whenIdle()
      if (agent.status !== 'idle' || !canResume(agent, state, pending)) return
      // Failed attempts are log-only. Quote visible text as a draft in the handoff.
      const draft = interruptedReply(agent.session, pending.turn)
      const instruction = '上一轮模型请求中断，已切换备用模型。请根据会话历史和已有进度继续完成原任务。已完成的步骤无需重复，结果不确定的操作请先核实。'
      const text = draft
        ? `以下是中断前已输出的回复草稿，仅作为上下文参考：\n${JSON.stringify(draft)}\n\n${instruction}`
        : instruction
      const continuation = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'retry' } })
      const { route } = state
      state.switchingTo = pending.fallback
      agent.model.select(pending.fallback)
      agent.followup(continuation)
      logger.info('Session %s switched from %s/%s to %s/%s after model request failure %s',
        agent.id, route.provider, route.model,
        pending.fallback.provider, pending.fallback.model, pending.failureCode)
    } catch (error) {
      logger.warn('Could not continue Session %s after model request failure: %s', agent.id, error.message)
    } finally {
      delete state.switchingTo
      if (state.pending === pending) delete state.pending
    }
  }

  ctx.on('session/event', (session, event) => {
    const state = states.get(session)
    if (!state) return
    if (event.type === 'assistant/message') {
      states.delete(session)
    } else if (event.type === 'model/selection') {
      if (state.switchingTo && sameSelection(state.switchingTo, event.data)) {
        state.route = state.switchingTo
        state.timeouts = 0
        state.attemptedProviders.add(event.data.provider)
        delete state.switchingTo
      } else {
        states.delete(session)
      }
    } else if (event.type === 'turn/start') {
      delete state.pending
    } else if (event.type === 'turn/end') {
      const { turn, reason } = event.data
      if (reason.kind !== 'error' || reason.error.code === 'ABORTED') {
        states.delete(session)
      } else if (state.pending?.turn === turn && state.pending.failureCode === reason.error.code) {
        void resumeAfterIdle(state.pending.agent, state, state.pending)
      }
    }
  })

  ctx.on('agent/disposed', ({ agent }) => { states.delete(agent.session) })

  ctx.on('agent/request-error', async ({ agent, turn, provider, failure, signal }, next) => {
    const session = agent.session
    const { code } = failure
    if (!config.enabled.get() || signal.aborted || code === 'ABORTED') {
      states.delete(session)
      return next()
    }
    // Compare the prepared request's explicit selection so a manual change
    // takes precedence, including an effort-only change on the same model.
    const header = session.requestHeader()
    if (header?.config.provider !== provider) return next()
    const route = {
      provider,
      model: header.config.model,
      reasoningEffort: header.adapterDefaults?.reasoningEffort ? undefined : header.config.reasoningEffort,
    }
    if (!sameSelection(agent.model.current(), route)) return next()

    let state = states.get(session)
    if (!state || !sameSelection(state.route, route)) {
      state = { route, timeouts: 0, attemptedProviders: new Set([provider]) }
      states.set(session, state)
    }
    state.timeouts = code === 'TIMEOUT' ? state.timeouts + 1 : 0
    if (code === 'TIMEOUT' && state.timeouts < TIMEOUT_LIMIT) return next()

    // Give DSH's context and image repair handlers priority for these errors.
    const triedRepair = INPUT_REPAIR_CODES.has(code)
    if (triedRepair) {
      const action = await next()
      if (action) return action
    }
    const delegate = () => triedRepair ? undefined : next()
    if (agent.inbox.nextTurn.length || agent.inbox.nextStep.length) return delegate()

    const fallback = await findFallback(state, AbortSignal.any([signal, lifetime.signal]))
    if (!fallback) return delegate()
    const pending = { agent, fallback, turn, signal, failureCode: code }
    state.pending = pending
    if (!canResume(agent, state, pending)) {
      delete state.pending
      return delegate()
    }
    // Native retries reuse the pinned route. Switch only after this failure
    // closes the turn, so the continuation can reuse the committed history.
    return undefined
  }, { prepend: true })
}
