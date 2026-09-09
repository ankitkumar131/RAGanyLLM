# 🧭 RAGanyLLM — RAG Improvements & Feature Roadmap

> Written from a **RAG expert's** perspective. Every item is grounded in the current codebase
> (`lib/server.js`, `lib/vector-store.js`, `public/index.html`) and aimed at three product goals:
>
> 1. **🧒 Noob-proof by default** — a person with *zero* RAG/AI/terminal knowledge can do RAG and create their own AI.
> 2. **🧠 Real RAG quality** — retrieval that actually retrieves the right context, with measurable accuracy.
> 3. **📦 Portable knowledge** — export the knowledge base / custom AI from this device and import it on another device in a few clicks.

---

## Priority legend

| Tag | Meaning |
|---|---|
| **P0** | Must-have for the "noob can do it" v1.1 promise |
| **P1** | Next release — big quality/UX win |
| **P2** | Later — scale, polish, platform |
| Effort | S (≤1 day) · M (≤1 week) · L (1–4 weeks) · XL (1–3 months) |

---

## 0. Foundation fixes first (RAG quality is impossible on a broken base)

These are concrete bugs in the current code that *must* be fixed before layering features on top.

- [x] **[P0 · S] Fix the similarity threshold** — was `0.15` (admits everything). Now configurable (`similarity_threshold`, default `0.4`, clamped 0–0.99), honored by `vector-store.search()` and `/api/query`, exposed via `GET /api/models → retrieval` + `POST /api/config`. **UI**: ⚙️ Settings → "Retrieval (Advanced)" slider/number inputs + live "top N · ≥ M%" caption above the chat. UI shows an honest "No relevant context found" banner when the search comes up empty. *(done)*
- [x] **[P0 · S] Store KB & config in a user-owned location** — was `process.cwd()`-relative. New `lib/paths.js` resolves `$RAGANYLLM_HOME || ~/.raganyllm` (fallback cwd); config & vector store both live there now. *(done)*
- [x] **[P0 · S] Sanitize LLM output before rendering** — `marked.parse(...)` output now passes through DOMPurify before `innerHTML`; `escapeHtml` also escapes single quotes; model-delete buttons no longer interpolate names into inline `onclick`. *(done)*
- [x] **[P0 · S] Kill the open-door API** — server binds `127.0.0.1` by default (`HOST` env to open up), cross-origin requests from untrusted pages are rejected 403 (origin guard replacing blanket CORS), multer caps at 25 MB × 10 files, JSON cap 25 MB, and `DELETE /api/models/:model` only deletes models Ollama actually reports installed. *(done)*
- [x] **[P0 · S] Deduplicate ingestion** — chunks are keyed by `sha256(source|chunk_index|content)`; re-ingesting identical content is skipped (responses report `added`/`skipped`), and old duplicate rows are healed on load. *(done)*
- [x] **[P0 · S] Don't ship fake seed data as the default KB** — `raganyllm-kb.json`/`raganyllm-config.json` removed from the repo and gitignored; KB starts empty in the user data dir. An optional, factual **"✨ Load Sample Documents"** on-ramp (3 short starter docs about RAG / Ollama / Angular 20) appears in the UI only while the KB is empty — one click, dedupe-safe, with progress. *(done — GET+POST /api/kb/samples + UI)*

---

## 1. 🧒 Noob-Proof Experience — "a noob can do RAG"

The promise: *open the app → answer 3 questions → RAG is working → make your own AI*. No terminal, no Ollama knowledge, no jargon.

### 1.1 First-Run Wizard (P0 · M)
- [x] **Guided setup wizard (v1)** — auto-opens on first run and is re-runnable from ⚙️ Settings → **🪄 Setup Assistant**. Server-backed (`GET /api/setup/status` first-run + live health, `POST /api/setup/persona`, `POST /api/setup/complete`, `GET /api/setup/questions`), state persists in the config. *(done 2026-09-09 — see the four steps below for exactly what each step does; installing Ollama itself stays a guided download (wizard links to the official installer) rather than an automated system install)*

