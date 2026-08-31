# Anera

**Anera** is `Arena` read backwards (ignoring capitalization). The name also describes the engineering method: reconstruct Arena Agent Mode from its public, observable behavior, then prove each reproduced capability with executable contracts and durable traces.

Anera contains two deliverables:

- a local, executable TypeScript Agent Harness with the three-column desktop workspace UI;
- a read-only static exhibit for Vercel, built from four redacted snapshots of real Anera runs.

## Verified scope

Anera has completed a high-fidelity reconstruction of the **observable desktop Agent Mode v1 core**:

| Gate | Result | What it establishes |
| --- | ---: | --- |
| Public contract | PASS | Public tool registry, schema, prompt/UI and transport projections |
| Active tools | 19/19 | Every tool in the ordinary completed-route registry closes through the Harness |
| Frozen quality tasks | 18/18 | Average quality 99.44; 118 tool calls; 0 failed tools |
| Desktop UI states | 61/61 | Required state captures; 0 console errors and 0 overflow failures |
| Recording audit | P0 = 0, P1 = 0 | No blocking gap in the declared ordinary desktop v1 scope |

These results do **not** claim access to Arena's private source code or model weights. They also do not prove mobile parity, identical stochastic model choices, or formal same-version trace/pixel/cost parity. See [REPLICATION_REPORT.md](REPLICATION_REPORT.md) for the full method, evidence and limits, and [the evidence index](evidence/README.md) for the curated machine-readable release anchors.

## Static exhibit

The exhibit retains the original Anera UI and projects real, redacted Session events through its normal timeline and Workspace logic. Visitors can replay the traces but cannot submit tasks, upload files, send feedback, restart processes or download a live Workspace.

The four included runs cover:

1. reference-image to responsive dashboard, including desktop/mobile verification;
2. an interactive counter verified through Browser actions and a saved screenshot;
3. multi-source research on HTTP 103 Early Hints;
4. a 900-line attachment, context compaction and independent Bash verification.

Run it locally:

```bash
npm ci
npm run dev:showcase
```

Open `http://127.0.0.1:5173`. The main routes are `/`, `/report`, and `/agent/:sessionId`.

Rebuild the public fixtures from the selected local Sessions with:

```bash
npm run showcase:fixtures
npm run build:showcase
```

The generator removes local paths, rewrites Workspace/Artifact URLs, scans common secret forms, and omits private runtime directories. Full historical reports and runtime state are intentionally excluded from Git and Vercel.

## Run the executable Harness

Requirements: Node.js 22 and a DeepSeek-compatible API key.

```bash
npm ci
cp .env.example .env
# Set DEEPSEEK_API_KEY in .env
npm run dev
```

Open `http://127.0.0.1:5173`. For a production build:

```bash
npm run build
npm start
```

Optional Tavily and Firecrawl credentials enable their production-backed Web paths. Without them, the Harness retains its safe public-network fallback. Production provider/account/host canaries are fail-closed and are documented in [PRODUCTION_CANARY_RUNBOOK.md](PRODUCTION_CANARY_RUNBOOK.md).

## Architecture

- `src/server/agent-service.ts` — bounded model/tool loop, routing and completion contracts.
- `src/server/session-store.ts` — append-only event/state durability and recovery.
- `src/server/tools.ts` — Workspace, shell, Web, Browser, media and publication boundaries.
- `src/client/App.tsx` — Session timeline, Workspace and Artifact/Website projection.
- `src/eval/` — contract, canonical-trace, parity and visual evaluation tools.
- `scripts/` — deterministic smokes, benchmarks, canaries and static-fixture builder.

The public 19-tool baseline stays frozen. Anera-specific pagination and safety overlays are versioned and tested separately rather than being mislabeled as observed Arena behavior.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run build:showcase
npm audit --audit-level=high
```

Additional design and evaluation references:

- [FIDELITY_AUDIT.md](FIDELITY_AUDIT.md)
- [AGENT_HARNESS_CAPABILITY_MATRIX.md](AGENT_HARNESS_CAPABILITY_MATRIX.md)
- [CANONICAL_TRACE_EVAL.md](CANONICAL_TRACE_EVAL.md)
- [ARENA_MANUAL_PROBE_RUNBOOK.md](ARENA_MANUAL_PROBE_RUNBOOK.md)

## Security and data boundary

- `.env`, `.anera/`, generated evaluation workspaces and full `reports/` are ignored.
- The committed showcase is read-only and contains only selected, redacted assets.
- Shell execution uses macOS Seatbelt or Linux Bubblewrap when available; production can require that boundary with `ANERA_REQUIRE_OS_SANDBOX=true`.
- Credentials must never be committed. Use [.env.example](.env.example) as the configuration template.

This repository demonstrates independent black-box reconstruction of public behavior. Arena remains the product of its respective owner; no affiliation or endorsement is implied.
