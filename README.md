# M3: MAPLE Campus Services & Student Life Navigator

The MAPLE Campus Services & Student Life Navigator is a conversational tool that helps students find information about dining services, library resources, health and wellness, recreation facilities, IT support, administrative offices, student clubs and organizations, campus events, and university news. It serves as an AI-powered gateway to campus engagement, unifying heavily siloed university data into a single conversational interface.

## Architecture Overview

This module utilizes a Retrieval-Augmented Generation (RAG) pipeline to dynamically provide the Large Language Model (LLM) with localized, up-to-date Marist College data. Queries are routed to a local NVIDIA DGX Spark running Ollama to ensure data privacy and eliminate cloud API costs.

* **Design doc:** [MAPLE M3 Project Design Doc](./docs/MAPLE-M3-Project-Design-Doc.md)
* **Architecture diagram (Mermaid):** [architecture-diagram.md](./docs/architecture-diagram.md)
* **API specification:** [api-spec.md](./docs/api-spec.md)
* **Design reconciliation:** [reconciliation.md](./docs/reconciliation.md)

## Tech Stack

* **Backend:** Node.js with Express
* **Frontend:** Angular 21 (standalone components)
* **Database:** PostgreSQL with `pgvector` extension
* **AI Models:** DGX Spark via Ollama (`llama3.1:8b` for generation, `nomic-embed-text` for embeddings)
* **Data Pipeline:** Playwright, Cheerio

## Setup & Running Locally

### 1. Prerequisites

* Node.js (v18+)
* PostgreSQL with the `pgvector` extension installed and running
* Access to the campus NVIDIA DGX Spark (via SSH tunnel or campus network)

### 2. Environment Configuration

Copy the environment template and fill in your database credentials and secrets:

```bash
cp .env.example .env
```

PowerShell equivalent (Windows):

```powershell
Copy-Item .env.example .env
```

Key variables to set:
* `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_PORT` — PostgreSQL connection
* `USE_LOCAL_MODEL` — `true` for DGX Spark (Ollama), `false` for OpenAI
* `OPENAI_API_KEY` — required if `USE_LOCAL_MODEL=false`
* `ALLOWED_ORIGINS` — comma-separated list of allowed frontend origins
* `ADMIN_TOKEN` — secret Bearer token required to call `POST /api/v1/campus/ingest`

Generate a strong `ADMIN_TOKEN` with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Initialize the Database

Run from the **repository root**. The script creates all relational tables and a `DocumentEmbeddings` column whose vector width matches `USE_LOCAL_MODEL` (768 dims for `nomic-embed-text`, 1536 dims for `text-embedding-3-small`).

```bash
node server/src/models/db/init.js
```

> **Note:** If you change `USE_LOCAL_MODEL` after the database is already initialized, set `RESET_DB=true` in `.env` and re-run `init.js` to rebuild `DocumentEmbeddings` with the correct dimension. This wipes all ingested data.

### 4. Populate the Vector Store

First, install the root-level dependencies (used by all ingestion scripts) and download the Playwright browser binaries:

```bash
# From the repository root
npm install
npx playwright install chromium
```

Each data domain has its own ingestion script in `data/scripts/`. Run all scripts from the **repository root** to scrape, chunk, embed, and store documents for that domain:

```bash
node data/scripts/admin-directory.js
node data/scripts/library.js
node data/scripts/campus-events.js
node data/scripts/clubs.js
node data/scripts/news.js
node data/scripts/health-services.js
node data/scripts/it-helpdesk.js
node data/scripts/gym-pool.js
node data/scripts/intramurals.js
node data/scripts/library-services.js
node data/scripts/dining-manual.js
node data/scripts/it-clientTech.js
```

Each script requires the database to be initialized (Step 3) and the embedding service (DGX Spark or OpenAI) to be reachable.

> **Note — Dining data:** The `dineoncampus.com` platform is protected by Cloudflare, so live menu scraping is not possible. Instead, `dining-manual.js` ingests hardcoded dining hours and official menu links into the vector store (`source_type='Dining'`), and the chat controller follows the standard retrieval path. If retrieval returns no Dining chunks, the controller falls back to hardcoded semester hours with live links as a graceful degradation.

### 5. Run the Backend Server

```bash
cd server
npm install   # Only on first run
npm run start
# Server runs on http://localhost:3000
```

### 6. Run the Frontend Client

