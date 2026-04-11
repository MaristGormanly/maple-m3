# MAPLE M3 — system architecture

This figure matches the **logical layout** of the [MAPLE M3 Project Design Doc](./MAPLE_M3%20Project%20Design%20Doc.md#architecture-diagram) architecture diagram; the only intentional difference is the **AI Integration** label, which names the **actual** models in use (Ollama on DGX / OpenAI) instead of the generic “cloud frontier” wording.

```mermaid
graph TD
    subgraph Frontend ["Frontend: Angular"]
        UI["Student UI"]
        APIClient["API Client Service"]
    end

    subgraph Backend ["Backend: Node.js / Express"]
        Router["Router /api/v1/campus"]
        ChatCtl["Chat Controller"]
        StatusCtl["Status/Events Controller"]
        LLM["LLM Service"]
        Retrieval["Retrieval Service"]
        RelQuery["Relational Query Service"]
    end

    subgraph Storage ["Storage & Processing"]
        Scrapers["Scrapers/Parsers"]
        Embed["Embedding Model"]
        DB[("PostgreSQL + pgvector")]
    end

    subgraph AI ["AI Integration"]
        Frontier["Frontier model<br/>(llama3.1:8b / gpt-4o-mini)"]
    end

    UI --> APIClient
    APIClient --> Router

    Router -->|/api/v1/campus/chat| ChatCtl
    Router -->|/api/v1/campus/status| StatusCtl

    ChatCtl --> LLM
    ChatCtl --> Retrieval

    StatusCtl --> RelQuery

    Retrieval --> DB
    RelQuery --> DB
    Scrapers --> Embed
    Embed --> DB

    LLM --> Frontier
```

**Implementation note:** The Week 8 diagram did not depict **POST `/api/v1/campus/ingest`**; in the current codebase, that route triggers **Scrapers/Parsers** in the background and ultimately feeds the same **Embedding Model → PostgreSQL** path shown above.
