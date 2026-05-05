# MAPLE M3 — Design Doc Reconciliation

**Module:** M3: Campus Services & Student Life Navigator  
**First Version Design Doc:** [v1-design-doc.md](./v1-design-doc.md)  
**Updated Design Doc:** [MAPLE_M3 Project Design Doc.md](./MAPLE_M3%20Project%20Design%20Doc.md)  
**Milestone:** Final Project Submission — Spring 2026

This document traces every significant decision from the original design doc through the updated design doc and into the final implemented MVP. For each area, it records what was originally planned, what changed (and when), and the rationale behind each evolution. Items are rated as **Confirmed**, **Evolved**, or **Descoped**.

---

## System Architecture

### Frontend & Backend Stack — Confirmed

**Original:** Angular frontend, Node.js/Express backend, separated as `/client` and `/server`.  
**Implemented:** Identical. Angular 21 standalone components in `client/src/app/`, Express routes and controllers in `server/src/`.

### Database — Confirmed

**Original:** PostgreSQL + `pgvector` as a combined relational and vector store.  
**Implemented:** Identical. `Documents` and `DocumentEmbeddings` tables for RAG; `ChatHistory` and `Users` for relational data.

### Data Model — Evolved

**Original:** The original design doc included a dedicated `CampusEvents` relational table for structured event data, separate from the `Documents` knowledge base.

**Updated & Implemented:** A `CampusEvents` table was never created. Campus events are ingested as text chunks into the `Documents` table with `source_type = 'Events'`, just like all other data domains. The `/status` endpoint queries `Documents` with a `source_type = 'Events'` filter.

**Rationale:** Creating a separate relational table for events would require a custom scraping schema that maps parsed event fields to table columns. The chunk-based approach is simpler to maintain, already supports the required metadata fields (`title`, `location`, `start_time`), and is consistent with how all other domains are handled. The `ChatHistory` table also received a new `conversation_id` column (absent from the original schema) to support multi-turn context retrieval.

### Deployment Target — Evolved

**Original:** DigitalOcean App Platform with managed PostgreSQL and HTTPS at `m3.maristchat.com`.  
**Implemented:** The application runs locally. The backend (`server/`) and frontend (`client/`) are both started on the local machine. Secrets are managed via a local `.env` file (gitignored); `.env.example` is provided as the template.

### Infrastructure Cost — Evolved

**Original:** Estimated ~$50/month assuming cloud-hosted frontier model and OpenAI embeddings.  
**Implemented:** $0/month. By running entirely locally and using the campus NVIDIA DGX Spark (via Ollama) for both generation (`llama3.1:8b`) and embeddings (`nomic-embed-text`), there are no cloud compute or AI API costs.

---

## AI Models

### Generative LLM — Evolved

**Original:** Cloud-based frontier model via API (provider TBD; Claude or GPT-4o cited as examples), chosen specifically for reasoning capabilities, large context window, and temporal reasoning.

**Updated & Implemented:** Local model (`llama3.1:8b`) via Ollama on the campus NVIDIA DGX Spark as the primary path (`USE_LOCAL_MODEL=true`). OpenAI (`gpt-4o-mini`) is retained as a configurable fallback via the `USE_LOCAL_MODEL` environment variable toggle.

**Rationale:** Running inference on the DGX Spark eliminates per-token API costs and latency variability from external providers. The `llm.js` service wrapper supports both providers with identical retry, timeout, and logging behavior. Switching between them requires no code changes. The tradeoff (slightly weaker reasoning vs. frontier models) is acceptable at the pilot scale where query complexity is bounded.

### Embedding Model — Evolved

**Original:** OpenAI `text-embedding-3-small` (1536 dimensions).  
**Updated & Implemented:** `nomic-embed-text` via Ollama (768 dimensions) as the primary path. OpenAI `text-embedding-3-small` retained as fallback. Vector dimension is set at DB init time via `USE_LOCAL_MODEL`; switching requires `RESET_DB=true` and re-running `init.js`.

