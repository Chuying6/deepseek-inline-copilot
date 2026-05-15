/**
 * DeepSeek Inline Completion Provider
 *
 * Implements VS Code's InlineCompletionItemProvider to provide
 * AI-powered inline suggestions using the DeepSeek API.
 */

import * as vscode from 'vscode';
import { DeepSeekClient, CompletionResult } from './deepseekClient';
import { ContextAnalyzer, CompletionContext } from './contextAnalyzer';

export class DeepSeekCompletionProvider implements vscode.InlineCompletionItemProvider {
  private readonly client: DeepSeekClient;
  private readonly contextAnalyzer: ContextAnalyzer;
  private readonly debounceMs: number;

  // Track the latest request to avoid race conditions
  private lastRequestId = 0;

  // Platform-aware shortcut labels
  private static readonly TOGGLE_SHORTCUT = process.platform === 'darwin' ? '⌘⇧P' : 'Ctrl+Shift+P';

  // Status bar item
  private statusBarItem: vscode.StatusBarItem;

  // Request timeout tracker
  private requestTimer: ReturnType<typeof setTimeout> | null = null;

  // === Cooldown between requests to save API tokens ===
  private lastCompletionTimes = new Map<string, number>();
  private getCooldownMs(): number {
    const config = vscode.workspace.getConfiguration('deepseek-inline-copilot');
    return config.get<number>('completionCooldownMs', 7000);
  }

