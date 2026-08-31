function normalizedLine(line: string): string {
  return line
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function markdownSections(text: string): Array<{ heading: string; body: string }> {
  const sections: Array<{ heading: string; lines: string[] }> = [{ heading: '', lines: [] }]
  for (const rawLine of text.split(/\r?\n/)) {
    const heading = rawLine.match(/^#{2,6}\s+(?:\d+(?:\.\d+)*\.?\s*)?(.+?)\s*$/)
    if (heading) {
      sections.push({ heading: normalizedLine(heading[1]), lines: [] })
      continue
    }
    sections.at(-1)?.lines.push(rawLine)
  }
  return sections.map((section) => ({ heading: section.heading, body: section.lines.join('\n') }))
}

function lineHasCount(body: string, label: RegExp, expected: number): boolean {
  return body.split(/\r?\n/).some((rawLine) => {
    const line = normalizedLine(rawLine)
    return label.test(line) && new RegExp(`(?:^|\\D)${expected}(?:\\D|$)`).test(line)
  })
}

/**
 * Score the finance-count contract semantically instead of depending on one
 * Markdown layout. A heading may supply the word "Transactions" while its
 * table rows use the concise labels "Raw rows in export" and
 * "Unique txn_id values".
 */
export function financeRecordCountsAndExceptionsComplete(text: string): boolean {
  const evidence = financeRecordCountEvidence(text)
  return evidence.rawTransactions
    && evidence.uniqueTransactions
    && evidence.duplicateTransaction
    && evidence.cancelledTransaction
}

export interface FinanceRecordCountEvidence {
  rawTransactions: boolean
  uniqueTransactions: boolean
  duplicateTransaction: boolean
  cancelledTransaction: boolean
}

export function financeRecordCountEvidence(text: string): FinanceRecordCountEvidence {
  const sections = markdownSections(text)
  const transactionSections = sections.filter((section) => /\btransactions?\b/i.test(section.heading))
  const transactionScope = transactionSections.map((section) => section.body).join('\n')
  const rawTransactions = lineHasCount(
    text,
    /\braw\b[^\n|]{0,40}\btransactions?\b|\btransactions?\b[^\n|]{0,40}\braw\b/i,
    6,
  ) || lineHasCount(transactionScope, /\braw\b[^\n|]{0,40}\b(?:rows?|records?)\b/i, 6)
  const uniqueTransactions = lineHasCount(
    text,
    /\b(?:unique|distinct|deduplicated)\b[^\n|]{0,50}\b(?:txn[_ ]?ids?|transactions?)\b/i,
    5,
  ) || lineHasCount(transactionScope, /\b(?:unique|distinct|deduplicated)\b[^\n|]{0,50}\b(?:txn[_ ]?ids?|rows?|records?)\b/i, 5)
  const duplicate = /duplicate[^\n]{0,100}\bA002\b|\bA002\b[^\n]{0,100}duplicate/i.test(text)
    || sections.some((section) => /\bduplicate\b/i.test(section.heading) && /\bA002\b/i.test(section.body))
  const cancelled = /cancelled[^\n]{0,100}\bA003\b|\bA003\b[^\n]{0,100}cancelled/i.test(text)
    || sections.some((section) => /\bcancelled\b/i.test(section.heading) && /\bA003\b/i.test(section.body))
  return {
    rawTransactions,
    uniqueTransactions,
    duplicateTransaction: duplicate,
    cancelledTransaction: cancelled,
  }
}

/**
 * Require an affirmative procurement disposition instead of accepting a
 * quoted policy sentence that merely contains the words "reject or defer".
 * Markdown emphasis and heading syntax must not make a correct decision
 * layout-sensitive.
 */
export function procurementDecisionDefersOrRejects(text: string): boolean {
  const normalized = text
    .normalize('NFKC')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/[`*_]/g, '')
  return /(?:^|\n)\s*(?:#{1,6}\s*)?(?:approval\s+)?(?:decision|recommendation)\s*:\s*(?:reject(?:ed|ion)?|defer(?:red|ral)?|do\s+not\s+approve|not\s+approved?|approval\s+withheld)\b/im.test(normalized)
}

/** Accept semantically explicit refund exceptions across ordinary Markdown. */
export function databaseRefundExceptionsComplete(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/[`*_]/g, '')
  const invalid = /R3[\s\S]{0,320}(?:cancelled|non-completed|not\s+applied)|(?:cancelled|non-completed|not\s+applied)[\s\S]{0,320}R3/i.test(normalized)
  const orphan = /R4[\s\S]{0,360}(?:orphan|missing|unknown|unresolved|does\s+not\s+exist|no\s+(?:matching|such)|not\s+applied)|(?:orphan|missing|unknown|unresolved|does\s+not\s+exist|no\s+(?:matching|such)|not\s+applied)[\s\S]{0,360}R4/i.test(normalized)
  return invalid && orphan
}

/** Accept both verb (exclude/excluded) and noun (exclusion/exclusions) methodology wording. */
export function dataAnalysisMethodExcludesCancelled(text: string): boolean {
  const exclusion = String.raw`exclu(?:d\w*|sion\w*)`
  return new RegExp(`${exclusion}[^\n]{0,50}cancelled|cancelled[^\n]{0,50}${exclusion}`, 'i').test(text)
}

/**
 * Match an affirmative vendor choice only on an explicit Decision or
 * Recommendation line. A later comparison paragraph mentioning another
 * vendor must not be mistaken for a second recommendation.
 */
export function hasExplicitVendorRecommendation(text: string, vendor: string): boolean {
  const normalized = text.normalize('NFKC').replace(/[`*_]/g, '')
  const escapedVendor = vendor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `(?:^|\\n)\\s*(?:#{1,6}\\s*)?(?:[^\\w\\s#]{1,4}\\s*)?(?:(?:decision|recommendation)\\s*:\\s*(?:(?:recommend(?:ed|ation)?|select(?:ed)?|choose|adopt)\\s+)?|(?:recommend(?:ed)?|select(?:ed)?|choose|adopt)\\s*:\\s*)${escapedVendor}\\b`,
    'im',
  ).test(normalized)
}

export interface StaleResearchConflictEvidence {
  staleSecondarySource: boolean
  oldPriceClaim: boolean
  oldSlaClaim: boolean
  currentFirstPartyControl: boolean
  authorityAndRecencyReasoning: boolean
}

/** Require the conflicting secondary claims themselves, not just "this is stale". */
export function staleResearchConflictEvidence(text: string): StaleResearchConflictEvidence {
  const normalized = text.normalize('NFKC').replace(/[‐‑‒–—−]/g, '-')
  const secondaryScopes = normalized.split(/\n(?=#{1,6}\s|---)/)
    .filter((section) => /(?:reseller|roundup|secondary|independent|2024|stale|outdated)/i.test(section))
  const secondaryText = secondaryScopes.join('\n')
  return {
    staleSecondarySource: /(?:2024|stale|outdated|not been updated|older)/i.test(secondaryText),
    oldPriceClaim: /(?:\$\s*35\b|35\s*(?:\/|per)\s*month)/i.test(secondaryText),
    oldSlaClaim: /99\.99\s*%/i.test(secondaryText),
    currentFirstPartyControl: /(?:current|updated|August\s+2026)[\s\S]{0,500}(?:first-party|official|authoritative|governs?|supersed)|(?:first-party|official|authoritative|governs?|supersed)[\s\S]{0,500}(?:current|updated|August\s+2026)/i.test(normalized),
    authorityAndRecencyReasoning: /authorit/i.test(normalized) && /recen|updated|newer|stale|outdated|supersed/i.test(normalized),
  }
}

export function staleResearchConflictReconciled(text: string): boolean {
  return Object.values(staleResearchConflictEvidence(text)).every(Boolean)
}