**Rationale:** Same motivation as the LLM change. It eliminates embedding API costs entirely while maintaining high semantic quality.

### Vector Store — Confirmed

**Original & Implemented:** PostgreSQL with `pgvector`. Cosine similarity (`<=>` operator). `pg.Pool` for concurrent-safe access (upgraded from the original `pg.Client` assumption).

---

## API Design

### `/api/v1/campus/chat` — Confirmed (with additions)

**Original:** `POST`, accepts `message`, `conversation_id`, `context`. Returns `response`, `sources`, `confidence`, `conversation_id` in MAPLE envelope.  
**Implemented:** Identical contract. The following were added beyond the original spec:

- **Conversation history injection:** When `conversation_id` is present, the last 5 turns from `ChatHistory` are loaded and prepended to the LLM `messages[]` array. The original doc described `ChatHistory` as storage for "history and context-aware follow-up questions" but did not specify how history would be re-injected.
- **Dining path (DB-first + fallback):** Dining-related queries are routed to Dining retrieval first (`source_type='Dining'`), with hardcoded fallback only if retrieval returns no dining chunks (see Dining section below).
- **Confidence scoring:** Computed from the top retrieval score: ≥0.75 = `"high"`, ≥0.60 = `"medium"`, below = `"low"`, retrieval failure = `"none"`.

### `/api/v1/campus/status` — Evolved

**Original:** Returns real-time status updates and events. Response shape included `id`, `event`, `location`, `status` fields. No error handling specified.  
**Implemented:** Reads from `Documents` (`source_type = 'Events'`) rather than a `CampusEvents` table. Response fields are `title`, `location`, `start_time`, `category`. Added `?date=YYYY-MM-DD` query parameter for filtering. Added `VALIDATION_ERROR` (400) for malformed date parameters; raw DB error messages are not exposed to clients.

### `/api/v1/campus/ingest` — Evolved

**Original:** Accepts `sourceUrl` and `type` fields; designed as a general-purpose ingestion trigger for any URL and content type. No authentication specified.  
**Updated & Implemented:** Uses controlled batch triggering instead of arbitrary URL ingestion. The endpoint accepts `batch` (`daily`, `weekly`, `monthly`), with a legacy fallback where `source_type: "Admin"` maps to the `weekly` batch. Added `Authorization: Bearer <ADMIN_TOKEN>` header requirement — absent header returns 401 `UNAUTHORIZED`, wrong token returns 403 `FORBIDDEN`. Triggers `data/scripts/run-ingestion-batch.js` asynchronously and returns 202 with a `jobId` and selected `batch`.

**Rationale:** The original `/ingest` design implied an arbitrary URL ingestion endpoint, which would be a significant attack surface and require robust sandboxing. Restricting ingestion to predefined internal batches is safer and better aligned with routine operations. Adding Bearer token auth was necessary since the endpoint triggers active server-side processes.

---

## Data Pipeline

### Embedding & Chunking — Confirmed

**Original & Implemented:**
- Structured data (offices, hours): one-record-per-chunk
- Text-heavy data (IT FAQs, news): ~400-word chunks with ~10% overlap
- Mandatory metadata: `source_title`, `source_url`, `source_type`, `last_updated`, `chunk_index`

### Similarity Threshold — Evolved

**Original:** Strict `0.70` cosine similarity threshold enforced throughout — retrieval, system prompt guardrails, and hallucination handling all referenced this value.

**Updated & Implemented:** The official final threshold is `0.55`. Below-threshold queries bypass the LLM and return `RETRIEVAL_FAILED` (422).

**Rationale:** Validation runs against administrative office queries (e.g., Registrar, Financial Aid lookups) produced false negatives at `0.70` — valid documents were excluded because office descriptions use formal institutional language that embeds farther from colloquial student query phrasing. Lowering to `0.55` recovered these queries without meaningfully degrading precision on other domains. The threshold is a named constant in `retrieval.js`.

