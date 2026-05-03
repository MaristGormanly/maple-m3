/**
 * client/src/app/app.component.ts — Root Chat UI Component
 *
 * The sole UI component for the MAPLE M3 Angular client. Renders the full
 * conversational chat interface and manages all interaction state.
 *
 * State:
 *  - messages[]      — the ordered list of ChatMessage objects (user + assistant turns)
 *                      initialised with a welcome message from the assistant
 *  - userInput       — two-way bound to the textarea via [(ngModel)]
 *  - isLoading       — controls the animated typing indicator and disables the Send button
 *  - conversationId  — tracks the backend-assigned ID across turns for multi-turn context;
 *                      null until the first successful response
 *
 * Key methods:
 *  - sendMessage()   — pushes the user message, calls CampusApiService, appends the
 *                      assistant response (or a friendly error message on failure)
 *  - handleKeydown() — submits on Enter (without Shift) for natural chat UX
 *  - scrollToBottom()— called after every view check to keep the latest message visible
 *
 * Template and styles are in app.component.html and app.component.scss respectively.
 * Depends on: CampusApiService, MarkdownPipe, ChatMessage type.
 */
import { Component, ViewChild, ElementRef, AfterViewChecked, ChangeDetectorRef, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CampusApiService } from './services/campus-api.service';
import { ChatMessage } from './types/chat.types';
import { MarkdownPipe } from './pipes/markdown.pipe';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, MarkdownPipe],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent implements AfterViewChecked {
  @ViewChild('scrollMe') private myScrollContainer!: ElementRef;

  userInput: string = '';
  messages: ChatMessage[] = [
    {
      role: 'assistant',
      content: 'Hello! I am the MAPLE Campus Navigator. Ask me about library hours, IT help, and more.',
      timestamp: new Date().toISOString()
    }
  ];
  isLoading: boolean = false;
  conversationId: string | null = null;

  constructor(
    private campusApi: CampusApiService,
    private cdr: ChangeDetectorRef,
    private zone: NgZone
  ) {}

  ngAfterViewChecked() {
    this.scrollToBottom();
  }

  scrollToBottom(): void {
    try {
      this.myScrollContainer.nativeElement.scrollTop = this.myScrollContainer.nativeElement.scrollHeight;
    } catch(err) {}
  }

  sendMessage() {
    if (!this.userInput.trim() || this.isLoading) return;

    const userText = this.userInput.trim();
    this.messages.push({ role: 'user', content: userText, timestamp: new Date().toISOString() });
    this.userInput = '';
    this.isLoading = true;

    this.campusApi.sendMessage(userText, this.conversationId).subscribe({
      next: (responseMsg) => {
        this.zone.run(() => {
          this.messages.push(responseMsg);
          if (responseMsg.conversationId) {
            this.conversationId = responseMsg.conversationId;
          }
          this.isLoading = false;
          this.cdr.detectChanges();
        });
      },
      error: (err) => {
        this.zone.run(() => {
          // REVISED: Provide a fallback message in the UI so the user isn't stuck
          console.error('API Error:', err);
          
          let friendlyMessage = 'The campus server is currently having trouble responding. Please try again in a moment.';
          
          if (err.status === 422) {
             friendlyMessage = "I couldn't find any documents related to that request. Try asking about a different campus topic.";
          }

          this.messages.push({ 
            role: 'assistant', 
            content: friendlyMessage,
            timestamp: new Date().toISOString()
          });
          
          this.isLoading = false;
          this.cdr.detectChanges();
        });
      }
    });
  }

  handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }

  formatMessageTime(iso?: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }
}