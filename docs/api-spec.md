# MAPLE M3 — API specification

**Base path:** `/api/v1/campus`  
**Envelope:** MAPLE standard JSON (`success`, `data`, `error`, `metadata`).

## `GET /health`

**Not under `/api/v1/campus`.** Simple liveness + DB ping.

**200**

```json
{ "status": "healthy", "message": "MAPLE M3 API is running." }
```

## `POST /api/v1/campus/chat`

Primary RAG chat endpoint. Rate limited (30 req/min per IP).

**Request body**

| Field | Type | Required |
|-------|------|----------|
| `message` | string | yes |
| `conversation_id` | string | no |
| `context` | object | no |

**Success `data`:** `response`, `conversation_id`, `sources[]` (`title`, `url`, `chunk_id`, `relevance_score`), `confidence` (`high` \| `medium` \| `low`).

**Errors:** `VALIDATION_ERROR` (400), `INTERNAL_ERROR` (500 retrieval failure), `RETRIEVAL_FAILED` (422), `AI_ERROR` (502).

## `GET /api/v1/campus/status`

Upcoming campus events from `CampusEvents`.

**Query:** optional `date=YYYY-MM-DD` — filter to events on that calendar day. If omitted, returns the next 10 upcoming events (`start_time >= NOW()`).

## `POST /api/v1/campus/ingest`

Triggers background ingestion (Lab 2 MVP: `source_type: "Admin"` only).

**202** — job accepted; processing runs asynchronously.
