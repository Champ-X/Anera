/** User-authored additions to an already running task, in durable receipt order. */
export interface SteeringMessage {
  id: string
  clientMessageId: string
  sequence: number
  content: string
  status: 'received' | 'applied' | 'archived'
  receivedAt: string
  receivedTurnId?: string
  appliedAt?: string
  appliedTurnId?: string
  archivedAt?: string
  archiveReason?: 'workspace_restored'
  restoreId?: string
}

export const MAX_STEERING_CONTENT_LENGTH = 32_000