**Difference Snapshot:**
- `Original design doc`: `0.70` (strict baseline)
- `Final design doc`: `0.55` (official production threshold)
- `Implemented code`: `SIMILARITY_THRESHOLD = 0.55` in `server/src/services/retrieval.js`

### Dining Data — Evolved (Major Change)

**Original:** Daily Playwright scraping of `dineoncampus.com` to intercept JSON API responses for both dining hours and menus. Treated as the highest-volatility domain alongside campus events.

**Updated & Implemented:** Dining uses a hybrid approach:
- **Primary path (DB-first):** `data/scripts/dining-manual.js` ingests dining content into `Documents` / `DocumentEmbeddings` with `source_type='Dining'`, and `/chat` routes dining intents to retrieval first.
- **Fallback path:** If retrieval returns zero dining chunks, the controller uses `server/src/utils/dining.js` to return a hardcoded response with live links and a freshness warning.

**Rationale:** The `dineoncampus.com` platform is protected by Cloudflare's bot detection layer, which blocks reliable live scraping. Manual ingestion provides a retrievable Dining index for normal RAG behavior, while hardcoded fallback guarantees graceful handling when Dining retrieval is empty.

### IT Help Desk Source — Evolved

**Original:** Planned to scrape `marist.edu/helpdesk` using Cheerio, targeting accordion FAQ components.  
**Updated & Implemented:** Actual source is `teamdynamix.marist.edu/TDClient/92/Portal/KB/` (the TeamDynamix Knowledge Base portal), which hosts the IT FAQ content in a different structure than the original URL. Scraping strategy updated accordingly.

### Club Directory Source — Evolved

**Original:** `marist.edu/student-life/involvement`  
**Updated & Implemented:** `marist.edu/clubs` (current URL for the club directory).

### Campus Events Source — Evolved

**Original:** `marist.edu/events` with Playwright/Cheerio targeting `.event-card` Localist components.  
**Updated & Implemented:** `marist.edu/daily-events` (specific daily events URL). Parser updated to match actual page structure.

### News Source — Evolved

**Original:** Not listed in the original design doc's data source table.  
**Updated & Implemented:** Added `maristcircle.com` as a news source with Playwright scraping.

### Automated CRON Scheduling — Evolved

**Original:** Scheduled CRON jobs for daily re-ingestion of dining and events data, described as essential for data freshness.

**Implemented:** Batch automation is defined via `data/scripts/run-ingestion-batch.js` and documented scheduler entries in `data/scripts/cron-schedule.md`. Daily scheduling includes both Dining (`dining-manual.js`) and Events ingestion paths.

**Rationale:** High-volatility sources (Dining + Events) are grouped into the daily batch to keep freshness aligned with student-facing usage patterns.

---

## AI Integration

### RAG Architecture — Confirmed

**Original & Implemented:** Metadata-based pre-filtering via keyword classifier before vector search. Queries are tagged with a `source_type` domain filter to isolate the search to relevant data. Top-5 chunks retrieved. LLM bypassed entirely when retrieval fails.

### Conversation Memory — Evolved

**Original:** `ChatHistory` described as a persistence table for "context-aware follow-up questions." The mechanism for re-injecting history was not specified.

**Updated & Implemented:** On each `/chat` request that includes a `conversation_id`, the controller queries `ChatHistory` for the last 5 turns (`ORDER BY timestamp ASC LIMIT 5`) and prepends them as alternating `user`/`assistant` message objects to the LLM call. The cap of 5 prior turns was chosen to stay within the context window budget while covering the typical depth of a student session. History fetch failures degrade gracefully — the request continues without history rather than returning an error.

### LLM Wrapper Service — Confirmed

**Original & Implemented:** `services/llm.js` — single entry point for all LLM calls. Enforces 30-second timeout, exponential backoff retries (up to 2 retries), token usage tracking, cost estimation, and structured JSON logging per call. 4xx errors skip retries immediately.

### System Prompt — Evolved (threshold + numeric citations)

