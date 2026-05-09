# MAPLE M3 — system architecture

This figure matches the [MAPLE M3 Project Design Doc](./MAPLE-M3-Project-Design-Doc.md#architecture-diagram) architecture diagram. The **AI Integration** label names the actual models in use (`llama3.1:8b` via Ollama on DGX Spark, or `gpt-4o-mini` via OpenAI, toggled by `USE_LOCAL_MODEL`).

```mermaid
graph TD
    subgraph Frontend ["Frontend: Angular"]
        UI["Student UI"]
        APIClient["API Client Service"]
    end

    subgraph Backend ["Backend: Node.js / Express"]
        Router["Router /api/v1/campus\n(campus.js)"]
        ChatCtl["Chat Controller\n(controllers/chat.js)"]
        LLM["LLM Service\n(services/llm.js)"]
        Retrieval["Retrieval Service\n(services/retrieval.js)"]
    end

    subgraph Storage ["Storage & Processing"]
        Scrapers["Scrapers/Parsers\n(data/scripts/)"]
        Embed["Embedding Model\n(nomic-embed-text / text-embedding-3-small)"]
        DB[("PostgreSQL + pgvector")]
    end

    subgraph AI ["AI Integration"]
        Frontier["Frontier model<br/>(llama3.1:8b / gpt-4o-mini)"]
    end

    UI --> APIClient
    APIClient --> Router

    Router -->|"POST /chat"| ChatCtl
    Router -->|"GET /status\nPOST /ingest\n(inline handlers)"| DB

    ChatCtl --> LLM
    ChatCtl --> Retrieval

    Retrieval --> DB
    Scrapers --> Embed
    Embed --> DB

    LLM --> Frontier
```

**Route responsibilities:**
- **`POST /chat`** → Chat Controller → LLM Service + Retrieval Service → PostgreSQL + pgvector
- **`GET /status`** → inline handler in `campus.js` → queries `Documents` (`source_type = 'Events'`) directly via the shared pg Pool
- **`POST /ingest`** → inline handler in `campus.js` (requires Bearer token) → spawns `run-ingestion-batch.js` asynchronously → Scrapers → Embedding Model → PostgreSQL
