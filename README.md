# M3: MAPLE Campus Services & Student Life Navigator

The MAPLE Campus Services & Student Life Navigator is a conversational tool that helps students find information about dining services, library resources, health and wellness, recreation facilities, IT support, administrative offices, student clubs and organizations, campus events, and university news. It serves as an AI-powered gateway to campus engagement, unifying heavily siloed university data into a single conversational interface.

## Architecture Overview

This module utilizes a Retrieval-Augmented Generation (RAG) pipeline to dynamically provide the Large Language Model (LLM) with localized, up-to-date Marist College data. Queries are routed to a local NVIDIA DGX Spark running Ollama to ensure data privacy and eliminate cloud API costs.

* **Design doc:** [MAPLE M3 Project Design Doc](./docs/MAPLE_M3%20Project%20Design%20Doc.md)
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

Each data domain has its own ingestion script in `data/scripts/`. Run any script from the **repository root** to scrape, chunk, embed, and store documents for that domain:

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
```

Each script requires the database to be initialized (Step 3) and the embedding service (DGX Spark or OpenAI) to be reachable.

> **Note — Dining data:** Dining hours and menus are **not** ingested via scripts. The `dineoncampus.com` platform is protected by Cloudflare, making automated scraping unreliable. Instead, the chat controller intercepts dining-related queries and returns hardcoded typical semester hours alongside official live links (`dineoncampus.com/marist`). No dining ingestion script is needed.

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

# Production (PowerShell)
$env:BASE_URL="https://m3.maristchat.com"; $env:ADMIN_TOKEN="your-token"; node server/tests/smoke.js
```

## Current Implementation Status

**Backend**
- Complete conversational RAG flow (`/chat`) with multi-turn memory via persisted `ChatHistory`
- Dining queries intercepted before RAG with hardcoded semester hours and live menu links
- Domain-based metadata pre-filtering across Library, Health, IT, Events, Recreation, Clubs, News, Admin
- Structured JSON observability logs (LLM + retrieval) written to daily rotating `logs/` files
- CORS restricted to known origins; per-IP rate limiting (30 req/min) on `/chat`
- Bearer token authentication (`ADMIN_TOKEN`) on `/ingest`
- MAPLE-compliant error envelopes and standard error codes across all endpoints

**Frontend**
- Functional Angular chat UI with markdown rendering, source attribution, and confidence badges
- Distinct error messaging for 422 (RETRIEVAL_FAILED) and 502 (AI_ERROR)
- `conversation_id` tracked across turns for persistent multi-turn context

## AI Integration Summary

We opted for a multi-index RAG architecture utilizing metadata pre-filtering. Based on the user's query, the chat controller classifies the domain (Library, Health, IT, Events, Recreation, Clubs, News, Admin) to isolate the vector search. Dining queries are handled separately via a hardcoded intercept (see [reconciliation.md](./docs/reconciliation.md) for rationale). Retrieval is tuned to a `0.55` cosine similarity threshold (calibrated down from the `0.70` design target to reduce false negatives on administrative queries). If no chunks meet this threshold, the AI is bypassed entirely and a `RETRIEVAL_FAILED` (422) response is returned to prevent hallucination.

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
