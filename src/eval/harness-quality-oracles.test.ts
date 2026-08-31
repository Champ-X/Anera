import { describe, expect, it } from 'vitest'
import {
  dataAnalysisMethodExcludesCancelled,
  databaseRefundExceptionsComplete,
  financeRecordCountEvidence,
  financeRecordCountsAndExceptionsComplete,
  hasExplicitVendorRecommendation,
  procurementDecisionDefersOrRejects,
  staleResearchConflictEvidence,
  staleResearchConflictReconciled,
} from './harness-quality-oracles.js'

describe('Harness quality semantic oracles', () => {
  it('accepts both exclusion and excluded wording for cancelled-order methodology', () => {
    expect(dataAnalysisMethodExcludesCancelled('Exclusions: 1 cancelled order was removed from all calculations.')).toBe(true)
    expect(dataAnalysisMethodExcludesCancelled('The method excluded cancelled orders.')).toBe(true)
    expect(dataAnalysisMethodExcludesCancelled('Cancelled orders are exclusions from revenue.')).toBe(true)
    expect(dataAnalysisMethodExcludesCancelled('Cancelled orders were included in revenue.')).toBe(false)
  })

  it('accepts complete transaction counts expressed inside a Markdown subsection', () => {
    const report = `
## 3. Counts

### 3.1 Transactions

| Measure | Count |
|---|---|
| Raw rows in export | 6 |
| Unique \`txn_id\` values | 5 |
| Duplicate rows removed | 1 |

## Data-Quality Exceptions

- Duplicate transaction row: A002 was counted once.
- Cancelled transaction: A003 was excluded.
`
    expect(financeRecordCountEvidence(report)).toEqual({
      rawTransactions: true,
      uniqueTransactions: true,
      duplicateTransaction: true,
      cancelledTransaction: true,
    })
    expect(financeRecordCountsAndExceptionsComplete(report)).toBe(true)
  })

  it('accepts explicit prose labels without requiring a particular section layout', () => {
    const report = 'Raw transaction rows: 6.\nDeduplicated transactions: 5.\nA002 is a duplicate.\nA003 is cancelled.'
    expect(financeRecordCountsAndExceptionsComplete(report)).toBe(true)
  })

  it('associates exception IDs with their Markdown subsection headings', () => {
    const report = `
## Counts
Raw transaction rows: 6.
Deduplicated transactions: 5.

### Duplicate transaction row
- txn_id: A002

### Cancelled transaction
- txn_id: A003
`
    expect(financeRecordCountsAndExceptionsComplete(report)).toBe(true)
  })

  it('does not let captured counts or wrong totals substitute for the deduplicated contract', () => {
    const missingUnique = 'Raw transaction rows: 6.\nCaptured transactions: 4.\nA002 duplicate.\nA003 cancelled.'
    const wrongRaw = 'Raw transaction rows: 5.\nDeduplicated transactions: 5.\nA002 duplicate.\nA003 cancelled.'
    expect(financeRecordCountsAndExceptionsComplete(missingUnique)).toBe(false)
    expect(financeRecordCountsAndExceptionsComplete(wrongRaw)).toBe(false)
  })

  it('recognizes an explicit reject/defer disposition without depending on Markdown layout', () => {
    expect(procurementDecisionDefersOrRejects('**Decision:** **DEFER** (approval withheld pending remediation).')).toBe(true)
    expect(procurementDecisionDefersOrRejects('## Recommendation: Do not approve until every blocker closes.')).toBe(true)
  })

  it('does not mistake a quoted policy rule for the candidate decision', () => {
    const conditionalApproval = `
The policy says procurement must reject or defer when a hard requirement fails.

## Decision: APPROVE WITH CONDITIONS
`
    expect(procurementDecisionDefersOrRejects(conditionalApproval)).toBe(false)
  })

  it('accepts plural txn_ids and Markdown-formatted exception language', () => {
    const report = `
| Raw transaction rows | 6 |
| Unique \`txn_id\`s (deduplicated) | 5 |
| Duplicate transaction row | \`A002\` counted once |
| Cancelled transaction | \`A003\` excluded |
`
    expect(financeRecordCountsAndExceptionsComplete(report)).toBe(true)
  })

  it('recognizes both database refund exception classes across Markdown boundaries', () => {
    const report = `
### Non-completed refunds
| R3 | O3 |
Refund \`R3\` references a \`cancelled\` order and was **not** applied.

### Orphan refunds
| R4 | O999 |
Refund \`R4\` references an order that does not exist and was **not** applied.
`
    expect(databaseRefundExceptionsComplete(report)).toBe(true)
    expect(databaseRefundExceptionsComplete(report.replace(/R4/g, 'R5'))).toBe(false)
  })

  it('recognizes one explicit vendor choice without treating later comparison prose as another recommendation', () => {
    const memo = `
**Decision:** **Recommend Gamma Cloud (Regional Team).**

Gamma passes every requirement. Delta is the only lower-priced alternative, but it fails EU residency and cannot be selected.
`
    expect(hasExplicitVendorRecommendation(memo, 'Gamma')).toBe(true)
    expect(hasExplicitVendorRecommendation(memo, 'Delta')).toBe(false)
    expect(hasExplicitVendorRecommendation('## Recommendation: Select Delta Cloud', 'Delta')).toBe(true)
    expect(hasExplicitVendorRecommendation('### ✅ Recommend: **Gamma Cloud — Regional Team**', 'Gamma')).toBe(true)
    expect(hasExplicitVendorRecommendation('**Recommendation: Adopt Gamma Cloud (Regional Team plan).**', 'Gamma')).toBe(true)
    expect(hasExplicitVendorRecommendation('Delta Cloud is not recommended because it fails EU residency.', 'Delta')).toBe(false)
    expect(hasExplicitVendorRecommendation('## Recommendation: Do not recommend Delta Cloud', 'Delta')).toBe(false)
  })

  it('requires stale conflicting values and authority/recency resolution for web research', () => {
    const complete = `
## Source conflict
The March 2024 reseller roundup listed Gamma at $35 per month with a 99.99% SLA. Those values conflict with the current official page's $48 and 99.97%.
The current first-party documentation was updated in August 2026 and is authoritative for vendor terms, so it supersedes the stale secondary source by authority and recency.
`
    expect(staleResearchConflictEvidence(complete)).toEqual({
      staleSecondarySource: true,
      oldPriceClaim: true,
      oldSlaClaim: true,
      currentFirstPartyControl: true,
      authorityAndRecencyReasoning: true,
    })
    expect(staleResearchConflictReconciled(complete)).toBe(true)
    expect(staleResearchConflictReconciled(complete.replace('$35 per month with a 99.99% SLA', 'older terms'))).toBe(false)
  })
})