```bash
cd client
npm install   # Only on first run
npm start
# Frontend runs on http://localhost:4200
```

## Deployment

MAPLE M3 runs locally. Start the backend with `npm start` inside `server/` and the frontend with `ng serve` (or `npm start`) inside `client/`. All secrets are stored in a local `.env` file (gitignored); use `.env.example` as the template — never commit real credentials.

## Evaluation

Retrieval and answer quality are measured with a golden-query set (precision/recall on retrieved chunks, faithfulness, relevance) as described in the design doc. A smoke test suite covering all endpoints is located at `server/tests/smoke.js` and can be run against any environment:

```bash
# Local
node server/tests/smoke.js
```

To run against a different local port or base URL:

```powershell
# PowerShell
$env:BASE_URL="http://localhost:3000"; $env:ADMIN_TOKEN="your-token"; node server/tests/smoke.js
```

Latest local golden-eval summary (`eval/results/golden-eval-20260501-131945.json`, dataset `eval/test-cases/golden-dataset.json`):

- Total cases: `50` (`core`: 15, `temporal`: 12, `routing`: 13, `adversarial`: 10)
- Pass rate: `100%` (`50/50` passed)
- Retrieval precision: `86%`
- Retrieval recall: `82.3%`
- Faithfulness pass rate: `100%`
- Relevance pass rate: `100%`
- Log schema compliance: `100%`

## Current Implementation Status

**Backend**
- Complete conversational RAG flow (`/chat`) with multi-turn memory via persisted `ChatHistory`
- Dining queries intercepted before RAG with hardcoded semester hours and live menu links
- Domain-based metadata pre-filtering across Library, Health, IT, Events, Recreation, Clubs, News, Admin
- Structured JSON observability logs (LLM + retrieval) written to daily rotating `logs/` files
- CORS restricted to known origins; per-IP rate limiting (30 req/min) on `/chat`
- Bearer token authentication (`ADMIN_TOKEN`) on `/ingest`
- MAPLE-compliant error envelopes and standard error codes across campus API endpoints (`/api/v1/campus/*`)

**Frontend**
- Functional Angular chat UI with markdown rendering, source attribution, confidence badges, and data-freshness notices
- Distinct error messaging for 422 (RETRIEVAL_FAILED) and 502 (AI_ERROR)
- `conversation_id` tracked across turns for persistent multi-turn context

## AI Integration

### Model Selection Rationale

**Generative LLM — `llama3.1:8b` via Ollama**

The original design called for a cloud frontier model (Claude or GPT-4o). We migrated to `llama3.1:8b` running on the campus NVIDIA DGX Spark via Ollama for three reasons:

1. **Cost:** Eliminating per-token API fees drops infrastructure cost to $0/month for the pilot.
2. **Privacy:** All student queries remain on-campus hardware — no query text leaves Marist's network.
3. **Latency predictability:** Local inference removes network round-trip variability to external API endpoints.

OpenAI `gpt-4o-mini` is retained as a configurable fallback via the `USE_LOCAL_MODEL=false` env toggle; the `server/src/services/llm.js` wrapper exposes an identical interface for both providers with no code changes required to switch. The accepted tradeoff is slightly weaker reasoning compared to frontier models, which is appropriate for the bounded query complexity of a campus services navigator at pilot scale.

**Embedding Model — `nomic-embed-text` via Ollama**

The original design specified OpenAI `text-embedding-3-small` (1536 dimensions). We migrated to `nomic-embed-text` (768 dimensions) for the same cost and privacy reasons as the LLM. OpenAI `text-embedding-3-small` is retained as a fallback. Because the vector dimension differs between providers, the DB must be initialized with the correct dimension at setup time; switching after initialization requires `RESET_DB=true` and a full re-ingestion.

---

### Prompt Design Decisions

The system prompt lives in `prompts/system/main-system-prompt.md` and is loaded dynamically on every request (no server restart required to update it). Key design decisions:

**Temporal grounding via `{{CURRENT_TIMESTAMP}}`**
The prompt injects the live timestamp at request time so the model can resolve relative queries ("tonight", "this weekend", "tomorrow") against chunk `last_updated` metadata without hallucinating dates. The model is also instructed to warn students when sourced information may be stale.

**Context-only constraint**
The model is explicitly forbidden from using outside knowledge. All answers must be grounded in the retrieved context blocks. This is the primary hallucination guardrail; it is reinforced by the similarity threshold check that bypasses the LLM entirely if no relevant chunks are found.

