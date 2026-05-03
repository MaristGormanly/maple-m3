/**
 * client/src/app/pipes/markdown.pipe.ts — Markdown Rendering Pipe
 *
 * Standalone Angular pipe (name: 'markdown') that converts a raw markdown string
 * from the LLM response into sanitized HTML for safe rendering via [innerHTML].
 *
 * Pipeline:
 *  1. linkifyEmailsInMarkdown() — plain / backtick-wrapped emails → [x](mailto:x)
 *  2. marked.parse()     — converts markdown to raw HTML (handles bold, lists, links, etc.)
 *  3. DOMPurify.sanitize() — strips any potentially dangerous HTML (XSS protection)
 *                            before the string is bound to the DOM
 *
 * Used in app.component.html as: [innerHTML]="msg.content | markdown"
 * Markdown-specific visual styling (link colour, list spacing, etc.) is handled
 * in app.component.scss via ::ng-deep selectors on the .text container.
 */
import { Pipe, PipeTransform } from '@angular/core';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { linkifyEmailsInMarkdown } from '../utils/linkify-emails';

@Pipe({
  name: 'markdown',
  standalone: true
})
export class MarkdownPipe implements PipeTransform {
  transform(value: string): string {
    if (!value) return '';
    const rawHtml = marked.parse(linkifyEmailsInMarkdown(value)) as string;
    return DOMPurify.sanitize(rawHtml);
  }
}