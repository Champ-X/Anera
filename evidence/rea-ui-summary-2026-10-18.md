# Arena UI evidence snapshot — 2026-10-18

This records the sources and validation for the Anera interface update. It is not a feature-parity score.

Source: public `https://arena.ai/agent`, deployment `dpl_3UbNvzoXfT6iNZqgBa7GjsGeKLaT`, observed 2026-10-18. The capture saved 65 linked assets. 59 of 60 JavaScript files match exact source SHA-256 values from the separate REA browser inspection; every file quoted here matches. One unquoted JS file was absent from that runtime script set.

REA AST analysis examined five selected shipped JS files: 272,283 text bytes, 76,684 AST nodes, zero parse failures. Parent Evidence: `ev_ea6615cf63594ec73ccb930d6d0578095f79ed0238f0db68a1aaa0b6ba675e6d`. Browser Evidence: `ev_b740dee01029bee233890bba2be42e34f769ae6e8d2b4ac2a18ee09b0327927f`. Remaining files/relationships are explicitly outside analysis scope. Focused text inspection supplies the CSS and supplemental component contracts below.

| Observable shipped contract | Value |
| --- | --- |
| Sidebar | 240px expanded / 56px compact; 100ms transition; 7-day state cookie; Cmd/Ctrl+B excludes text editing |
| Light colors | canvas #fcfaf8; secondary #ffffff; tertiary #f4f0eb; text #2e2b29; muted #67625b; faint border #eeedec |
| Typography | Basel Grotesk body, normal message default 16px/24px; Martina Plantijn hero 48px/48px, weight 300 |
| Agent landing | 672px maximum composer width; 14px input radius; 32px action controls |
| Header | 52px desktop minimum; session-specific title menu; no permanent Agent Mode title on the landing shell |
| User message | max-width min(70%,768px); 8px radius; 12px horizontal / 8px vertical body padding |
| Workspace sizing state | file tree 256px default, clamp 256–600px; preview ratio 0.6 default, clamp 0.15–0.75, stored per session |

Anonymous/public, authenticated, and feature-flagged variants remain distinct. Public code alone does not establish a particular user's model availability, enabled Auto selector, authenticated greeting copy, loaded response layout, or backend behavior. Separately, direct screenshot and read-only DOM observation through the browser connector in a user-provided authenticated Arena window confirmed the greeting “What would you like to do?”, 48px/48px display typography, a 672px landing composer, a 768px conversation composer, compact tool rows, and top-aligned workspace cards. These authenticated observations are not attributed to the public REA evidence IDs above. The original conversation was restored after inspection; no messages were submitted. Historical August evidence is not a current visual baseline. A no-match route trace was preserved as an extraction limitation, not interpreted as absence.

Local source receipts (excluded from version control):

| Repository-relative source | Bytes | SHA-256 |
| --- | ---: | --- |
| reports/rea-arena-2026-10-18/current-fetch-manifest.json | 29145 | ea4e1bafa8dc813c98c56d0b077ce25186be6911c42bd63b5af9e157a4462567 |
| reports/rea-arena-2026-10-18/static-live-reconciliation.json | 18628 | de18ff252ce8bdc3afe53c34a1483d7af504a206abe0a6712fc1e72a2e74ec53 |
| reports/rea-arena-2026-10-18/static-ui-source-excerpts.json | 38801 | cb1dec597bd846b2df8f842878638c86874ba05adef9f6a018fe3b19fd9f196e |
| reports/rea-arena-2026-10-18/conversation-workspace-source-excerpts.json | 11592 | 8e233531f5590a108a9781899b8c9d88270b582fb6b12044d240216227020c82 |

## Implemented in Anera

- Warm paper, text, soft-surface and border colors follow the current light-theme tokens.
- Desktop sidebar keeps navigation in a 56px rail, expands to 240px, persists its state locally, and supports Cmd/Ctrl+B with text-editing and IME exclusions. Collapsing from focused history restores focus to the visible toggle. Mobile drawer state remains independent.
- Landing keeps the authenticated greeting, a centered 672px input, 14px corners and compact controls. Three built-in task suggestions fill an editable draft and retain its attachments.
- One keyboard-accessible add menu exposes real file uploads and the existing GitHub connection. The actual configured model names remain visible. Agent is a static mode label; Send uses a right arrow. At widths up to 720px Enter inserts a newline; desktop Enter submits and Shift+Enter inserts a newline. IME composition remains protected.
- Conversation content and composer share a 768px maximum. Normal message text uses 16px/24px, user messages use the current raised color and 8px/12px padding. Tool summaries stay compact.
- The 256px workspace contains a card with 12px outer inset, aligned at the top of the page. The collapse control remains outside the card. Narrow screens retain an overlay panel.
- Conversation headers show the session title; the landing header has no permanent Agent Mode label.

