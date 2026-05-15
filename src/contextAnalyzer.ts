/**
 * Context Analyzer
 *
 * Extracts relevant context (prefix and suffix) around the cursor position
 * for sending to the completion API. Handles language-specific optimizations.
 */

import * as vscode from 'vscode';

export interface CompletionContext {
  /** Code/text before the cursor */
  prefix: string;
  /** Code/text after the cursor */
  suffix: string;
  /** The language ID of the document */
  languageId: string;
  /** Whether we are inside a special context (math mode, string, comment, etc.) */
  inContext: string | null;
}

export class ContextAnalyzer {
  /**
   * Language IDs that are considered "text/prose" documents.
   * These get reduced context (fewer lines) for cost efficiency.
   */
  private static readonly TEXT_LANGUAGES = new Set([
    'plaintext', 'markdown', 'html', 'xml', 'json',
    'yaml', 'toml', 'csv', 'restructuredtext', 'asciidoc',
    'log', 'bibtex', 'texinfo'
  ]);

  /** Programming/code languages that keep full context */
  private static readonly CODE_LANGUAGES = new Set([
    'python', 'javascript', 'typescript', 'typescriptreact', 'javascriptreact',
    'java', 'go', 'rust', 'cpp', 'c', 'csharp', 'swift', 'kotlin',
    'ruby', 'php', 'perl', 'scala', 'haskell', 'lua', 'r',
    'dart', 'julia', 'zig', 'nim', 'elixir', 'erlang',
    'shellscript', 'bash', 'powershell', 'sql', 'dockerfile',
    'latex', 'tex'
  ]);

  /**
   * Detect if a language ID is a text/prose type (limited context).
   */
  static isTextDocument(languageId: string): boolean {
    if (ContextAnalyzer.TEXT_LANGUAGES.has(languageId)) {
      return true;
    }
    if (ContextAnalyzer.CODE_LANGUAGES.has(languageId)) {
      return false;
    }
    // Unknown languages: default to text (conservative with tokens)
    return true;
  }

  constructor() {}

  /**
   * Extract prefix and suffix text around the cursor position.
   * Uses different context window sizes for text vs code files.
   */
  extractContext(
    document: vscode.TextDocument,
    position: vscode.Position
  ): CompletionContext {
    const languageId = document.languageId;
    const config = vscode.workspace.getConfiguration('deepseek-inline-copilot');
    const isText = ContextAnalyzer.isTextDocument(languageId);

    // Use different context windows for text vs code
    const maxPrefixLines = isText
      ? config.get<number>('textMaxPrefixLines', 5)
      : config.get<number>('maxPrefixLines', 60);
    const maxSuffixLines = isText
      ? config.get<number>('textMaxSuffixLines', 3)
      : config.get<number>('maxSuffixLines', 15);

    const totalLines = document.lineCount;

    // Prefix: from max(0, cursorLine - maxPrefixLines) to cursor position
    const prefixStartLine = Math.max(0, position.line - maxPrefixLines);
    const prefixRange = new vscode.Range(
      prefixStartLine, 0,
      position.line, position.character
    );
    let prefix = document.getText(prefixRange);

    // Suffix: from cursor position to min(totalLines-1, cursorLine + maxSuffixLines)
    const suffixEndLine = Math.min(totalLines - 1, position.line + maxSuffixLines);
    const suffixRange = new vscode.Range(
      position.line, position.character,
      suffixEndLine, document.lineAt(suffixEndLine).text.length
    );
    let suffix = document.getText(suffixRange);

    // Detect special contexts
    const inContext = this.detectContext(document, position, languageId);

    // Apply language-specific context enhancements
    if (languageId === 'latex' || languageId === 'tex') {
      const enhanced = this.enhanceLatexContext(document, position, prefix, suffix);
      prefix = enhanced.prefix;
      suffix = enhanced.suffix;
    }

    return { prefix, suffix, languageId, inContext };
  }

  /**
   * Detect if the cursor is inside a special context (math mode, string, comment, etc.).
   */
  private detectContext(
    document: vscode.TextDocument,
    position: vscode.Position,
    languageId: string
  ): string | null {
    const line = document.lineAt(position.line).text;
    const textBeforeCursor = line.substring(0, position.character);

    // Check for comment context
    if (languageId === 'latex' || languageId === 'tex') {
      if (textBeforeCursor.includes('%') &&
          !textBeforeCursor.includes('\\%')) {
        return 'comment';
      }
    } else {
      // For programming languages, check if we're in a line comment
      const commentPatterns: Record<string, string> = {
        'javascript': '//',
        'typescript': '//',
        'python': '#',
        'ruby': '#',
        'shellscript': '#',
        'r': '#',
        'perl': '#',
      };
      const commentToken = commentPatterns[languageId];
      if (commentToken && textBeforeCursor.includes(commentToken)) {
        // Make sure it's not inside a string
        const inString = this.isInString(textBeforeCursor);
        if (!inString) {
          return 'comment';
        }
      }
    }

    // Check for LaTeX math mode
    if (languageId === 'latex' || languageId === 'tex') {
      if (this.isInLatexMath(document, position)) {
        return 'math';
      }
    }

    // Check for string context in programming languages
    if (['python', 'javascript', 'typescript', 'java', 'go', 'rust', 'cpp', 'c'].includes(languageId)) {
      if (this.isInString(textBeforeCursor)) {
        return 'string';
      }
    }

    return null;
  }

