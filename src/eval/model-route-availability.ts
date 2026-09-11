/** Verified in the provider's pricing and Vision documentation, not inferred
 * from similar catalog names. The budget separately enforces tariff freshness.
 * A discovery list may omit accepted request aliases; absence is diagnostic,
 * while actual provider rejection remains terminal under the normal client. */
export const DOCUMENTED_FLASH_ROUTES = {
  text: 'deepseek-v4-flash',
  image_input: 'deepseek-v4-flash-vision-exp',
} as const

export function modelRouteAvailability(model: string, catalog: readonly string[]) {
  const listed = catalog.includes(model)
  const documented = Object.values(DOCUMENTED_FLASH_ROUTES).some((value) => value === model)
  return { requestedModel: model, listed, documented, mayAttempt: listed || documented }
}