**Original:** Version-controlled in `prompts/system/`. Injects `[Injected System Timestamp]` for temporal reasoning. References `0.70` threshold in guardrails. The design doc excerpt described narrative citations (e.g., `[Source: Dining Hall Schedule]`) rather than numeric bracket refs.

**Updated & Implemented:** Loaded dynamically per request (live file read, no restart required). Timestamp injected via `{{CURRENT_TIMESTAMP}}`. Threshold guardrail uses the official final `0.55` value. **Citation format:** RETRIEVED CONTEXT blocks are prefixed with `[1]`, `[2]`, … in `server/src/controllers/chat.js` (same order as the response `sources` array). `prompts/system/main-system-prompt.md` instructs the model to cite with bracketed numbers in Markdown that match those labels and the API sources order. The Angular client linkifies `[n]` in assistant replies and shows a collapsible numbered Sources list with matching anchor IDs.

**Rationale:** Numeric citations align the LLM’s answer text, the retrieval context, and the structured `sources` payload so the UI can offer footnote-style scanning without ambiguous title-only references.

---

## Security

### Secrets Management — Confirmed

**Original & Implemented:** All secrets in environment variables. `.env` gitignored. `.env.example` with placeholder values committed.

### CORS — Confirmed

**Original & Implemented:** Strict allowlist via `ALLOWED_ORIGINS` env var. No wildcard `*` in production.

### Rate Limiting — Confirmed

**Original & Implemented:** 30 req/min per IP on `/chat`. MAPLE-compliant 429 `RATE_LIMITED` envelope on violation.

### `/ingest` Authentication — Evolved (Addition)

**Original:** No authentication specified for `/ingest`.  
**Implemented:** Bearer token guard added (`requireAdminToken` middleware). Token sourced from `ADMIN_TOKEN` env var.

---

## Observability

### Structured JSON Logging — Confirmed (with extensions)

**Original:** Required `latency_ms`, `input_tokens`, `output_tokens`, `threshold_applied` fields per MAPLE Architecture Guide.

**Implemented:** Both LLM calls and retrieval operations produce structured JSON events via `server/src/utils/logger.js`, written to daily rotating `logs/maple-m3-YYYY-MM-DD.log` files. Retrieval logs were extended beyond the original spec to also include `model` (embedding model name), `latency_ms`, `success`, and `error`, matching the LLM log schema for consistent queryability.

---

## Evaluation

### Smoke Tests — Evolved (Addition)

**Original:** Golden dataset evaluation (precision/recall, faithfulness, relevance) using an LLM-as-a-judge pipeline.

**Updated & Implemented:** Golden dataset scoring is now primarily heuristic in `eval/scripts/run-golden-eval.js` (contract checks + deterministic relevance/faithfulness rules), with optional LLM judging retained as a non-default path.

**Rationale:** Heuristic scoring is deterministic, reproducible in local/offline workflows, and aligns with our current zero-cost local runtime constraints.

**Added:** `server/tests/smoke.js` — a lightweight endpoint-level test suite covering all routes and error paths (missing auth, invalid inputs, wrong tokens, valid requests). Runnable against any environment via `BASE_URL` and `ADMIN_TOKEN` env vars.

### User Evaluation — Confirmed

**Original & Implemented:** "Guerrilla testing" — 3-minute hallway tests with 5–10 classmates. Single-task prompts. Frictionless feedback via Google Form linked in the UI footer.

---

## Summary Table

