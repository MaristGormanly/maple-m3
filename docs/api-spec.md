# MAPLE M3 — API Specification

**Module:** M3: Campus Services & Student Life Navigator  
**Base path:** `/api/v1/campus`  
**Envelope:** All responses follow the MAPLE standard JSON envelope (`success`, `data`, `error`, `metadata`).

---

## `GET /health`

> **Note:** This endpoint is not under `/api/v1/campus`. It is a top-level liveness and DB connectivity check.

**Response — 200 OK**
```json
{ "status": "healthy", "message": "MAPLE M3 API is running." }
```

**Response — 500 Internal Server Error**
```json
{ "status": "error", "message": "DB connection failed." }
```

---

## `POST /api/v1/campus/chat`

Primary RAG chat endpoint. Accepts a student's natural language query, performs vector retrieval against ingested campus data, and returns an AI-generated response with source attribution and a confidence rating.

**Rate limit:** 30 requests per IP per minute.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `message` | string | yes | The student's natural language query |
| `conversation_id` | string | no | Existing conversation ID for multi-turn context |
| `context` | object | no | Optional user profile data (e.g. major, year) to personalize the response |

**Example request**
```json
{
  "message": "What are the library hours this weekend?",
  "conversation_id": "conv_abc123",
  "context": {}
}
```

**Response — 200 OK**
```json
{
  "success": true,
  "data": {
    "response": "The Marist Library is open Saturday 10am–6pm and Sunday 12pm–8pm...",
    "conversation_id": "conv_abc123",
    "sources": [
      {
        "title": "Marist Library Hours",
        "url": "https://library.marist.edu/web/marist-library/hours-full",
        "chunk_id": "doc_12_chunk_0",
        "relevance_score": 0.8214
      }
    ],
    "confidence": "high"
  },
  "error": null,
  "metadata": {
    "timestamp": "2026-04-18T14:30:00Z",
    "module": "m3",
    "version": "1.0.0",
    "model": "llama3.1:8b",
    "latency_ms": 1340
  }
}
```

**`confidence` values:** `"high"` (top score ≥ 0.75) | `"medium"` (≥ 0.65) | `"low"` (below 0.65)

**Error responses**

| HTTP | `error.code` | Condition |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `message` field missing from request body |
| 422 | `RETRIEVAL_FAILED` | No chunks exceeded the similarity threshold |
| 429 | `RATE_LIMITED` | Per-IP rate limit exceeded (30 req/min) |
| 500 | `INTERNAL_ERROR` | Retrieval service error or unexpected server error |
| 502 | `AI_ERROR` | LLM API call failed or returned unusable output |

**Example — 422 RETRIEVAL_FAILED**
```json
{
  "success": false,
  "data": null,
  "error": {
    "code": "RETRIEVAL_FAILED",
    "message": "I'm sorry, I couldn't find any specific campus information in my database to answer that accurately. Could you try rephrasing or asking about library hours, dining, or IT?",
    "details": "No chunks exceeded the similarity threshold of 0.55.",
    "conversation_id": "conv_abc123",
    "sources": [],
    "confidence": "none"
  },
  "metadata": {
    "timestamp": "2026-04-18T14:30:00Z",
    "module": "m3",
    "version": "1.0.0",
    "chunks_retrieved": 0,
    "top_score": null,
    "threshold_applied": 0.55
  }
}
```

---

## `GET /api/v1/campus/status`

Returns recently ingested campus events from the `Documents` table (`source_type = 'Events'`). Supports optional date-based filtering. Returns up to 10 records, ordered by most recently ingested.

**Query parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `date` | string (`YYYY-MM-DD`) | no | Filter to events ingested on a specific date. If omitted, returns the 10 most recent event records. |

**Response — 200 OK**
```json
{
  "success": true,
  "data": [
    {
      "title": "Spring Club Fair",
      "location": "McCann Center",
      "start_time": "2026-04-18T12:00:00Z",
      "category": "Events"
    }
  ],
  "error": null,
  "metadata": {
    "timestamp": "2026-04-18T14:30:00Z",
    "module": "m3",
    "version": "1.0.0"
  }
}
```

**Error responses**

| HTTP | `error.code` | Condition |
|---|---|---|
| 500 | `INTERNAL_ERROR` | Database query failed |

---

## `POST /api/v1/campus/ingest`

Triggers a background data ingestion and vectorization pipeline script. Returns immediately (HTTP 202) while the job runs asynchronously.

**MVP scope (Lab 2):** Only `source_type: "Admin"` is supported via this endpoint. All other domain ingestion is run directly via the scripts in `data/scripts/`.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `source_type` | string | yes | The domain to ingest. Only `"Admin"` is accepted for MVP. |

**Example request**
```json
{
  "source_type": "Admin"
}
```

**Response — 202 Accepted**
```json
{
  "success": true,
  "data": {
    "message": "Ingestion pipeline triggered successfully in the background.",
    "jobId": "job_1713449400000"
  },
  "error": null,
  "metadata": {
    "timestamp": "2026-04-18T14:30:00Z",
    "module": "m3",
    "version": "1.0.0"
  }
}
```

**Error responses**

| HTTP | `error.code` | Condition |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `source_type` is missing or not `"Admin"` |