A 4-step guided setup the first time the app runs (and re-runnable from Settings → "Setup Assistant"):
1. **Check my computer** — health dashboard in plain language ("✓ AI engine found", "✗ AI engine not found — click to download & install it"). Auto-download/install Ollama if missing; auto-pull `nomic-embed-text` **and a recommended beginner chat model** (e.g. `llama3.2` or `qwen2.5`) with live progress.
2. **What is my AI for?** — persona picker: "Document Q&A", "Website docs assistant", "My knowledge notes", "Custom". This pre-configures sensible chunking/retrieval/model defaults.
3. **Give it your brain** — big friendly drop-zones for files/folders/URLs; the wizard auto-ingests and shows a live 0→100% progress with plain-language stage text ("Reading your PDF…", "Cutting it into pieces…", "Teaching the AI…").
4. **Try it!** — auto-asks 3 questions generated from the ingested content so the user immediately *sees* it working; shows the retrieved sources.

### 1.2 Plain-language everything (P0 · M)
- Replace every technical status with human text + a "Why?" tooltip: "embedding" → "Teaching the AI to understand your words"; "vector store" → "Your AI's memory"; "chunking" → "Cutting documents into readable pieces".
- [x] **Error Doctor** — every error gets an icon, a plain explanation, the fix, and a "Fix it for me" action card: `friendlyError()` maps Ollama-down, model-not-installed, embedding failure and oversized-context messages; action buttons are rendered by the same helper everywhere — chat answers (<b>Get Ollama</b>, check-again, manage models, ↻ Retry my question) AND ingest/import/progress failures (check-again / manage models, no chat-retry). *(done — remaining polish: an optional "Start Ollama" deep-link/launcher button)*
- [x] **Status traffic light** always visible in the chat header: 🟢 Ready to chat / 🟡 Needs attention / 🔴 Setup required, with a one-line reason tooltip — driven by live Ollama connection, embedding-model install state, selected chat model, and KB contents (refresh every 15 s). *(done — sidebar Ollama/embedding badges additionally reflect live state)*

### 1.3 Modes (P0 · S)
- [x] **Simple mode (default)** — ⚙️ Settings starts in a **🙂 Simple** view (stored per browser) with one friendly control: "How much detail?" (Concise / Balanced / Detailed), wired into `/api/query` → family-aware system prompts (see §2.3). Advanced blocks are hidden, never reset.
- [x] **Advanced mode** — one click in Settings reveals every expert knob: top-k, similarity threshold, search mode, the §2.2 enhancement toggles, model manager, and the custom storage directory. *(chunk size/overlap remain constants — tunable re-chunking is the open §2.1 item)*

### 1.4 Guided "My AI" creator (P0 · L — centerpiece, see §4)

### 1.5 Learning content (P1 · M)
- [x] **Explainer + FAQ** — ❓ **Help** modal (chat header) explains the exact pipeline with <i>live numbers from this device</i> (documents/chunks, embedding model, search mode) and a six-question FAQ accordion (getting started, Live-RAG context, "no context found", moving your AI between computers, Ollama offline, Simple vs Advanced). *(done — a 90-second narrated video is out of scope for an offline local app; the §1.1 wizard doubles as the guided tour)*
- [x] **Chat empty state** — until the first message, the chat shows "💡 Your AI knows N document(s) (M chunk(s)) — try asking:" with up to 3 suggestion chips generated from the KB (`GET /api/setup/questions`); picking one asks the question immediately. Hidden as soon as you type (re-appears after 🧹 New Chat).

---

## 2. 🧠 RAG Core Quality Engine

The current pipeline is: chunk (600 chars) → embed → top-k cosine → stuff into prompt. That is *minimal viable RAG*. A serious upgrade path:

