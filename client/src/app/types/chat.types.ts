export interface ChatSource {
    title: string;
    url: string;
    chunk_id: string;
    relevance_score: number;
  }
  
  export interface ChatResponseData {
    response: string;
    conversation_id: string;
    sources: ChatSource[];
    confidence: 'high' | 'medium' | 'low' | 'none';
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
    // Index signature to allow retrieval/LLM specific telemetry
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
    conversationId?: string;
    isError?: boolean;
  }