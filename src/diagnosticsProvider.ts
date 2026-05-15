/**
 * Diagnostics Provider — Real-time Error Checking & Correction
 *
 * Listens for document changes, sends code to DeepSeek for review,
 * and displays diagnostics with suggested fixes directly in the editor.
 */

import * as vscode from 'vscode';
import { DeepSeekClient, ReviewResult } from './deepseekClient';

export class DiagnosticsProvider {
  private readonly client: DeepSeekClient;
  private readonly diagnosticCollection: vscode.DiagnosticCollection;
  private readonly debounceMs: number;

  // Per-document debounce timers and abort controllers
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private activeControllers = new Map<string, AbortController>();

  constructor(client: DeepSeekClient, debounceMs: number = 1500) {
    this.client = client;
    this.debounceMs = debounceMs;

    // Create diagnostic collection for error highlighting
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection(
      'deepseek-copilot-errors'
    );
  }

  /**
   * Start listening to document changes for error checking.
   */
  startListening(): vscode.Disposable {
    const listener = vscode.workspace.onDidChangeTextDocument(e => {
      this.onDocumentChanged(e.document);
    });

    // Also check newly opened documents
    const openListener = vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor) {
        this.onDocumentChanged(editor.document);
      }
    });

    return {
      dispose: () => {
        listener.dispose();
        openListener.dispose();
      }
    };
  }

  /**
   * Review the entire visible portion of a document for errors.
   * Called manually via command or after a line change.
   */
  async reviewDocument(document: vscode.TextDocument): Promise<void> {
    const config = vscode.workspace.getConfiguration('deepseek-inline-copilot');
    if (!config.get<boolean>('errorCheck', true)) {
      return;
    }

    const languageId = document.languageId;

    // Skip files that are too large
    if (document.lineCount > 500) {
      return;
    }

    // Get only lines around the most recently edited area (configurable)
    const maxLines = config.get<number>('errorCheckMaxLines', 10);
    const editor = vscode.window.activeTextEditor;
    let text: string;
    if (editor && editor.document === document) {
      const halfLines = Math.floor(maxLines / 2);
      const cursorLine = editor.selection.active.line;
      const startLine = Math.max(0, cursorLine - halfLines);
      const endLine = Math.min(document.lineCount - 1, cursorLine + halfLines);
      const range = new vscode.Range(
        startLine, 0,
        endLine, document.lineAt(endLine).text.length
      );
      text = document.getText(range);
    } else {
      const endLine = Math.min(maxLines, document.lineCount - 1);
      const range = new vscode.Range(0, 0, endLine, document.lineAt(endLine).text.length);
      text = document.getText(range);
    }

    if (text.length < 10) {
      return;
    }

    // Cancel any pending review for this document
    const docUri = document.uri.toString();
    this.activeControllers.get(docUri)?.abort();
    const controller = new AbortController();
    this.activeControllers.set(docUri, controller);

    try {
      console.log(`[DeepSeek Copilot] Reviewing: ${document.fileName}`);
      const reviewMaxTokens = config.get<number>('reviewMaxTokens', 256);
      const result = await this.client.reviewCode(text, languageId, controller.signal, reviewMaxTokens);

      if (controller.signal.aborted) {
        return;
      }

      // Convert review results to VS Code diagnostics
      const diagnostics = this.convertToDiagnostics(result, document);

      // Apply diagnostics to the document
      this.diagnosticCollection.set(document.uri, diagnostics);

      if (result.errors.length > 0) {
        console.log(
          `[DeepSeek Copilot] Found ${result.errors.length} issue(s) in ${document.fileName}`
        );
      }
    } catch (error: any) {
      if (error.name === 'AbortError' || error.message?.includes('abort')) {
        return; // Normal cancellation
      }
      console.error('[DeepSeek Copilot] Review error:', error.message);
    } finally {
      this.activeControllers.delete(docUri);
    }
  }

  /**
   * Convert ReviewResult errors into VS Code Diagnostics.
   */
  private convertToDiagnostics(
    result: ReviewResult,
    document: vscode.TextDocument
  ): vscode.Diagnostic[] {
    return result.errors.map(err => {
      // Determine the range for the diagnostic
      const line = Math.max(0, Math.min(err.line - 1, document.lineCount - 1));
      const lineText = document.lineAt(line).text;

      const startCol = err.columnStart !== undefined
        ? Math.min(err.columnStart, lineText.length)
        : 0;
      const endCol = err.columnEnd !== undefined
        ? Math.min(err.columnEnd, lineText.length)
        : lineText.length;

      const range = new vscode.Range(line, startCol, line, endCol);

      // Map severity
      const severity = err.severity === 'error'
        ? vscode.DiagnosticSeverity.Error
        : vscode.DiagnosticSeverity.Warning;

      const diagnostic = new vscode.Diagnostic(
        range,
        `[DeepSeek] ${err.message}`,
        severity
      );

      diagnostic.source = 'DeepSeek Copilot';
      diagnostic.code = 'deepseek-review';

      // If a fix is provided, attach it as related information
      if (err.fix && err.fix.trim().length > 0) {
        diagnostic.relatedInformation = [
          new vscode.DiagnosticRelatedInformation(
            new vscode.Location(document.uri, range),
            `💡 Suggested fix: ${err.fix}`
          )
        ];
      }

      return diagnostic;
    });
  }

  /**
   * Called when a document changes. Debounce per-document to avoid race conditions.
   */
  private onDocumentChanged(document: vscode.TextDocument): void {
    const config = vscode.workspace.getConfiguration('deepseek-inline-copilot');
    if (!config.get<boolean>('errorCheck', true)) {
      return;
    }

    const docUri = document.uri.toString();

    // Per-document debounce: avoid multiple documents stepping on each other
    const existing = this.debounceTimers.get(docUri);
    if (existing) {
      clearTimeout(existing);
    }

    this.debounceTimers.set(docUri, setTimeout(() => {
      this.debounceTimers.delete(docUri);
      this.reviewDocument(document);
    }, this.debounceMs));
  }

  /**
   * Clear diagnostics for a specific document.
   */
  clearDiagnostics(uri: vscode.Uri): void {
    this.diagnosticCollection.delete(uri);
  }

  /**
   * Clear all diagnostics.
   */
  clearAll(): void {
    this.diagnosticCollection.clear();
  }

  /**
   * Dispose all resources.
   */
  dispose(): void {
    // Clear all per-document timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    // Abort all pending requests
    for (const controller of this.activeControllers.values()) {
      controller.abort();
    }
    this.activeControllers.clear();
    this.diagnosticCollection.clear();
    this.diagnosticCollection.dispose();
  }
}
