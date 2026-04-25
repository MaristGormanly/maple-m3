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

Primary RAG chat endpoint. Accepts a student's natural language query, performs vector retrieval against ingested campus data, and returns an AI-generated response with source attribution, a confidence rating, and data freshness metadata.

**Rate limit:** 30 requests per IP per minute.

> **Dining intercept:** Queries detected as dining-related (keywords: `dining`, `cafeteria`, specific location names such as `halal shack`, `saxbys`, etc., or broad food terms like `lunch`/`dinner` co-occurring with operational context words like `open`/`hours`) are intercepted **before** the RAG pipeline and return hardcoded typical semester hours plus live links to `dineoncampus.com/marist`. These responses have `confidence: "high"`, `model: "hardcoded"`, and include a `freshness` object with a user-facing caution that dining data may change during holidays or special events.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `message` | string | yes | The student's natural language query |
| `conversation_id` | string | no | Existing conversation ID for multi-turn context. When provided, the last 5 turns are loaded from `ChatHistory` and prepended to the LLM messages array. |
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
    "confidence": "high",
    "freshness": {
      "status": "fresh",
      "warning": null,
      "oldest_source_age_hours": 12.4,
      "stale_sources": []
    }
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

**`confidence` values:** `"high"` (top score ≥ 0.75) | `"medium"` (≥ 0.65) | `"low"` (below 0.65) | `"none"` (retrieval failed)

**`freshness.status` values:** `"fresh"` (all retrieved chunks within freshness thresholds) | `"aging"` (approaching threshold) | `"stale"` (one or more chunks exceed thresholds) | `"unknown"` (missing/unparseable timestamp data)

**`freshness` object (200 responses):**

| Field | Type | Description |
|---|---|---|
| `status` | string | Freshness state: `fresh`, `aging`, `stale`, or `unknown` |
| `warning` | string \| null | User-facing warning message when staleness or uncertainty is detected |
| `oldest_source_age_hours` | number \| null | Age in hours of the oldest retrieved source timestamp |
| `stale_sources` | array | Sources that exceeded stale threshold |

**`stale_sources[]` item shape:**

| Field | Type | Description |
|---|---|---|
| `title` | string | Source title |
| `source_type` | string | Source domain/category (`Events`, `Library`, etc.) |
| `age_hours` | number | Current source age in hours |
| `stale_after_hours` | number | Threshold after which source is considered stale |

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

Returns recently ingested campus events from the `Documents` table (`source_type = 'Events'`). Supports optional date-based filtering. Returns up to 10 records ordered by most recently ingested.

**Query parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `date` | string (`YYYY-MM-DD`) | no | Filter to events ingested on a specific date. Must match the `YYYY-MM-DD` format exactly. If omitted, returns the 10 most recent event records. |

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
| 400 | `VALIDATION_ERROR` | `date` parameter is present but not in `YYYY-MM-DD` format |
| 500 | `INTERNAL_ERROR` | Database query failed |

---

## `POST /api/v1/campus/ingest`

Triggers a background data ingestion and vectorization pipeline script. Returns immediately (HTTP 202) while the job runs asynchronously.

**Authentication:** Requires a Bearer token in the `Authorization` header matching the `ADMIN_TOKEN` environment variable.

```
Authorization: Bearer <ADMIN_TOKEN>
```

**MVP scope:** Only `source_type: "Admin"` is supported via this endpoint. All other domain ingestion is run directly via the scripts in `data/scripts/`. Dining data is not ingested — it is served from hardcoded semester hours in `server/src/utils/dining.js`.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `source_type` | string | yes | The domain to ingest. Only `"Admin"` is accepted. |

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
| 401 | `UNAUTHORIZED` | `Authorization` header is absent or not in `Bearer` format |
| 403 | `FORBIDDEN` | Bearer token does not match `ADMIN_TOKEN` |
