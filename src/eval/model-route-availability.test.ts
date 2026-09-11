import { expect, it } from 'vitest'
import { modelRouteAvailability } from './model-route-availability.js'

it.each(['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'])('does not treat catalog absence as provider rejection for documented %s', (model) => {
  expect(modelRouteAvailability(model, ['deepseek-flash', 'deepseek-v4-pro']))
    .toEqual({ requestedModel: model, listed: false, documented: true, mayAttempt: true })
})

it('does not infer equivalence or choose another model from similar names', () => {
  expect(modelRouteAvailability('deepseek-v4-flash-next', ['deepseek-flash'])).toMatchObject({ documented: false, listed: false, mayAttempt: false })
  expect(modelRouteAvailability('deepseek-flash', [])).toMatchObject({ documented: false, listed: false, mayAttempt: false })
  expect(modelRouteAvailability('deepseek-v4-pro', ['deepseek-v4-pro'])).toMatchObject({ requestedModel: 'deepseek-v4-pro', listed: true, mayAttempt: true })
})
