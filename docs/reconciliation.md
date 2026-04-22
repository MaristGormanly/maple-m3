# MAPLE M3 — Design Doc Reconciliation

**Module:** M3: Campus Services & Student Life Navigator  
**Design Doc:** [MAPLE_M3 Project Design Doc.md](./MAPLE_M3%20Project%20Design%20Doc.md)  
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

### Deployment Target — Confirmed

**Original:** DigitalOcean App Platform with managed PostgreSQL and HTTPS at `m3.maristchat.com`.  
**Implemented:** Same target. Secrets managed via host environment variables; `.env` gitignored; `.env.example` provided.

### Infrastructure Cost — Evolved

**Original:** Estimated ~$50/month assuming cloud-hosted frontier model and OpenAI embeddings.  
**Updated & Implemented:** ~$25/month. By using the campus NVIDIA DGX Spark (via Ollama) for both generation (`llama3.1:8b`) and embeddings (`nomic-embed-text`), cloud AI costs drop to $0. Only App Platform compute ($10) and managed PostgreSQL ($15) remain.

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
- **Dining intercept:** Dining-related queries are short-circuited before the RAG pipeline and return hardcoded semester hours with live links (see Dining section below).
- **Confidence scoring:** Computed from the top retrieval score: ≥0.75 = `"high"`, ≥0.65 = `"medium"`, below = `"low"`, retrieval failure = `"none"`.

### `/api/v1/campus/status` — Evolved

**Original:** Returns real-time status updates and events. Response shape included `id`, `event`, `location`, `status` fields. No error handling specified.  
**Implemented:** Reads from `Documents` (`source_type = 'Events'`) rather than a `CampusEvents` table. Response fields are `title`, `location`, `start_time`, `category`. Added `?date=YYYY-MM-DD` query parameter for filtering. Added `VALIDATION_ERROR` (400) for malformed date parameters; raw DB error messages are not exposed to clients.

### `/api/v1/campus/ingest` — Evolved

**Original:** Accepts `sourceUrl` and `type` fields; designed as a general-purpose ingestion trigger for any URL and content type. No authentication specified.  
**Updated & Implemented:** Accepts `source_type` only (not a URL); scoped to `source_type: "Admin"` for the MVP. Added `Authorization: Bearer <ADMIN_TOKEN>` header requirement — absent header returns 401 `UNAUTHORIZED`, wrong token returns 403 `FORBIDDEN`. Triggers `data/scripts/admin-directory.js` asynchronously and returns 202 with a `jobId`.

**Rationale:** The original `/ingest` design implied an arbitrary URL ingestion endpoint, which would be a significant attack surface and require robust sandboxing. Scoping to a known internal script is safer and sufficient for the pilot. Adding Bearer token auth was necessary since the endpoint triggers an active server-side process.

---

## Data Pipeline

### Embedding & Chunking — Confirmed

**Original & Implemented:**
- Structured data (offices, hours): one-record-per-chunk
- Text-heavy data (IT FAQs, news): ~400-word chunks with ~10% overlap
- Mandatory metadata: `source_title`, `source_url`, `source_type`, `last_updated`, `chunk_index`

### Similarity Threshold — Evolved

**Original:** Strict `0.70` cosine similarity threshold enforced throughout — retrieval, system prompt guardrails, and hallucination handling all referenced this value.

**Updated & Implemented:** Active threshold is `0.55`. The `0.70` target is retained as a documented design baseline. Below-threshold queries bypass the LLM and return `RETRIEVAL_FAILED` (422) regardless of which threshold value is active.

**Rationale:** Initial validation runs against administrative office queries (e.g., Registrar, Financial Aid lookups) produced false negatives at `0.70` — valid documents were excluded because office descriptions use formal institutional language that embeds farther from colloquial student query phrasing. Lowering to `0.55` recovered these queries without meaningfully degrading precision on other domains. The threshold is a named constant in `retrieval.js` and can be recalibrated as the golden dataset expands.

### Dining Data — Evolved (Major Change)

**Original:** Daily Playwright scraping of `dineoncampus.com` to intercept JSON API responses for both dining hours and menus. Treated as the highest-volatility domain alongside campus events.