| Area | Status | Original Plan | Final Implementation |
|---|---|---|---|
| Frontend/backend stack | ✅ Confirmed | Angular + Node.js/Express | Identical |
| PostgreSQL + pgvector | ✅ Confirmed | Single DB for relational + vector | Identical |
| CampusEvents table | ⚠️ Evolved | Dedicated relational table | Events stored in Documents table with `source_type='Events'` |
| LLM provider | ⚠️ Evolved | Cloud frontier model (Claude/GPT-4o) | Local Ollama (`llama3.1:8b`); OpenAI as fallback |
| Embedding model | ⚠️ Evolved | OpenAI `text-embedding-3-small` | `nomic-embed-text` via Ollama; OpenAI as fallback |
| Infrastructure cost | ⚠️ Evolved | ~$50/month | $0/month (local-only runtime on campus/local infrastructure) |
| Retrieval threshold | ⚠️ Evolved | 0.70 strict | 0.55 official final threshold |
| Dining data | ⚠️ Evolved | Daily Playwright scraping | Daily scheduled `dining-manual.js` ingestion + hardcoded fallback when retrieval has no Dining chunks |
| Conversation memory | ⚠️ Evolved | Table described, mechanism unspecified | Last 5 turns injected into LLM message array |
| `/ingest` auth | ⚠️ Evolved | None specified | Bearer token (`ADMIN_TOKEN`) required |
| `/ingest` scope | ⚠️ Evolved | General-purpose URL ingestion | Controlled batch trigger (`daily` / `weekly` / `monthly`) with legacy `source_type: "Admin"` fallback |
| `/status` data source | ⚠️ Evolved | `CampusEvents` table | `Documents` table filtered by `source_type='Events'` |
| Observability logs | ⚠️ Evolved | LLM fields only specified | Extended to retrieval logs with matching schema |
| CRON scheduling | ⚠️ Evolved | Daily automated re-ingestion | Batch runner + documented Task Scheduler/cron automation (`daily`, `weekly`, `monthly`) |
| Dietary restriction detail | ❌ Descoped | Stretch goal | Blocked by Cloudflare; menu link redirect provided |
| Shuttle/laundry availability | ❌ Descoped | Stretch goal | Requires real-time integrations out of scope |
| Smoke test suite | ⚠️ Evolved (Addition) | Not planned | `server/tests/smoke.js` added |
| Answer citations & sources UI | ⚠️ Evolved (Addition) | Narrative `[Source: …]` style in early design excerpt | Numbered `[1]`, `[2]` citations in prompt + context injection; collapsible numbered Sources in Angular with in-answer links |

---

## Lessons Learned

There are a few changes we would make to our design document knowing what we know now.

### Specify the AI model and infrastructure from the start

The original design doc left the LLM provider as "TBD (Claude or GPT-4o)" with a ~$50/month cloud cost estimate. In reality, we knew there was a high probability of gaining access to the campus NVIDIA DGX Spark running Ollama from day one. If we had known to account for that resource up front, the design doc would have specified `llama3.1:8b` for generation and `nomic-embed-text` for embeddings as the primary path, with OpenAI only as a documented fallback. That would have avoided the mid-project embedding dimension mismatch (1536 → 768) that required a DB reset, and it would have framed the cost model correctly from the beginning ($0 local vs. $50/month cloud).

### Default the evaluation strategy to heuristic, not LLM-as-a-judge

The original design doc described a golden-dataset evaluation pipeline using an LLM judge to score faithfulness and relevance. Once we migrated to a local model on the DGX Spark, using that same model as a judge for its own outputs introduced a circular dependency and produced inconsistent scores. Switching to heuristic evaluation in `eval/scripts/run-golden-eval.js` resolved both problems: scores became reproducible, and the pipeline ran entirely offline with no additional API cost or token budget.

In hindsight, the design doc should have defaulted to heuristic scoring and treated LLM-as-a-judge as an optional, clearly flagged enhancement rather than the primary path. Deterministic evaluation is easier to debug, faster to run in CI, and does not have a dependency on model quality or availability.

### Plan for Cloudflare-protected sources before committing to scraping them

The dining data plan assumed daily Playwright scraping of `dineoncampus.com`. We discovered during implementation that the platform is protected by Cloudflare's bot-detection layer, which reliably blocks automated scraping. The fallback, a hardcoded response with live links and a freshness warning, is serviceable but it means dining information is only as fresh as the last manual ingestion run.

If the design doc had included a step to audit each data source for scraping feasibility before writing the pipeline spec, we would have scoped dining differently from the start: as a redirect-only domain. The same audit would have caught the `dineoncampus.com` Cloudflare wall before we spent time writing a scraper that could not be used in production.
