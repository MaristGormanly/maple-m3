# M3: MAPLE Campus Services & Student Life Navigator

The MAPLE Campus Services & Student Life Navigator is a conversational tool that helps students find information about dining services, library resources, health and wellness, recreation facilities, IT support, administrative offices, student clubs and organizations, campus events, and university news. It serves as an AI-powered gateway to campus engagement, unifying heavily siloed university data into a single conversational interface.

## Architecture Overview
This module utilizes a Retrieval-Augmented Generation (RAG) pipeline to dynamically provide the Large Language Model (LLM) with localized, up-to-date Marist College data. Queries are routed to a local NVIDIA DGX Spark running Ollama to ensure data privacy and eliminate cloud API costs.

* **Design doc:** [MAPLE M3 Project Design Doc](./docs/MAPLE_M3%20Project%20Design%20Doc.md)
* **Architecture diagram (Mermaid):** [architecture-diagram.md](./docs/architecture-diagram.md)
* **API specification:** [api-spec.md](./docs/api-spec.md)

## Tech Stack
* **Backend:** Node.js with Express
* **Frontend:** Angular 19+
* **Database:** PostgreSQL with `pgvector` extension
* **AI Models:** DGX Spark via Ollama (`llama3.1:8b` for generation, `nomic-embed-text` for embeddings)
* **Data Pipeline:** Playwright, Cheerio

## Setup & Running Locally

### 1. Prerequisites
* Node.js (v18+)
* PostgreSQL with the `pgvector` extension installed and running.
* Access to the campus NVIDIA DGX Spark (via SSH tunnel or campus network).

### 2. Environment Configuration
Copy the environment template and fill in your database credentials:
```bash
cp .env.example .env
```

### 3. Initialize the Database
Run from the **repository root**. The script creates relational tables and a `DocumentEmbeddings` column whose width matches `USE_LOCAL_MODEL` (768 for local Ollama embeddings, 1536 for OpenAI `text-embedding-3-small`).

```bash
node server/src/models/db/init.js
```

### 4. Run the Backend Server
```bash
cd server
npm install
npm run start
# Server runs on http://localhost:3000
```

Equivalent: `node src/index.js` from the `server` directory.

## Deployment

**Lab 2:** local development only. **Final project:** target deployment is DigitalOcean App Platform with managed PostgreSQL (`pgvector`) and HTTPS (e.g. `m3.maristchat.com`), with secrets in host environment variables—not committed `.env` files.

## Evaluation

Retrieval and answer quality will be measured with a golden-query set (precision/recall on retrieved chunks, faithfulness, relevance) as described in the design doc. Lab 2 focuses on architecture and a working MVP; full evaluation automation is planned for later milestones.

Current Status (Lab 2 Prototype)
--------------------------------

*   **Working:** Complete conversational RAG flow (/chat), dynamic system prompt loading, structured JSON logging, temporal metadata pre-filtering, and rate-limiting security middleware.
    
*   **Stubbed/Scoped:** The /ingest route currently only triggers the Admin Directory scraping script. This is scoped down for the MVP to safely demonstrate the pipeline hook without overwhelming the server.
    
*   **Planned:** Full scheduled CRON jobs for high-volatility data ingestion (dining menus) and Angular frontend UI integration.
    

AI Integration Summary
----------------------

We opted for a multi-index RAG architecture utilizing metadata pre-filtering. Based on the user's query, we categorize the domain (Dining, Library, IT) to isolate the vector search, ensuring higher relevance. We enforce a strict 0.70 cosine similarity threshold; if no chunks meet this, the AI is bypassed entirely, and a standard RETRIEVAL\_FAILED error is returned to prevent hallucination.

Lab 2 Prototype Deviations & Architectural Notes
------------------------------------------------

To meet the Lab 2 requirement for "functional MVP flows," our team made the following intentional scope adjustments from our Week 8 Design Doc:

1.  **Ingestion API Scope:** The POST /api/v1/campus/ingest endpoint only processes source\_type: 'Admin' for the MVP.
    
2.  **Vector Dimension Toggling:** We implemented the USE\_LOCAL\_MODEL toggle to switch between local DGX Spark (768 dims) and OpenAI (1536 dims). _Caveat:_ If toggling this environment variable after the database is already created, you must temporarily set RESET\_DB=true in .env and run init.js to drop and rebuild the DocumentEmbeddings table with the correct dimension.
    
3.  **Database Connection:** Upgraded retrieval.js from a single pg.Client to a pg.Pool to ensure the architecture is resilient to concurrent requests.
    

AI Disclosure & Tools Used
--------------------------

AI tools (GitHub Copilot and Gemini) were actively used throughout development.

*   **Code Scaffolding:** Used to generate the initial Express routing structures and PostgreSQL schemas.
    
*   **Iterative Debugging:** Used to diagnose dependency errors (like missing express-rate-limit packages) and database race conditions.
    
*   **Prompt Logs:** Full records of our AI-assisted development process can be found in the prompts/dev/ directory.
    

Team Members
------------

*   \[Sufia Khan\] - Backend AI Integration
    
*   \[Teammate 2\] - Data Ingestion Pipelines
    
*   \[Teammate 3\] - Angular Frontend & UI