  constructor(
    client: DeepSeekClient,
    contextAnalyzer: ContextAnalyzer,
    debounceMs: number = 300
  ) {
    this.client = client;
    this.contextAnalyzer = contextAnalyzer;
    this.debounceMs = debounceMs;

    // Create status bar item (right-aligned)
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      99
    );
    this.statusBarItem.command = 'deepseek-inline-copilot.openSettings';
    this.statusBarItem.tooltip = `DeepSeek Copilot: ready | Click → Settings | Toggle → ${DeepSeekCompletionProvider.TOGGLE_SHORTCUT}`;
    this.updateStatusBar(false);
    this.statusBarItem.show();
  }

  /**
   * Core method: provide inline completion items at the given position.
   */
  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[]> {
    // Check if extension is enabled
    const config = vscode.workspace.getConfiguration('deepseek-inline-copilot');
    if (!config.get<boolean>('enabled', true)) {
      return [];
    }

    // Check trigger mode: "manual" mode only responds to explicit Tab press
    const triggerMode = config.get<string>('triggerMode', 'auto');
    if (triggerMode === 'manual' && context.triggerKind !== vscode.InlineCompletionTriggerKind.Invoke) {
      return [];
    }

    // Cooldown: skip if last completion was too recent (saves API tokens)
    // Per-document: switching files resets the cooldown
    const now = Date.now();
    const cooldownMs = this.getCooldownMs();
    const docUri = document.uri.toString();
    const lastTime = this.lastCompletionTimes.get(docUri) || 0;
    if (now - lastTime < cooldownMs) {
      return [];
    }

    // Check language filter
    const languageFilters = config.get<string[]>('languageFilters', []);
    if (languageFilters.length > 0 && !languageFilters.includes(document.languageId)) {
      return [];
    }

    // Skip empty lines (reduce unnecessary API calls)
    const currentLine = document.lineAt(position.line).text;
    const textBeforeCursor = currentLine.substring(0, position.character).trimEnd();
    if (textBeforeCursor.length === 0 && position.character === 0) {
      // Empty line - only suggest if manually triggered
      if (context.triggerKind !== vscode.InlineCompletionTriggerKind.Invoke) {
        return [];
      }
    }

    // Generate a unique request ID to handle race conditions
    const requestId = ++this.lastRequestId;
    const debounceMs = config.get<number>('debounceMs', 300);

    // Debounce: wait before making the API call
    if (this.requestTimer) {
      clearTimeout(this.requestTimer);
    }

    return new Promise<vscode.InlineCompletionItem[]>((resolve) => {
      this.requestTimer = setTimeout(async () => {
        // Check cancellation
        if (token.isCancellationRequested || requestId !== this.lastRequestId) {
          resolve([]);
          return;
        }

        try {
          this.updateStatusBar(true);

          // Extract context (prefix and suffix)
          const completionContext = this.contextAnalyzer.extractContext(document, position);

          // Call DeepSeek API
          const result = await this.client.complete(
            completionContext.prefix,
            completionContext.suffix,
            this.createAbortSignal(token),
            this.buildExtraContext(completionContext)
          );

          // Check if this request is still the latest
          if (requestId !== this.lastRequestId || token.isCancellationRequested) {
            resolve([]);
            return;
          }

          this.updateStatusBar(false);

          // Return empty if no completion generated
          if (!result.text || result.text.trim().length === 0) {
            resolve([]);
            return;
          }

          // Create the inline completion item
          const completionText = this.postProcessCompletion(
            result.text,
            document,
            position,
            completionContext
          );

          if (!completionText) {
            resolve([]);
            return;
          }

          const item = new vscode.InlineCompletionItem(
            completionText,
            new vscode.Range(position, position)
          );

          // Record completion time for cooldown (per-document)
          this.lastCompletionTimes.set(document.uri.toString(), Date.now());

          // Log usage for debugging
          if (result.usage) {
            console.log(
              `[DeepSeek Copilot] Tokens: ${result.usage.totalTokens} ` +
              `(prompt: ${result.usage.promptTokens}, completion: ${result.usage.completionTokens})`
            );
          }

          resolve([item]);
        } catch (error: any) {
          this.updateStatusBar(false, true);

          if (error.name === 'AbortError' || error.message?.includes('abort')) {
            // Request was cancelled - no need to show error
            resolve([]);
            return;
          }

          // Log the error but don't show to user (avoid noise)
          console.error('[DeepSeek Copilot] Completion error:', error.message);

          // Show error in status bar briefly
          this.showStatusError(error.message);

          resolve([]);
        }
      }, debounceMs);

      // Also set up cancellation listener
      token.onCancellationRequested(() => {
        if (this.requestTimer) {
          clearTimeout(this.requestTimer);
          this.requestTimer = null;
        }
        resolve([]);
      });
    });
  }

  /**
   * Post-process the completion text to clean up and improve quality.
   */
  private postProcessCompletion(
    text: string,
    document: vscode.TextDocument,
    position: vscode.Position,
    context: CompletionContext
  ): string {
    // Remove any markdown code fences that might appear in chat fallback
    text = text.replace(/^```[\w]*\n?/gm, '').replace(/\n?```$/gm, '');

    // If the completion starts with a newline, trim it
    text = text.replace(/^\n+/, '');

    // If the completion text is empty after cleanup, return null
    if (text.trim().length === 0) {
      return '';
    }

    // For LaTeX: ensure the completion doesn't start with duplicate text
    if (context.languageId === 'latex' || context.languageId === 'tex') {
      const currentLine = document.lineAt(position.line).text;
      const textBeforeCursor = currentLine.substring(0, position.character);

      // If completion starts with what's already typed, remove the overlap
      if (textBeforeCursor.length > 0) {
        const overlap = this.findOverlap(textBeforeCursor, text);
        if (overlap > 0) {
          text = text.substring(overlap);
        }
      }
    }

    return text;
  }

  /**
   * Find the overlap between what's already typed and the beginning of the completion.
   */
  private findOverlap(typed: string, completion: string): number {
    const maxOverlap = Math.min(typed.length, completion.length);
    for (let i = maxOverlap; i > 0; i--) {
      const typedEnd = typed.substring(typed.length - i);
      const completionStart = completion.substring(0, i);
      if (typedEnd === completionStart) {
        return i;
      }
    }
    return 0;
  }

  /**
   * Build extra context string for the chat fallback.
   */
  private buildExtraContext(context: CompletionContext): string {
    const parts: string[] = [];
    parts.push(`Language: ${context.languageId}`);
    if (context.inContext) {
      parts.push(`Current context: ${context.inContext}`);
    }
    return parts.join('. ');
  }

  /**
   * Create an AbortSignal from VS Code's CancellationToken.
   */
  private createAbortSignal(token: vscode.CancellationToken): AbortSignal {
    const controller = new AbortController();
    if (token.isCancellationRequested) {
      controller.abort();
    }
    token.onCancellationRequested(() => controller.abort());
    return controller.signal;
  }

  /**
   * Update the status bar item.
   */
  updateStatusBar(loading: boolean, error: boolean = false): void {
    const config = vscode.workspace.getConfiguration('deepseek-inline-copilot');
    const enabled = config.get<boolean>('enabled', true);

    if (!enabled) {
      this.statusBarItem.text = '$(circle-slash) DeepSeek';
      this.statusBarItem.tooltip = `DeepSeek Copilot: disabled | Click → Settings | Toggle → ${DeepSeekCompletionProvider.TOGGLE_SHORTCUT}`;
      this.statusBarItem.backgroundColor = undefined;
    } else if (loading) {
      this.statusBarItem.text = '$(sync~spin) DeepSeek';
      this.statusBarItem.tooltip = 'DeepSeek Copilot: generating suggestion...';
      this.statusBarItem.backgroundColor = undefined;
    } else if (error) {
      this.statusBarItem.text = '$(error) DeepSeek';
      this.statusBarItem.tooltip = 'DeepSeek Copilot: last request failed';
    } else {
      this.statusBarItem.text = '$(sparkle) DeepSeek';
      this.statusBarItem.tooltip = `DeepSeek Copilot: ready | Click → Settings | Toggle → ${DeepSeekCompletionProvider.TOGGLE_SHORTCUT}`;
    }
  }

  /**
   * Show a temporary error in the status bar.
   */
  private showStatusError(message: string): void {
    this.statusBarItem.text = '$(error) DeepSeek';
    const shortMsg = message.length > 60 ? message.substring(0, 57) + '...' : message;
    this.statusBarItem.tooltip = `DeepSeek Copilot error: ${shortMsg}`;

    // Reset after 5 seconds
    setTimeout(() => {
      this.updateStatusBar(false);
    }, 5000);
  }

  /**
   * Dispose of resources.
   */
  dispose(): void {
    if (this.requestTimer) {
      clearTimeout(this.requestTimer);
    }
    this.statusBarItem.dispose();
  }
}
