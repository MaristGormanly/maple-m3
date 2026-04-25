/**
 * client/src/app/types/chat.types.ts — Shared TypeScript Type Definitions
 *
 * Defines the interfaces used across the Angular client to type-check
 * backend responses and internal component state. Mirrors the MAPLE standard
 * JSON envelope and the /api/v1/campus/chat response shape.
 *
 *  ChatSource       — a single retrieved document chunk reference (title, url,
 *                     chunk_id, relevance_score); populates the sources list in the UI
 *  ChatResponseData — the data field of a successful /chat response
 *  MapleError       — the error field of a failed response (code, message, details)
 *  MapleMetadata    — the metadata field present on every response (timestamp,
 *                     module, version, and optional model / latency_ms)
 *  MapleResponse    — the full standard MAPLE envelope (success, data, error, metadata)
 *                     typed as received from HttpClient in CampusApiService
 *  ChatMessage      — internal UI model representing a single conversation turn;
 *                     used to populate the messages[] array in AppComponent
 */
export interface ChatSource {
    title: string;
    url: string;
    chunk_id: string;
    relevance_score: number;
  }

  export type FreshnessStatus = 'fresh' | 'aging' | 'stale' | 'unknown';

  export interface StaleSource {
    title: string;
    source_type: string;
    age_hours: number;
    stale_after_hours: number;
  }

  export interface DataFreshness {
    status: FreshnessStatus;
    warning: string | null;
    oldest_source_age_hours: number | null;
    stale_sources: StaleSource[];
  }
  
  export interface ChatResponseData {
    response: string;
    conversation_id: string;
    sources: ChatSource[];
    confidence: 'high' | 'medium' | 'low' | 'none';
    freshness?: DataFreshness;
  }
  
  export interface MapleError {
    code: string;
    message: string;
    details?: string;
  }
  
  export interface MapleMetadata {
    timestamp: string;
    module: string;
    version: string;
    model?: string;
    latency_ms?: number;
    [key: string]: any; 
  }
  
  export interface MapleResponse {
    success: boolean;
    data: ChatResponseData | null;
    error: MapleError | null;
    metadata: MapleMetadata; 
  }
  
  export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    sources?: ChatSource[];
    confidence?: 'high' | 'medium' | 'low' | 'none';
    freshness?: DataFreshness;
    conversationId?: string;
    isError?: boolean;
  }