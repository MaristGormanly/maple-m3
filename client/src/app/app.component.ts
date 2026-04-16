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
    { role: 'assistant', content: 'Hello! I am the MAPLE Campus Navigator. Ask me about library hours, IT help, and more.' }
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
    this.messages.push({ role: 'user', content: userText });
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
          console.error('Unhandled UI error:', err);
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
}