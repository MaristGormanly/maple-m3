import { Component, ViewChild, ElementRef, AfterViewChecked } from '@angular/core';
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
  styleUrl: ['./app.component.scss']
})
export class AppComponent implements AfterViewChecked {
  @ViewChild('scrollMe') private myScrollContainer!: ElementRef;

  userInput: string = '';
  messages: ChatMessage[] = [
    { role: 'assistant', content: 'Hello! I am the MAPLE Campus Navigator. Ask me about dining, library hours, IT help, or campus events.' }
  ];
  isLoading: boolean = false;
  conversationId: string | null = null;

  constructor(private campusApi: CampusApiService) {}

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

    this.campusApi.sendMessage(userText, this.conversationId).subscribe((responseMsg) => {
      this.messages.push(responseMsg);
      // Ensure we keep the conversation ID for the backend history
      if (!this.conversationId && responseMsg.confidence) {
         this.conversationId = `conv_${Date.now()}`; // Set locally if backend doesn't return it
      }
      this.isLoading = false;
    });
  }

  handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }
}