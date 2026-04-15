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
  
  export interface MapleResponse {
    success: boolean;
    data: ChatResponseData | null;
    error: MapleError | null;
    metadata: any;
  }
  
  export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    sources?: ChatSource[];
    confidence?: 'high' | 'medium' | 'low' | 'none';
    isError?: boolean; // Flags 422 or 502 errors for special UI rendering
  }