### 2.1 Smart chunking (P1 · M)
- Token-aware chunker (respect each model's context), not raw characters.
- Structure-aware splitting for Markdown (headers → sections), code blocks kept intact, list/table boundaries preferred.
- Heading/citation metadata attached to every chunk (chunk → "Section 2.3 · page 12 · file X") for better citations and display.
- Re-chunk on config change with a **"Re-process my knowledge base"** button (store source docs separately from chunks so re-chunking never needs re-upload).

### 2.2 Retrieval quality (P0/P1)
- [x] **[P1 · M] Hybrid search** — in-memory BM25 (Okapi, k1=1.5/b=0.75) inverted index over chunks, fused with cosine similarity via Reciprocal Rank Fusion. Opt-in `search_mode: 'hybrid'` (config + ⚙️ Settings select, per-request override supported; default stays `vector`). A document surfaces when it is a strong vector hit *or* a strong keyword hit, so exact names/identifiers that pure vector search misses are recovered; each result carries `cosine_similarity` + `keyword_score` + normalized fused `similarity_score`. Index is lazy and invalidated on every KB mutation. *(done — SQLite/FTS5 adapter remains for §3 scale)*
- [x] **[P1 · M] Reranking (LLM-based)** — optional `rerank` toggle (config `rerank_enabled`, per-request `rerank` boolean, default off). When enabled the pool is widened to ~20 candidates, the selected chat model reranks them ("reply ONLY with a JSON array of indices"), and the top-k is sliced after rerank. Parser tolerates prose/fences/`{indices:[…]}` and falls back to the original order on any failure — a bad model reply can never lose candidates. *(done — a local cross-encoder remains an option)*
- [x] **[P1 · M] Query rewriting / expansion** — optional `query_expansion` toggle (default off). The model produces up to 2 paraphrases; each is embedded and searched, then the per-query pools are deduped (best similarity per chunk kept) and re-ranked by score. Original question always runs first; empty/duplicate/oversized paraphrases are dropped; embed failures on an extra paraphrase just skip that query. *(done — multi-part decomposition left as future work)*
- [x] **[P0 · S] Honest "I don't know"** — when nothing clears the similarity threshold, the query now injects an honesty system-prompt and the UI shows a "No relevant context found" banner (also for embedding errors). *(done; remaining: a "Not in your KB — ask me to add it?" click-to-ingest action in the chat)*
- [x] **[P0 · S] Metadata filters** — search scoped to chosen **documents** (multi-select in Retrieval settings, `filter_docs` on `/api/query`) and/or a **source** substring (`filter_source`, e.g. `File:` vs `Web:`); enforced inside both vector and hybrid search so excluded docs can never surface. Applied filters are echoed in every response's `retrieval_settings`. *(done — per-source numeric weights and tag/date facets remain)*
- [x] **[P2 · M] HyDE** — optional `hyde` toggle (default off). The model writes a short hypothetical passage that would answer the question; that passage (not the raw query) is embedded and used for retrieval (in hybrid mode the BM25 keyword side keeps the original wording). The generated passage is echoed back as `hyde_passage` so it is never invisible to the user. *(done — P2 completed ahead of schedule)*

### 2.3 Context window management (P0 · M)
- [x] **Token budget enforcement** — `/api/query` reads the model's context length via `ollama show` (fallback 4096 tokens when unknown), reserves ~70%, subtracts conversation history + query overhead, then keeps top matches (sorted by similarity) until the budget is full; if even the top match can't fit it is truncated with a visible marker. Reported to the UI as `context_budget.model_context_tokens / dropped_sources` in every response. *(done — remaining: per-model-family prompt templates)*
- [x] **Prompt templates per model family** — `lib/prompts.js` detects the family from the model name (Llama, Qwen, Gemma, Mistral, DeepSeek, Phi, GPT; namespace-aware, unknown → neutral default) and the RAG system prompt is assembled from family-specific instruction templates with the Simple-mode **detail level** (concise/balanced/detailed, §1.3) applied on top. Every response echoes `prompt_family` + `retrieval_settings.detail`. Ollama's Modelfile still owns the low-level chat-template wrapping. *(done — UI detail dropdown + mode switch ship with §1.3)*

### 2.4 Conversational RAG (P1 · M)
- [x] **Multi-turn memory**: chat history is tracked per conversation and sent to `/api/query` (client keeps last 12 messages; server validates roles — only `user`/`assistant`, no system-prompt injection — clamps to the most recent 12, caps per-message length, and places history after any RAG system prompt so follow-ups like "and what about its price?" stay in context). "🧹 New Chat" button clears the conversation + memory. *(done — remaining: query *rewriting* of follow-ups, memory-window slider, per-turn token usage)*
- [x] **Streaming responses** (SSE token-by-token) with a Stop button. *(done — see §7/chat streaming)*
- Sources always clickable/expandable; answer sentences mapped to source chunks where possible (grounded-citation view). *(sources accordion done; per-sentence grounding open)*

### 2.5 RAG evaluation harness (P1 · L — what separates demos from products)
- Built-in **"Test my knowledge base"** wizard: user pastes 10–20 Q&A pairs (or imports from CSV/JSONL), the app measures **hit-rate, MRR, answer-accuracy, hallucination rate** and shows which questions *fail* and why (retrieval miss vs. generation error).
- Suggested experiment A/B: current settings vs. hybrid search vs. reranking — show the scoreboard.
- Ingestion quality report: empty/low-content chunks, near-duplicates, OCR-garbage detection, language mix.

### 2.6 Ingestion breadth (P1 · L)
- Formats: `.docx`, `.pptx`, `.xlsx`, `.csv`, `.epub`, `.html` file, images-with-OCR (vision model or tesseract), and whole-**folder/zip** upload.
- URL: real scraper (readability extraction, strip nav/ads), optional recursion depth + sitemap import, scheduled re-scrape ("keep this URL fresh daily").
- Connectors (P2): Google Drive, Notion, Confluence, Obsidian vault, GitHub repo, YouTube transcript.

---

## 3. 🗄️ Storage & Vector Database (scale without pain)

- [ ] **[P1 · L] Abstract `VectorStore` behind an interface** and ship two adapters:
  - `json` (current) — kept only as a dev/demo fallback;
  - `sqlite` — SQLite + FTS5 for BM25 hybrid search + a vector column/index (via `sqlite-vec` or a sidecar HNSW file). No server process, still one-file portable, crash-safe with WAL.
- [ ] **[P1 · M] Store original documents** (sources) alongside chunks → enables re-chunking, source listing, export, and "update this doc" without re-upload.
- [ ] **[P1 · M] Incremental & atomic persistence** — append/transactional writes instead of rewriting the whole KB JSON on every batch; no lost updates between two tabs.
- [ ] **[P2 · M] Optional memory cap** — chunk/embedding budget per KB with compaction (merge tiny chunks, drop near-dup vectors).

---

## 4. 🤖 "Create Your Own AI" — the beginner product moment

Today `POST /api/export-ollama-model` just bakes the whole KB into a giant system prompt — fine for tiny KBs, breaks past a few hundred KB, and is buried in the sidebar. Turn it into a guided, delightful flow:

### 4.1 Model Forge wizard (P0 · L)
- [x] **Builder card v1** — name your AI (validated), optional custom rules/instructions textarea, live fit-status line (auto-refreshes on model/rules/KB changes), honest pre-build warning, richer success message with the `ollama run <name>` command, empty-KB guard, model-name sanitization+validation, KB stats in the completion message. *(done — full step-by-step modal wizard still open)*
1. **Pick a brain** — base model cards with plain-language strength descriptions + size ("fastest", "best quality", "good balance"), searchable, `ollama pull` offered inline for anything not installed.
2. **Name & face it** — name, tagline, avatar/emoji; the name becomes `ollama run <name>`.
3. **Teach it** — choose the knowledge source (entire KB or pick documents), add "Rules it must follow" (system-prompt builder with templates: Support Agent, Study Buddy, Code Mentor, Chef, …).
4. **Preview** — live chat-test with the *actual* settings before building; show projected size and whether the KB fits the context window.
5. **Build & share** — progress stream (reuse existing NDJSON), then success screen: "✨ Your AI `menu-bot` is ready!" with a terminal command to copy, a QR code, and **Export this AI** (see §5).

### 4.2 Smart standalone-model construction (P0 · M)
- [x] **Fit analysis (v1)** — the builder warns *before and during* the build when the KB won't fit the base model's context window: live `POST /api/kb/analyze-fit` verdict shown in the sidebar card ("✅ fits / ⚠️ too large / context unknown"), plus an in-stream warning during the build itself. *(done — remaining: automatic compact/split/RAG-pack modes)*
- Fix the "entire KB in the system prompt" approach:
  - **Fit analysis**: warn/block when KB exceeds model context; offer automatic modes:
    - *Compact mode* — auto-distill the KB into a condensed knowledge brief that fits the context window;
    - *Split mode* — build N focused models ("menu-bot-part1/2");
    - *RAG-pack mode* (recommended) — create a *paired* deliverable: base model + bundled vector KB that the app can rehydrate on any device (see §5), giving the "standalone" feel without stuffing.
- Save a **history of created models** (name, base, date, sources used, custom rules) with re-build and delete.

### 4.3 Model manager (P1 · M)
- Settings → show installed models with real sizes from disk, safe delete with confirmation + undo grace, pull progress, and **import/export model cards**.

---

## 5. 📦 Knowledge Export / Import & Cross-Device Portability — *your explicit ask*

**Goal: "Take my AI's brain from this laptop to my friend's PC / my work machine in under a minute, no cables, no terminal."**

### 5.1 The portable bundle format — `.raganyllm` pack (P0 · M)
- [x] **v1 format shipped** *(single versioned JSON file — ZIP container deferred)*: `{ format: 'raganyllm-pack', version: 1, kind: 'knowledge', created_at, stats, settings.embedding_model, knowledge: { chunks[]: {id, doc_title, content, source, chunk_index}, embeddings?[] } }`. Default exports **include embeddings** (instant, offline import); `?embeddings=0` / compact export stores text only and re-learns on import. *(done — implemented 2026-09-09)*
- [x] **ZIP container (v2)** — exports are now real ZIP files (deflated, `adm-zip`): `manifest.json` (schema, kind, counts, **per-entry sha-256 checksums**), `knowledge/chunks.jsonl`, `knowledge/embeddings.jsonl` (aligned rows), `settings.json` and `ai/model-card.json`. Imports verify checksums, reject anything outside the fixed entry allowlist (no zip-slip), and auto-detect every legacy form — v1 JSON, encrypted v1, and encrypted v2 (AES-GCM over the ZIP bytes). Legacy export stays available via `zip=0` / `{zip:false}`. *(done — `documents.jsonl` for full original docs comes with the §3 original-documents work)*

```
menu-bot.raganyllm            (future: ZIP)
├── manifest.json             # schema version, app version, created-at, counts, sha-256 of every entry
├── knowledge/
│   ├── documents.jsonl       # full original docs + metadata (title, source, URL, tags, ingested-at)
│   └── chunks.jsonl          # chunk text, doc ref, chunk_index, heading path
├── settings.json             # embedding model, default chat model, chunk params, threshold, top-k
├── ai/
│   ├── model-card.json       # any custom AIs built from this KB (name, base, rules, avatar)
│   └── modelfiles/           # generated Modelfiles (text)
└── embeddings/               # OPTIONAL: keeps import instant but larger
    └── vectors.npy           # row order == chunks.jsonl
```

- [x] **Two export flavors** in the UI:
  - **💾 Knowledge Pack** — documents + chunks + settings (embeddings optional). Small, human-readable, re-embeds on import. *(done — ⬆ Export KB)*
  - **🤖 AI Pack** — Knowledge Pack + the custom-AI definitions (name, base model, rules, build stats) so the recipient gets your finished assistant, not just raw knowledge. *(done — 🤖 Export AI Pack button; Model Forge now keeps a persistent `raganyllm-ais.json` registry; imports register the AIs and they can be **⟳ Rebuilt** from the recipient's current KB — rebuilt AIs travel forward in the next export. Packs store definitions, not Modelfile text, so a rebuilt AI reflects the current knowledge base.)*
- [x] **Encrypt option** — optional password protection on pack export (AES-256-GCM + scrypt key derivation, `raganyllm-pack-enc` wrapper, no plaintext leak in the file). Import detects the wrapper and asks for the password; wrong password / tampered file produces a friendly error and changes nothing. *(done — UI: 🔒 password inputs beside Export/Import KB)*

### 5.2 One-click flows everywhere (P0 · S)
- [x] **Export & Import buttons in the Knowledge Base card** — one-click download of `raganyllm-kb-YYYY-MM-DD.raganyllm` and pick-a-file import with live progress bar. *(done)*
- [x] **Header toolbar Import/Export + drag & drop** — ⬆ Export KB and ⬇ Import Pack buttons live in the chat header; dropping a `.raganyllm`/`.json` pack anywhere in the window opens the import preview (files are forwarded to the same preview-then-import flow).
- [x] **Import mode picker (Merge / Replace)** — merge dedupes by content hash; replace warns first. *(done)*
- [x] **Validation on import** — schema/version check, per-chunk content validation, all-or-nothing (nothing changes if any chunk is invalid); friendly plain-language errors. *(done — incl. encrypted-pack password prompt)*
- [x] **Preview card before import** — selecting/dropping a pack calls `POST /api/kb/preview` (read-only decode; works for encrypted packs given the password) and shows a card: kind (🤖 AI vs 📦 knowledge), document/chunk counts, doc titles, embedding status, and the custom AIs inside — with explicit **⬇ Import now** / **✖ Discard**. Replace mode already auto-backs-up first. *(done)*
- [x] **Post-import wizard** — AI-pack imports report `missing_models` (base models absent from this device's `/api/tags`); the UI offers **⬇ Download now** per model via `POST /api/ollama/pull` (NDJSON passthrough with progress), then ⟳ Rebuild in Model Forge. *(done — embedding-model case is covered at import time: compact packs re-embed through Ollama or fail with a clear message)*

### 5.3 CLI parity (P1 · S)
- [x] **`raganyllm export` / `import` subcommands** — `bin/cli.js` dispatches on the first arg: `export [FILE] [--password …] [--no-embeddings]` (FILE defaults to `raganyllm-kb-YYYY-MM-DD.raganyllm`; default embeds-included, matching the GUI; `--no-embeddings` = compact) and `import FILE [--mode merge|replace] [--password …]` (replace auto-backs-up first; merge dedupes by content hash; embedding-less packs re-learn through Ollama, all-or-nothing on failure). `raganyllm` with no args still runs the interactive setup + server.
- [x] **Single pack codec** — `lib/pack.js` (encode/decode/normalize incl. AES-GCM encryption + scrypt) is now shared by the HTTP routes and the CLI, so packs are interchangeable both ways. *(`list packs` helper still open; `--with-embeddings` accepted as an alias of the default)*

### 5.4 Device-to-device transfer (P1 · M)
- [x] **LAN share** — "🔗 Share KB / Share AI Pack" in the KB panel mints an **auto-expiring, single-use** token and shows `http://<ip>:8000/packs/share/<token>` + a scannable QR code. No external service; tokens live in memory only (default 60 min, `RAGANYLLM_SHARE_TTL_MINUTES` to tune) and die on restart. Opening the link shows a summary page with a one-shot `.raganyllm` download; a raganyllm on the receiving computer pulls the pack **server-to-server** via its KB-panel **Import from link** (`POST /api/kb/import-link`), so the sender's KB is never mutated and the standard pack pipeline applies (merge/replace, password, duplicate-skip, AI registration). A short local cache per token lets a wrong password be retried without burning the sender's link. *(done — the browser-only case gets the downloadable pack + import instructions; the cloud-folder sync below remains open)*
- **Export to cloud folder** (P2): watch a folder (Dropbox/Google Drive/iCloud/Obsidian) → auto-sync pack on change; import picks newest.

### 5.5 Plain export formats (P1 · S)
- [x] **Markdown & JSONL exports** — `GET /api/kb/export/markdown` (readable, per-document headings) and `/api/kb/export/jsonl` (one chunk per line); both available as ⬇ buttons in the KB card. *(done)*
- [x] **CSV & pretty HTML report** — `GET /api/kb/export/csv` (RFC-4180 quoted, spreadsheet-friendly) and `GET /api/kb/export/report` (printable HTML: KB stats + one section per document with its chunks, HTML-escaped) as ⬇ buttons in the KB card.

### 5.6 Backup & restore (P1 · M)
- [x] **Auto-backups before destructive ops** — Clear KB and Replace-imports snapshot the previous KB first; rotating keep-last-10 in `<data-dir>/backups`. Manage-KB panel lists timestamped snapshots with one-click Restore (current state is auto-backed-up first so restores are undoable). *(done)*
- [x] **Scheduled auto-backups** — while the app runs, the KB is snapshotted whenever its file changes (default every 30 min, `RAGANYLLM_BACKUP_MINUTES` to tune; timer is unref'd and cleared on server close). No snapshot spam: unchanged KBs are skipped. *(re-chunk destructive-op hooks remain open — no re-chunk feature exists yet)*
- [x] **One-click "Back up to now"** snapshot button next to Export/Import KB. *(file-download backup = the existing ⬆ Export KB pack)*

---

## 6. 🖥️ Reliability, Security & Operations

- [x] **[P0 · M] Local-first security**: binds `127.0.0.1` (`HOST` env to open); same-origin API with an origin guard (403 for untrusted web pages; `cors` package removed); upload size/count limits (25 MB × 10 files, 200 MB pack, 25 MB JSON); LLM output sanitized via DOMPurify; delete-model verifies against `/api/tags` before deleting. *(done; ZIP packs additionally verify per-entry sha-256 + a fixed entry allowlist — see §5.1)*
- [ ] **[P1 · M] Optional LAN mode with PIN** — if the user enables "allow other devices", require a PIN shown in the app (covers 5.4's share without opening the whole API).
- [x] **[P1 · M] Tests** — `npm test` (`node --test`): unit (chunker, dedupe, load-heal, threshold gating, doc removal, BM25/hybrid recovery, config clamping + partial-update preservation) and integration against an in-process fake Ollama (models, config round-trip, vector-vs-hybrid queries, JSON + RAG-off role ordering + history, SSE streaming, origin guard, model-delete verification, pack export→clear→import→dedupe, per-doc delete, plain exports, samples, analyze-fit + build warning, ZIP-container codec (checksums/tamper/legacy), LAN-share round trip + expiry + single-use, first-run wizard setup endpoints (personas/completion/questions)). 73 tests passing. *(E2E browser flows still open)*
- [x] **[P1 · S] `engines` field** (`>=18`). *(done)*
- [x] **[P1 · S] CI + LICENSE** — `.github/workflows/ci.yml` runs `npm ci && npm test` on Node 18/20/22 for every push/PR; MIT `LICENSE` added. *(E2E browser flows still open — see §7)*
- [x] **[P1 · S] Logging & crash-proofing** — JSONL structured logs in `<data-dir>/logs` (rotating ~1 MB keep-5, in-memory ring via `GET /api/logs`, best-effort never-throws); key events (server start, KB imports, share mint/consume, query errors) are recorded. The UI survives Ollama dying mid-use: the traffic-light pill turns 🔴 with a reason, and any chat error renders the Error Doctor actions (check-again, Get Ollama, retry) instead of a dead chat. *(done — a dedicated top-of-screen "Reconnect" toast remains a §7 polish option)*
- [ ] **[P2 · M] Optional local telemetry** (opt-in, aggregate, never leaves device by default) so you can see which features noobs actually use.

---

## 7. 🎨 UI/UX upgrades (make it feel like a product, not a demo)

- [x] **[P0 · S] Chat streaming** — `/api/query` accepts `stream: true` and emits SSE events (`meta` → `token*` → `end`); the UI renders tokens live with a ⏹ Stop button and the server tolerates client disconnects. *(done — remaining from the broader chat-quality bullet: code-block copy buttons, message actions, LaTeX/tables polish)*
- [x] **[P1 · S] KB explorer (v1)**: document list now shows per-doc chunk counts with a 🗑️ delete button (`POST /api/kb/delete-doc`, removes all chunks of that doc, dedupe index kept in sync). *(remaining: preview/update-per-doc, per-doc re-embed, tags)*
- [ ] **[P1 · S] Conversation sidebar**: multiple chats, rename, clear, export chat as Markdown.
- [ ] **[P1 · S] Responsive + accessible**: keyboard nav, ARIA labels on the modal/accordions, focus traps, larger hit targets.
- [ ] **[P2 · S] Theme + i18n**: dark/light/system; begin with EN/HI/etc. tooltip layer given the tool's audience.

---

## 8. 🧩 API & Platform surface (grow beyond the GUI)

- [ ] **[P1 · M] Stable documented HTTP API** + OpenAPI spec; version prefix (`/api/v1`).
- [ ] **[P1 · M] Richer CLI** — `raganyllm chat "ask…"`, `raganyllm ask --doc file.pdf`, `raganyllm serve --headless`.
- [ ] **[P2 · M] Library mode** — `const { RAG } = require('raganyllm')` so developers embed the engine in their own apps (this is what turns a nice tool into a platform).

---

## 9. 📦 Recommended delivery milestones

| Milestone | Scope | Outcome |
|---|---|---|
| **M1 — "Noob-safe v1.1"** ✅ *shipped* | threshold, storage home, sanitize XSS, bind localhost, dedupe, drop fake seed KB | Safe foundation |
| **M2 — "Noob can do it"** *(in progress)* | KB pack export/import ✅ · chat streaming + Stop ✅ · friendly error hints ✅ (partial Error Doctor) · honest don't-know ✅ · First-run wizard · plain-language pass · modes | The headline promise works: noob → RAG → own AI → moves it to another device |
| **M3 — "RAG that works"** | hybrid search, reranking, smart chunking, token budgeting, multi-turn, Model Forge v1, fit-analysis | Measurable retrieval quality + real "create your AI" moment |
| **M4 — "Product"** | SQLite vector store, eval harness, tests/CI, CLI parity, LAN share, backups, connectors | Production-ready for a real user base |

---

## 10. 🎬 The north-star story this roadmap enables

> **Priya** (no tech background) downloads the app. The wizard checks her PC, installs what's missing, and asks what her AI is for. She says **"My restaurant's menu assistant"**, drags in 3 PDFs (menu, prices, allergy sheet) and pastes her website FAQ link. The app cuts them up, teaches itself, and immediately shows her sample questions. She chats with it — *"Which dishes are vegan?"* — sees the answer cite her own menu, clicks **"Create my AI"**, names it **`priya-menu-bot`**, picks a chef emoji avatar and rules ("never invent prices"), tests it in the preview, and builds it.
>
> At home that evening she clicks **Export**, saves `priya-menu-bot.raganyllm`, and sends it to her business partner. On their laptop, one drag-and-drop → validation → "this pack needs a small helper, download now?" → done. Same AI, same knowledge, same answers — no terminal, no config, no tutorials required.

---

*Generated as a living document — check items off as they ship, and treat §0 as the gate for everything else.*
