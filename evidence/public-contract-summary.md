# Arena public-contract summary

The unauthenticated, read-only public bundle audit passed with zero reported issues. It used public HTML and JavaScript assets without a cookie jar or `Cookie` header.

Frozen Arena deployment: `dpl_A1Vbar2TqcbueSZE1rhwVjSrYyPY`.

The intake parsed **59 public script assets** plus **1 supplemental completed route**.

## Frozen observable surface

- Current completed-route active registry: **19 tools**, with live schema and description evidence for all 19.
- Missing active tools locally: **0**.
- Expected active tools missing publicly: **0**.
- Unexpected active tools: **0**.
- Active schema/description mismatches: **0 / 0**.
- Public prompt templates found: ordinary Agent, Coding, and Coding closed-session guidance; each is frozen by length and SHA-256 in the JSON summary.
- Local prompt-projection mismatches: **0**.
- Missing general/completed-route UI strings locally: **0 / 0**.
- Also covered: preview/raw switcher, Task Review, Task Completion, thank-you state, custom feedback, Undo, new/existing-turn transports, and signed upload transport.

The active tools are `add_voice`, `ask_user`, `bash`, `compact`, `edit_file`, `fetch_page`, `generate_image`, `generate_speech`, `get_process_output`, `image_search`, `list_connector_tools`, `list_files`, `present_file`, `propose_plan`, `read_file`, `start_process`, `stop_process`, `web_search`, and `write_file`.

This evidence constrains public observable contracts. It does not expose Arena's private backend, server-appended context, model routing, or prove end-to-end parity.

Source: `reports/arena-public-contract/latest.json`, 119,169 bytes, SHA-256 `d5f0be67aa203fca0ac4d0764ecf176bf5e411b3b80a731698936644a6816cd7`.