## Scope boundaries

Anera retains its brand, system body font and Baskerville/Times serif fallback, native model picker, real model catalog, local persistence, and supported GitHub connection. It does not claim Arena's exact licensed fonts, Auto/Max routing, external integrations, resizable workspace persistence, title dropdown, or backend feature parity. Existing attachment ordering and the mobile user-message width remain Anera choices. No real model task was needed for these interface changes.

The capture harness now follows the actual `aria-current` history state and the unified menu. Workspace geometry expectations were deliberately updated to the current source-backed 256px layout, and the composer height bound to 40dvh (360px at the desktop fixture). The capture also exposed pre-existing assumptions that submissions used a null model and running tasks locked the editor; these were corrected to the selected fixture model and current steering behavior, keeping exact payload and interaction assertions. Historical frozen fingerprints and August screenshots are not reused as proof of this update.

## UI-stage validation

- TypeScript check and production build passed. The UI-stage client was rebuilt after the keyboard-focus correction.
- Frontend module tests: 9 files / 166 tests passed.
- Client browser regression: 2 files / 12 tests passed, followed by the focused history-collapse keyboard case passing after its focus correction.
- Complete deterministic UI capture: 62 states and 62 screenshot attestations, `passed: true`, zero console errors and zero detected horizontal/vertical overflows. It covers upload/paste payloads, preview, feedback/undo, GitHub controls, streamed output, steering availability and workspace persistence. This is local fixture validation, not a measured Arena parity result.
- Manually inspected desktop landing, collapsed sidebar, conversation/preview, workspace, connection menu, feedback and running states. Separate REA captures verified the 390×844 mobile landing and 390×500 short-viewport menu.
- Live local frontend/backend remained available at localhost:5173 and 127.0.0.1:4174; `/api/health` returned healthy. No real model task or external connector action was submitted.

Local capture manifest: `reports/rea-arena-20261018/capture-summary.json`; UI contract: `reports/rea-arena-20261018/ui-contract.json`. Captured implementation fingerprint: `de3f02c59c984bb498986fb5690beed8897c665cf20d62f88788e818d1dca8c2`. This identifies the UI-stage checkpoint before the subsequent input-admission and targeted-stop changes. Source/runtime hashes were reconciled at that checkpoint; this original capture does not attest to the later combined tree. Runtime validation is recorded separately in `rea-backend-summary-2026-10-18.md`.

Additional REA scenario evidence: public expanded sidebar `ev_1bb61f38354034432d40d2b8766edc0d58ff5c3512bb472f138d01e0f6da0d59`; local compact sidebar `ev_9424f99c9eca5b4b18b9c70f53ca92578278cf376f929e024deb0820a2be1d2e`; mobile landing `ev_8367148f29fdcbb7b21efe57383463e975e02f4e6bb66123cb70d210f0cad175`; short-viewport menu `ev_f1bb13d3dd8f05beda9d094cc803f23fd0cc18f4443046b460be1c3e6cb4e913`.

## Combined-tree validation

After the input-admission and targeted-stop changes, the custom-feedback, Enter and attachment-only payload checks now require a valid UUIDv7 `clientMessageId` before exactly comparing all remaining envelope fields. This preserves the transport assertions while validating the new submission identity.

`npm run build` and `npm run visual:capture -- --output reports/rea-arena-combined-2026-10-18` both passed against the combined implementation. The new run recorded 62 states and 62 screenshot attestations, zero console errors and zero horizontal/vertical overflows. All 118 fingerprinted source/runtime files and all 62 screenshots matched their recorded sizes and SHA-256 values after capture. It used an isolated headless browser and temporary local fixture service; it did not submit a real model task or operate the user's browser.

Combined capture manifest: `reports/rea-arena-combined-2026-10-18/capture-summary.json`; UI contract: `reports/rea-arena-combined-2026-10-18/ui-contract.json`; hash reconciliation: `reports/rea-arena-combined-2026-10-18/fingerprint-reconciliation.json`. Implementation fingerprint: `0c94526a11614e08d154fe3cf39727fed57b23b90b4e259218e7997fbee70283`. The original UI-stage capture directory remains unchanged. This remains local deterministic validation, not a measurement of Arena backend parity.

Raw scripts, REA bundles, authenticated account content and local screenshots remain excluded from version control. This concise summary does not imply that the historical evidence-integrity script accepts a new schema.
