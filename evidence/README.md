# Anera public evidence pack

This directory is the compact, publication-safe evidence surface for the replication report. It contains field-selected summaries only: no Arena recording frames, account-visible captures, raw conversations, session IDs, credentials, email addresses, or host-absolute paths are included.

| Evidence | What it establishes | What it does not establish |
|---|---|---|
| [`public-contract-summary.md`](./public-contract-summary.md) / [JSON](./public-contract-summary.json) | Unauthenticated public Arena bundle contracts and the zero-issue local projection diff | Arena's private backend or exact end-to-end parity |
| [`harness-convergence-summary.json`](./harness-convergence-summary.json) | 9/9 scenarios and 19/19 active tools with a real configured model | Arena-side calls, tokens, cost, or mobile behavior |
| [`quality-benchmark-summary.json`](./quality-benchmark-summary.json) | One fingerprinted 18/18 Anera run with 100 average quality, bounded physical/model/tool calls, and the visual-reconstruction outcome | A paired Arena benchmark |
| [`ui-state-coverage-summary.json`](./ui-state-coverage-summary.json) | 62/62 deterministic desktop states and interaction gates, with bytes/SHA-256 attestation for all 62 screenshots | Cross-product pixel parity or mobile coverage |
| [`live-web-provider-summary.json`](./live-web-provider-summary.json) | Live Tavily/Firecrawl admission, pagination, and cache behavior | Provider dollar cost or Arena provider identity |
| [`live-vision-summary.json`](./live-vision-summary.json) | Latest active-tool DeepSeek Vision dispatch/tool chain plus immutable bounded-recovery and corrected historical-cost evidence | A provider bill or an Arena vision baseline |
| [`html-slides-live-summary.json`](./html-slides-live-summary.json) | The exact recording prompt closing research → HTML → preview → Browser navigation → screenshot → Vision → presentation with a fingerprinted production bundle | An Arena-side trace, same-viewport pixel baseline, or provider-identity match |
| [`arena-reference-corpus-summary.md`](./arena-reference-corpus-summary.md) / [JSON](./arena-reference-corpus-summary.json) | Historical structured Arena intake counts and limits | A current v2.0 paired parity score |
| [`arena-video-audit-summary.md`](./arena-video-audit-summary.md) | Sanitized timeline and gap conclusion from one private recording | The private recording or any screenshot from it |

Every summary records the repository-relative source path, source byte size, and SHA-256 of the immutable local source used for extraction. These hashes permit rechecking when the excluded source material is available to an authorized reviewer; they are not proof that a private capture originated from Arena.

When the excluded `reports/` sources are available in the evidence-producing workspace, run the release integrity audit from the repository root:

```bash
npx --no-install tsx scripts/public-evidence-integrity.ts
```

The audit verifies source bytes and hashes, the semantic projection of every published result, local documentation links, redaction invariants, and current-canary claims. It fails closed when a source is missing or a published field drifts.

## Interpretation boundary

- `passed: true` retains the meaning of the named source gate only.
- Anera internal quality, convergence, UI, provider, and vision gates are not relabeled as Arena parity.
- The historical Arena corpus has zero current-version eligible references and zero paired Anera candidates, so formal parity, efficiency, and same-viewport DOM/PNG scores remain unavailable.
- The public-contract audit is restricted to unauthenticated, read-only public assets and does not use cookies.
- Desktop is the evaluated visual scope; mobile is explicitly excluded.
