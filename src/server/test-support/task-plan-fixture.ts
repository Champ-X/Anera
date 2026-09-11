import { recoverActiveTaskPlanIdentity, recoverActiveTaskRequestText, recoverActiveTaskTemporalControl } from '../agent-service.js'
import { taskScopeIdentity } from '../task-context.js'
import { createTaskPlanBinding } from '../task-plan.js'
import type { SessionStore } from '../session-store.js'

/** Synthetic provenance for fixtures explicitly starting AFTER plan review.
 * Production never calls this or upgrades an unbound historical plan. */
export async function taskPlanBindingFixture(store: SessionStore, sessionId: string, planSha256: string) {
  const events = await store.events(sessionId)
  const state = await store.get(sessionId)
  const request = recoverActiveTaskRequestText(events) ?? state.messages.find((message) => message.role === 'user')?.content
  if (!request) throw new Error('Plan fixture needs its original task before seeding reviewed evidence')
  return createTaskPlanBinding(recoverActiveTaskPlanIdentity(events, state.timezone)
    ?? taskScopeIdentity(request, recoverActiveTaskTemporalControl(events, state.timezone)), planSha256)
}
