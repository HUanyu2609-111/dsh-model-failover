window.__ModuleLoader__.load({
  id: 'dsh-model-failover',
  factory(require) {
    const { createElement: h, useCallback, useEffect, useRef, useState, useSyncExternalStore } = require('react')
    const id = 'dsh-model-failover'
    const title = '模型故障切换'
    const stack = { display: 'grid', gap: 12 }
    const row = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }
    const control = {
      font: 'inherit', color: 'inherit', padding: '5px 10px', borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l3, #888)',
      background: 'var(--dsw-alias-settings-card-fill, Canvas)',
    }
    const keyOf = ({ provider, model }) => JSON.stringify([provider, model])

    function button(label, onClick, disabled = false, accessibleLabel) {
      return h('button', { type: 'button', onClick, disabled, 'aria-label': accessibleLabel, style: control }, label)
    }

    function effortPicker(label, route, item, editable, onChange) {
      const reasoning = item?.reasoning
      const efforts = reasoning?.efforts ?? []
      const defaultEffort = efforts.find(effort => effort.id === reasoning?.defaultEffort)
      const saved = route.reasoningEffort ?? ''
      const unavailable = saved && !efforts.some(effort => effort.id === saved)
      const defaultLabel = defaultEffort ? '跟随模型默认（' + defaultEffort.name + '）' : '跟随模型默认'
      return h('label', { style: row }, '推理等级',
        h('select', { value: saved, style: control, 'aria-label': '推理等级 ' + label,
          disabled: !editable || !item || (!efforts.length && !saved),
          onChange: event => onChange(event.currentTarget.value) },
        h('option', { value: '' }, item && !efforts.length && !saved ? '无可选等级' : defaultLabel),
        ...efforts.map(effort => h('option', { key: effort.id, value: effort.id }, effort.name)),
        unavailable && h('option', { value: saved, disabled: true }, saved + (item ? '（已失效）' : '（未验证）'))))
    }

    function useCatalog(load, watch) {
      const [catalog, setCatalog] = useState({ status: 'loading', groups: [], failures: [] })
      const refresh = useRef(() => {})
      useEffect(() => {
        let version = 0
        let active = true
        async function reload() {
          const request = ++version
          setCatalog(previous => ({ ...previous, status: 'loading' }))
          try {
            const result = await load()
            if (!active || request !== version) return
            if (!result.ok) throw new Error('Catalog unavailable')
            setCatalog({ status: 'ready', groups: result.value.groups, failures: result.value.failures })
          } catch {
            if (active && request === version) setCatalog(previous => ({ ...previous, status: 'error' }))
          }
        }
        refresh.current = reload
        const stop = watch(reload)
        void reload()
        return () => {
          active = false
          refresh.current = () => {}
          stop()
        }
      }, [load, watch])
      return [catalog, () => refresh.current()]
    }

    function ModelFailoverPage({ form, loadCatalog, watchCatalog }) {
      const snapshot = useSyncExternalStore(
        useCallback(listener => form.subscribe(listener), [form]),
        useCallback(() => form.getSnapshot(), [form]),
      )
      const [catalog, refreshCatalog] = useCatalog(loadCatalog, watchCatalog)
      const [draft, setDraft] = useState(null)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      if (snapshot.status !== 'ready' || !snapshot.value) {
        return h('p', { role: 'status' }, snapshot.status === 'loading' ? '正在读取设置…' : '当前连接无法读取插件设置。')
      }

      const value = draft?.value ?? snapshot.value
      const routes = value.fallbackModels
      const changed = draft !== null && draft.revision !== snapshot.revision
      const editable = snapshot.writable && typeof snapshot.revision === 'number' && !busy && !changed
      const selected = new Set(routes.map(keyOf))
      const models = new Map()
      const groups = catalog.groups.map(group => {
        const options = group.models.map(model => {
          const route = { provider: group.id, model: model.id }
          const key = keyOf(route)
          models.set(key, { route, label: group.name + ' · ' + (model.name || model.id), reasoning: model.reasoning })
          return { key, label: model.name || model.id }
        }).filter(option => !selected.has(option.key))
        return { ...group, options }
      }).filter(group => group.options.length > 0)

      function edit(patch) {
        setNotice('')
        setDraft({ revision: draft?.revision ?? snapshot.revision, value: { ...value, ...patch } })
      }

      function setEffort(index, reasoningEffort) {
        const next = routes.slice()
        const { provider, model } = next[index]
        next[index] = reasoningEffort ? { provider, model, reasoningEffort } : { provider, model }
        edit({ fallbackModels: next })
      }

      function move(index, offset) {
        const reordered = routes.slice()
        const [route] = reordered.splice(index, 1)
        reordered.splice(index + offset, 0, route)
        edit({ fallbackModels: reordered })
      }

      async function save() {
        if (!draft || !editable) return
        setBusy(true)
        setNotice('')
        try {
          const saved = await form.mutate([
            { op: 'set', path: ['enabled'], value: value.enabled },
            { op: 'set', path: ['fallbackModels'], value: routes },
          ], draft.revision)
          if (saved) setDraft(null)
          setNotice(saved ? '已保存。' : '保存失败。请检查设置是否更新后再试。')
        } catch {
          setNotice('无法保存。请在连接恢复后重试。')
        } finally {
          setBusy(false)
        }
      }

      return h('section', { 'aria-label': title, style: { ...stack, maxWidth: 720 } },
        h('p', { style: { margin: 0 } }, '连续超时 6 次，或模型请求因余额不足、上游断流等其他原因失败时，会按下列顺序切换到其他服务商的备用模型。手动停止不会触发切换。接续时，会话上下文会发送给选中的服务商。'),
        h('label', { style: row },
          h('input', { type: 'checkbox', checked: value.enabled, disabled: !editable,
            onChange: event => edit({ enabled: event.currentTarget.checked }) }), '启用自动切换'),
        h('div', { style: row },
          h('select', { value: '', style: control, 'aria-label': '添加备用模型',
            disabled: !editable || catalog.status !== 'ready' || groups.length === 0,
            onChange(event) {
              const option = models.get(event.currentTarget.value)
              if (option) edit({ fallbackModels: [...routes, option.route] })
            } },
          h('option', { value: '', disabled: true }, '添加备用模型…'),
          ...groups.map(group => h('optgroup', { key: group.id, label: group.name },
            ...group.options.map(option => h('option', { key: option.key, value: option.key }, option.label))))),
          button('刷新模型', refreshCatalog, catalog.status === 'loading')),
        catalog.status === 'loading' && h('p', { role: 'status' }, '正在读取模型目录…'),
        catalog.status === 'error' && h('p', { role: 'status' }, '模型目录暂不可用。可以刷新目录或编辑已选模型。'),
        catalog.status === 'ready' && catalog.failures.length > 0 && h('p', { role: 'status' }, '部分服务商的模型目录暂不可用。'),
        catalog.status === 'ready' && catalog.groups.length === 0 && h('p', null, '当前目录没有可选模型。请先在「模型」中配置服务商。'),
        routes.length === 0
          ? h('p', null, '尚未添加备用模型。')
          : h('ol', { 'aria-label': '备用模型优先级', style: { ...stack, paddingInlineStart: 24, margin: 0 } }, ...routes.map((route, index) => {
            const item = models.get(keyOf(route))
            const label = item?.label ?? route.provider + ' · ' + route.model
            return h('li', { key: keyOf(route) + index }, h('div', { style: row },
              h('span', null, label, !item && catalog.status === 'ready' ? '（当前目录不可用）' : ''),
              effortPicker(label, route, item, editable, effort => setEffort(index, effort)),
              button('上移', () => move(index, -1), !editable || index === 0, '上移 ' + label),
              button('下移', () => move(index, 1), !editable || index === routes.length - 1, '下移 ' + label),
              button('移除', () => edit({ fallbackModels: routes.filter((_, i) => i !== index) }), !editable, '移除 ' + label)))
          })),
        !snapshot.writable && h('p', { role: 'status' }, '当前设置为只读。'),
        changed && h('p', { role: 'status' }, '设置已在其他位置更新。请放弃当前编辑，读取最新设置。'),
        h('div', { style: row },
          button(busy ? '正在保存…' : '保存', save, !draft || !editable),
          draft && button('放弃编辑', () => { setDraft(null); setNotice('') }, busy),
          notice && h('span', { role: 'status' }, notice)),
      )
    }

    return {
      name: id,
      inject: ['slots', 'configForms', 'remote', 'remote.session'],
      apply(ctx) {
        const page = {
          form: ctx.configForms.get(id),
          loadCatalog: () => ctx.remote.session.modelCatalog(),
          watchCatalog(refresh) {
            const disposers = [
              ctx.on('connection/reset', refresh),
              ctx.remote.$on('llm/adapters-updated', refresh),
              ctx.remote.$on('llm/models-updated', refresh),
            ]
            return () => disposers.forEach(dispose => dispose())
          },
        }
        ctx.effect(() => ctx.configForms.whileServed([id], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id, order: 35, label: () => title, inject: () => page,
        }, ModelFailoverPage))))
      },
    }
  },
})
