/**
 * client/src/app/services/campus-api.service.ts — Backend API Client Service
 *
 * Injectable singleton service (providedIn: 'root') that encapsulates all HTTP
 * communication with the MAPLE M3 backend. This is the only place in the frontend
 * that is permitted to call the backend — direct DB access from the frontend is
 * prohibited per the MAPLE Architecture Guide.
 *
 * The base API URL is read from the environment file (environment.development.ts
 * locally, environment.ts for production), keeping configuration externalized.
 *
 * sendMessage(message, conversationId):
 *  - POSTs to /api/v1/campus/chat with the MAPLE standard request envelope
 *  - On success: maps the response data fields into a ChatMessage object
 *    (role, content, sources, confidence, conversationId) for AppComponent to append
 *  - On HTTP error: normalizes the error into a user-friendly ChatMessage with
 *    isError: true; handles 422 (RETRIEVAL_FAILED) and 502 (AI_ERROR) distinctly
 *    so the UI can display appropriate messaging without crashing
 *  - Returns an Observable<ChatMessage> so AppComponent subscribes reactively
 */
import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, catchError, map, of } from 'rxjs';
import { MapleResponse, ChatMessage } from '../types/chat.types';
import { environment } from '../../environments/environment.development';

@Injectable({
  providedIn: 'root'
})
export class CampusApiService {
  // Config externalized per MAPLE Architecture Guide
  private apiUrl = environment.apiUrl;

  constructor(private http: HttpClient) {}

  sendMessage(message: string, conversationId: string | null): Observable<ChatMessage> {
    const payload = {
      message,
      conversation_id: conversationId,
      context: {} // MVP: Empty user context
    };

    return this.http.post<MapleResponse>(`${this.apiUrl}/chat`, payload).pipe(
      map((res: MapleResponse) => {
        // Safe envelope handling: Guard against false success or null data
        if (!res.success || !res.data) {
          throw new Error(res.error?.message || 'Unexpected invalid response from server.');
        }

        return {
          role: 'assistant',
          content: res.data.response,
          sources: res.data.sources,
          confidence: res.data.confidence,
          conversationId: res.data.conversation_id, // Extract backend's ID
          isError: false
        } as ChatMessage;
      }),
      catchError((err: HttpErrorResponse | Error) => {
        let fallbackMessage = 'An unexpected error occurred. Please try again later.';
        let confidenceFlag: 'none' = 'none';
        
        if (err instanceof HttpErrorResponse && err.error && err.error.error) {
          const mapleError = err.error.error;
          if (err.status === 422) {
             fallbackMessage = mapleError.message; 
          } else if (err.status === 502) {
             fallbackMessage = 'The AI provider is currently unavailable. Please check back later.';
          }
        } else if (err instanceof Error) {
          fallbackMessage = err.message;
        }

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