**Updated & Implemented:** Dining data is not ingested into the vector store. Instead, the chat controller intercepts dining-related queries before the RAG pipeline using a keyword classifier (`server/src/utils/dining.js`) and returns:
- **Hours queries:** Hardcoded typical semester hours for all 13 dining locations across 9 campus buildings, formatted as markdown tables, with a live link and a staleness warning.
- **Menu queries:** A redirect to the live `dineoncampus.com/marist/whats-on-the-menu` page.

**Rationale:** The `dineoncampus.com` platform is protected by Cloudflare's bot detection layer, which blocks headless browser requests regardless of wait strategy or user-agent spoofing. Scrapers consistently received Cloudflare challenge pages rather than dining content. The hardcoded approach trades daily freshness for 100% reliability. Semester-boundary hours changes (the only type that would invalidate hardcoded data for extended periods) can be updated manually in a single source file.

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

### Automated CRON Scheduling — Descoped

**Original:** Scheduled CRON jobs for daily re-ingestion of dining and events data, described as essential for data freshness.

**Implemented:** Ingestion scripts must be run manually. No scheduler is active in the deployed system.

**Rationale:** Dining data is now hardcoded, removing the need for daily dining re-ingestion. Campus events ingestion remains manual for the pilot. The `/ingest` API endpoint provides a programmatic trigger that can be wired to a scheduler in a future iteration without code changes.

---

## AI Integration

### RAG Architecture — ✅ Confirmed

**Original & Implemented:** Metadata-based pre-filtering via keyword classifier before vector search. Queries are tagged with a `source_type` domain filter to isolate the search to relevant data. Top-5 chunks retrieved. LLM bypassed entirely when retrieval fails.

### Conversation Memory — Evolved

**Original:** `ChatHistory` described as a persistence table for "context-aware follow-up questions." The mechanism for re-injecting history was not specified.

**Updated & Implemented:** On each `/chat` request that includes a `conversation_id`, the controller queries `ChatHistory` for the last 5 turns (`ORDER BY timestamp ASC LIMIT 5`) and prepends them as alternating `user`/`assistant` message objects to the LLM call. The cap of 5 prior turns was chosen to stay within the context window budget while covering the typical depth of a student session. History fetch failures degrade gracefully — the request continues without history rather than returning an error.

### LLM Wrapper Service — Confirmed

**Original & Implemented:** `services/llm.js` — single entry point for all LLM calls. Enforces 30-second timeout, exponential backoff retries (up to 2 retries), token usage tracking, cost estimation, and structured JSON logging per call. 4xx errors skip retries immediately.

### System Prompt — Confirmed (with threshold update)

**Original:** Version-controlled in `prompts/system/`. Injects `[Injected System Timestamp]` for temporal reasoning. References `0.70` threshold in guardrails.  
**Implemented:** Loaded dynamically per request (live file read, no restart required). Timestamp injected via `{{CURRENT_TIMESTAMP}}` placeholder. Threshold guardrail updated to `0.55` in active system prompt to match implementation.

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
| Infrastructure cost | ⚠️ Evolved | ~$50/month | ~$25/month (AI costs eliminated via DGX Spark) |
| Retrieval threshold | ⚠️ Evolved | 0.70 strict | 0.55 active; 0.70 retained as design baseline |
| Dining data | ⚠️ Evolved | Daily Playwright scraping | Hardcoded fallback + live links (Cloudflare blocks scraping) |
| Conversation memory | ⚠️ Evolved | Table described, mechanism unspecified | Last 5 turns injected into LLM message array |
| `/ingest` auth | ⚠️ Evolved | None specified | Bearer token (`ADMIN_TOKEN`) required |
| `/ingest` scope | ⚠️ Evolved | General-purpose URL ingestion | Scoped to `source_type: "Admin"` only |
| `/status` data source | ⚠️ Evolved | `CampusEvents` table | `Documents` table filtered by `source_type='Events'` |
| Observability logs | ⚠️ Evolved | LLM fields only specified | Extended to retrieval logs with matching schema |
| CRON scheduling | ❌ Descoped | Daily automated re-ingestion | Manual script execution |
| Dietary restriction detail | ❌ Descoped | Stretch goal | Blocked by Cloudflare; menu link redirect provided |
| Shuttle/laundry availability | ❌ Descoped | Stretch goal | Requires real-time integrations out of scope |
| Smoke test suite | ⚠️ Evolved (Addition) | Not planned | `server/tests/smoke.js` added |
