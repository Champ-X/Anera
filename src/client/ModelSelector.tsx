import type { AgentModelOption } from '../shared/types'

export function ModelSelector(props: {
  models: AgentModelOption[]
  value: string
  unavailable: boolean
  disabled?: boolean
  onChange: (model: string) => void
}) {
  const selected = props.models.find((model) => model.id === props.value)
  const hint = props.unavailable
    ? '模型列表加载失败；已有会话仍可使用保存的模型。刷新页面可重试。'
    : selected?.description ?? '用于下一条消息或继续任务；不会更改历史记录。'
  return <div className="composer-model-picker" title={hint}>
    <select
      aria-label="选择模型"
      value={props.value}
      disabled={props.disabled || props.unavailable || props.models.length === 0}
      onChange={(event) => props.onChange(event.target.value)}
    >
      {!props.value && <option value="">{props.unavailable ? '模型列表不可用' : '加载模型…'}</option>}
      {props.value && !selected && <option value={props.value}>{props.value}（当前会话）</option>}
      {props.models.map((model) => <option key={model.id} value={model.id}>
        {model.displayName || model.publicName}
      </option>)}
    </select>
    {selected?.description && <span className="composer-model-note">{selected.description}</span>}
    {props.unavailable && <span className="composer-model-note" role="status">模型列表不可用，请刷新重试</span>}
  </div>
}
