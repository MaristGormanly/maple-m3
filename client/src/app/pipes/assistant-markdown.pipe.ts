/**
 * client/src/app/pipes/assistant-markdown.pipe.ts — Assistant reply markdown + citations
 *
 * Like MarkdownPipe but runs linkifyEmailsInMarkdown first, then (when sources exist)
 * turns bracketed numeric refs [1], [2] into superscript links targeting
 * #cite-{messageIndex}-{n} in the collapsible sources list.
 */
import { Pipe, PipeTransform } from '@angular/core';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { ChatSource } from '../types/chat.types';
import { linkifyEmailsInMarkdown } from '../utils/linkify-emails';

@Pipe({
  name: 'assistantMarkdown',
  standalone: true
})
export class AssistantMarkdownPipe implements PipeTransform {
  transform(
    value: string,
    sources?: ChatSource[] | null,
    messageIndex: number | null = 0
  ): string {
    if (!value) return '';
    const list = sources ?? [];
    const idx = messageIndex ?? 0;
    const withEmails = linkifyEmailsInMarkdown(value);
    const md =
      list.length > 0
        ? this.linkifyNumericCitations(withEmails, list.length, idx)
        : withEmails;
    const rawHtml = marked.parse(md) as string;
    return DOMPurify.sanitize(rawHtml);
  }

  private linkifyNumericCitations(
    content: string,
    sourceCount: number,
    messageIndex: number
  ): string {
    // Avoid breaking markdown links like [1](https://...)
    return content.replace(/\[(\d+)\](?!\()/g, (match, numStr: string) => {
      const n = parseInt(numStr, 10);
      if (Number.isNaN(n) || n < 1 || n > sourceCount) return match;
      const id = `cite-${messageIndex}-${n}`;
      return `<sup class="cite-ref"><a href="#${id}" title="Source ${n}">[${n}]</a></sup>`;
    });
  }
}