  /**
   * Rough check if cursor is inside a string (by counting unescaped quotes).
   */
  private isInString(text: string): boolean {
    let inDouble = false;
    let inSingle = false;
    let inBacktick = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const prev = i > 0 ? text[i - 1] : '';

      if (prev === '\\') continue;

      if (ch === '"' && !inSingle && !inBacktick) inDouble = !inDouble;
      else if (ch === "'" && !inDouble && !inBacktick) inSingle = !inSingle;
      else if (ch === '`' && !inDouble && !inSingle) inBacktick = !inBacktick;
    }

    return inDouble || inSingle || inBacktick;
  }

  /**
   * Check if cursor is inside LaTeX math mode ($...$, $$...$$, \[...\], \(...\), etc.).
   */
  private isInLatexMath(document: vscode.TextDocument, position: vscode.Position): boolean {
    // Check the current line and nearby lines for math delimiters
    const checkLines = 10;
    const startLine = Math.max(0, position.line - checkLines);
    const endLine = Math.min(document.lineCount - 1, position.line);

    let inDisplayMath = false;
    let inInlineMath = false;

    for (let i = startLine; i <= endLine; i++) {
      const line = document.lineAt(i).text;
      // Simple heuristic: count $$ and $ delimiters
      // This is not perfect but works for most cases
      const displayDelims = (line.match(/\$\$/g) || []).length;
      const inlineDelims = (line.match(/(?<!\$)\$(?!\$)/g) || []).length;

      if (i < position.line) {
        inDisplayMath = ((inDisplayMath ? 1 : 0) + displayDelims) % 2 === 1;
        inInlineMath = ((inInlineMath ? 1 : 0) + inlineDelims) % 2 === 1;
      } else if (i === position.line) {
        const textBefore = line.substring(0, position.character);
        const displayBefore = (textBefore.match(/\$\$/g) || []).length;
        const inlineBefore = (textBefore.match(/(?<!\$)\$(?!\$)/g) || []).length;

        inDisplayMath = ((inDisplayMath ? 1 : 0) + displayBefore) % 2 === 1;
        inInlineMath = ((inInlineMath ? 1 : 0) + inlineBefore) % 2 === 1;
      }
    }

    // Also check for \[ \] and \( \) style delimiters
    for (let i = startLine; i <= endLine; i++) {
      const line = document.lineAt(i).text;
      if (i < position.line) {
        if (line.includes('\\[')) inDisplayMath = true;
        if (line.includes('\\]')) inDisplayMath = false;
        if (line.includes('\\(')) inInlineMath = true;
        if (line.includes('\\)')) inInlineMath = false;
      } else if (i === position.line) {
        const textBefore = line.substring(0, position.character);
        if (textBefore.includes('\\[')) inDisplayMath = true;
        if (textBefore.includes('\\]')) inDisplayMath = false;
        if (textBefore.includes('\\(')) inInlineMath = true;
        if (textBefore.includes('\\)')) inInlineMath = false;
      }
    }

    return inDisplayMath || inInlineMath;
  }

  /**
   * Enhance context for LaTeX documents by including preamble/usefull package info.
   */
  private enhanceLatexContext(
    document: vscode.TextDocument,
    position: vscode.Position,
    prefix: string,
    suffix: string
  ): { prefix: string; suffix: string } {
    // If the cursor is after \begin{document}, include key preamble info
    const fullText = document.getText();
    const beginDocMatch = fullText.match(/\\begin\{document\}/);

    if (beginDocMatch && beginDocMatch.index !== undefined) {
      const beginDocPos = document.positionAt(beginDocMatch.index);
      if (position.isAfter(beginDocPos)) {
        // Extract preamble context: documentclass, usepackage lines
        const preamble = fullText.substring(0, beginDocMatch.index);
        const importantLines = preamble
          .split('\n')
          .filter(line =>
            line.includes('\\documentclass') ||
            line.includes('\\usepackage') ||
            line.includes('\\newcommand') ||
            line.includes('\\DeclareMathOperator')
          )
          .join('\n');

        if (importantLines.trim()) {
          // Prepend preamble context to the prefix
          prefix = `% Preamble context:\n${importantLines}\n\n% Current position:\n${prefix}`;
        }
      }
    }

    return { prefix, suffix };
  }
}
