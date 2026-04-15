import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, catchError, map, of } from 'rxjs';
import { MapleResponse, ChatMessage } from '../types/chat.types';

@Injectable({
  providedIn: 'root'
})
export class CampusApiService {
  // Pointing strictly to local Node.js Express backend
  private apiUrl = 'http://localhost:3000/api/v1/campus';

  constructor(private http: HttpClient) {}

  sendMessage(message: string, conversationId: string | null): Observable<ChatMessage> {
    const payload = {
      message,
      conversation_id: conversationId,
      context: {} // MVP: Empty user context
    };

    return this.http.post<MapleResponse>(`${this.apiUrl}/chat`, payload).pipe(
      map((res: MapleResponse) => {
        // Successful AI Response
        return {
          role: 'assistant',
          content: res.data!.response,
          sources: res.data!.sources,
          confidence: res.data!.confidence,
          isError: false
        } as ChatMessage;
      }),
      catchError((err: HttpErrorResponse) => {
        // Gracefully handle MAPLE Standard Errors (422, 502, 500)
        let fallbackMessage = 'An unexpected error occurred. Please try again later.';
        let confidenceFlag: 'none' = 'none';
        
        if (err.error && err.error.error) {
          const mapleError = err.error.error;
          if (err.status === 422) {
             // RETRIEVAL_FAILED
             fallbackMessage = mapleError.message; 
          } else if (err.status === 502) {
             // AI_ERROR
             fallbackMessage = 'The AI provider is currently unavailable. Please check back later.';
          }
        }

        // Return a safe "assistant" message flagged as an error so the UI can render it gracefully
        return of({
          role: 'assistant',
          content: fallbackMessage,
          sources: [],
          confidence: confidenceFlag,
          isError: true
        } as ChatMessage);
      })
    );
  }
}