**Module boundary guardrails**
The prompt redirects out-of-scope questions (course registration, degree planning, code evaluation) to the M1, M2, or A-series MAPLE modules rather than attempting to answer them.

**Numbered citation format**
Retrieved context blocks are labeled `[1]`, `[2]`, … in `server/src/controllers/chat.js` before being injected as `{{CONTEXT}}`. The prompt instructs the model to cite with those exact bracket numbers inline (e.g., `[1]` after a sentence, `[1][2]` when multiple sources apply). The numbers correspond 1:1 with the `sources` array in the API response, allowing the Angular UI to linkify `[n]` references and render a collapsible numbered sources list with matching anchor IDs.

**Conversation history injection**
When a `conversation_id` is present, the controller prepends the last 5 turns from `ChatHistory` as alternating `user`/`assistant` message objects before the current query. The 5-turn cap was calibrated to stay within the model's practical context budget while covering the typical depth of a student session. History fetch failures degrade gracefully — the request proceeds without history rather than returning an error.

---

### Retrieval Strategy

MAPLE M3 uses a **metadata-filtered RAG** pipeline with the following stages:

1. **Domain classification.** A keyword classifier in the chat controller tags the incoming query with a `source_type` (Library, Health, IT, Events, Recreation, Clubs, News, Admin, Dining). This filter is applied to the `pgvector` similarity search to isolate the embedding space to the relevant domain before any vector comparison is performed.

2. **Embedding & similarity search.** The query is embedded with the same model used at ingestion time (`nomic-embed-text` or `text-embedding-3-small`). PostgreSQL `pgvector` computes cosine distance (`<=>`) against all `DocumentEmbeddings` rows matching the `source_type` filter. The **top-5 chunks** above the similarity threshold are returned.

3. **Similarity threshold — `0.55`.** The design target was `0.70`. Validation runs against administrative queries (Registrar, Financial Aid lookups) showed that formal institutional language embeds farther from colloquial student phrasing than other domains, producing false negatives at `0.70`. Lowering to `0.55` recovered those queries without meaningfully degrading precision elsewhere. The threshold is a named constant (`SIMILARITY_THRESHOLD`) in `server/src/services/retrieval.js`.

4. **LLM bypass on retrieval failure.** If no chunk meets the `0.55` threshold, the LLM is not called at all. The API returns `RETRIEVAL_FAILED` (422) immediately. This prevents the model from fabricating an answer when no grounded context is available.

5. **Confidence scoring.** The top retrieved chunk's similarity score drives the `confidence` field in the API response: ≥ 0.75 → `"high"`, ≥ 0.60 → `"medium"`, below threshold → `"low"`, no retrieval → `"none"`. The Angular UI surfaces this as a badge on each response.

6. **Dining path.** Because `dineoncampus.com` is protected by Cloudflare, dining data is ingested via `data/scripts/dining-manual.js` (with `source_type='Dining'`) and follows the standard retrieval path. If retrieval returns zero Dining chunks, the controller falls back to hardcoded typical semester hours with live links — a graceful degradation rather than a silent failure. See [reconciliation.md](./docs/reconciliation.md) for full rationale.

**Chunking strategy:**
- Structured records (office directories, hours): one record per chunk to preserve lookup precision.
- Text-heavy content (IT FAQs, news articles): ~400-word chunks with ~10% overlap so sentence-boundary context is not lost at chunk edges.

## Architectural Notes & Deviations

See [docs/reconciliation.md](./docs/reconciliation.md) for a full account of decisions that evolved from the original Design Doc to the final MVP, including rationale for each change.

## Team Members

| Name | Primary Responsibilities |
|---|---|
| Sufia Khan | Backend API and RAG Pipeline, Frontend UI |
| Sydney Fronheiser | Data pipeline, Scraping scripts |
| Jenna Iervolino | Data Pipeline, Scraping Scripts|

## AI Disclosure & Tools Used

AI tools (Cursor IDE, Google Gemini, and GitHub Copilot) were actively used throughout development.

* **Code Scaffolding:** Used to generate initial Express routing structures and PostgreSQL schemas.
* **Iterative Debugging:** Used to diagnose dependency errors and database race conditions.
* **Prompt Logs:** Full records of our AI-assisted development process can be found in the `prompts/dev/` directory.
