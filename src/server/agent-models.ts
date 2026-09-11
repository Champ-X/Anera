import type { AgentModelOption } from '../shared/types.js'

// Official API catalog, checked 2026-09-10: https://api-docs.deepseek.com/zh-cn/
// Provider metadata stays outside the task controller and the composer.
export function resolveAgentModels(primary: string, configured: string, baseUrl: string): string[] {
  const explicit = configured.split(',').map((value) => value.trim()).filter(Boolean)
  if (explicit.length) return [...new Set([primary, ...explicit])]
  let official = false
  try { official = new URL(baseUrl).origin === 'https://api.deepseek.com' } catch { /* custom provider */ }
  if (!official) return [primary]
  const preferred = ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(primary)
    ? 'deepseek-flash' : primary
  return [...new Set([preferred, 'deepseek-flash', 'deepseek-v4-pro'])]
}

export function agentModelOption(model: string): AgentModelOption {
  const descriptions: Record<string, Pick<AgentModelOption, 'displayName' | 'description'>> = {
    'deepseek-flash': { displayName: 'DeepSeek V4.1 Flash', description: '推荐 · 快速经济 · 支持思考与非思考模式' },
    'deepseek-v4-flash': { displayName: 'DeepSeek Flash（兼容别名）', description: '官方已转至 V4.1 Flash，建议新会话使用 deepseek-flash' },
    'deepseek-v4-flash-vision-exp': { displayName: 'DeepSeek Flash（旧视觉别名）', description: '官方已转至 V4.1 Flash' },
    'deepseek-v4-pro': { displayName: 'DeepSeek V4 Pro', description: '费用较高 · 官方公告：2026-09-14 12:00（北京时间）起转路由至 V4.1 Flash' },
  }
  return {
    id: model,
    publicName: model,
    ...(descriptions[model] ?? { displayName: model.split(/[-_/]+/).filter(Boolean)
      .map((part) => part.toLowerCase() === 'deepseek' ? 'DeepSeek' : `${part[0]?.toUpperCase() || ''}${part.slice(1)}`).join(' ') }),
  }
}
