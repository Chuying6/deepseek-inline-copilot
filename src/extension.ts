/**
 * DeepSeek Inline Copilot - VS Code Extension Entry Point
 *
 * Provides AI-powered inline code suggestions using the DeepSeek API,
 * similar to GitHub Copilot's inline suggestions feature.
 */

import * as vscode from 'vscode';
import { DeepSeekClient } from './deepseekClient';
import { ContextAnalyzer } from './contextAnalyzer';
import { DeepSeekCompletionProvider } from './completionProvider';
import { DiagnosticsProvider } from './diagnosticsProvider';
import { UsageTracker } from './usageTracker';

let provider: DeepSeekCompletionProvider | undefined;
let diagnosticsProvider: DiagnosticsProvider | undefined;
let usageTracker: UsageTracker | undefined;
let registration: vscode.Disposable | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('[DeepSeek Copilot] Activating extension...');

  // Read initial configuration
  const config = vscode.workspace.getConfiguration('deepseek-inline-copilot');
  const apiKey = config.get<string>('apiKey', '');

  if (!apiKey) {
    // Show a one-time notification to configure the API key
    vscode.window.showInformationMessage(
      'DeepSeek Inline Copilot: Please set your API key in settings.',
      'Open Settings'
    ).then(selection => {
      if (selection === 'Open Settings') {
        vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'deepseek-inline-copilot.apiKey'
        );
      }
    });
  }

  // Create the DeepSeek client
  const client = createClient();

  // Create the context analyzer (reads config at runtime)
  const contextAnalyzer = new ContextAnalyzer();

  // Create the usage tracker (daily budget & cost tracking)
  usageTracker = new UsageTracker(context);
  context.subscriptions.push(usageTracker);

  // Create the completion provider
  provider = new DeepSeekCompletionProvider(
    client,
    contextAnalyzer,
    usageTracker,
    config.get<number>('debounceMs', 300)
  );

  // Register the inline completion provider for all document types
  registration = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: '**' },
    provider
  );

  context.subscriptions.push(registration);

  // Create and start the diagnostics provider (error checking)
  diagnosticsProvider = new DiagnosticsProvider(
    client,
    config.get<number>('errorCheckDebounceMs', 1500)
  );
  context.subscriptions.push(diagnosticsProvider.startListening());

  // Register toggle command
  const toggleCmd = vscode.commands.registerCommand(
    'deepseek-inline-copilot.toggle',
    async () => {
      const currentConfig = vscode.workspace.getConfiguration('deepseek-inline-copilot');
      const enabled = currentConfig.get<boolean>('enabled', true);
      const newState = !enabled;
      await currentConfig.update('enabled', newState, vscode.ConfigurationTarget.Global);

      // Update status bar immediately
      provider?.updateStatusBar(false);

      vscode.window.showInformationMessage(
        `DeepSeek Copilot: ${newState ? 'Enabled 已启用' : 'Disabled 已禁用'}`
      );
    }
  );
  context.subscriptions.push(toggleCmd);

  // Register manual trigger command
  const triggerCmd = vscode.commands.registerCommand(
    'deepseek-inline-copilot.triggerSuggestion',
    () => {
      vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    }
  );
  context.subscriptions.push(triggerCmd);

  // Register: review current document for errors
  const reviewCmd = vscode.commands.registerCommand(
    'deepseek-inline-copilot.reviewDocument',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('DeepSeek Copilot: No active editor.');
        return;
      }
      await diagnosticsProvider?.reviewDocument(editor.document);
      vscode.window.showInformationMessage('DeepSeek Copilot: Document review complete.');
    }
  );
  context.subscriptions.push(reviewCmd);

  // Register: clear all diagnostics
  const clearErrorsCmd = vscode.commands.registerCommand(
    'deepseek-inline-copilot.clearErrors',
    () => {
      diagnosticsProvider?.clearAll();
    }
  );
  context.subscriptions.push(clearErrorsCmd);

  // Register: show usage statistics
  const showUsageCmd = vscode.commands.registerCommand(
    'deepseek-inline-copilot.showUsage',
    () => {
      if (!usageTracker) {
        vscode.window.showInformationMessage('DeepSeek Copilot: Usage tracker not available.');
        return;
      }
      const usage = usageTracker.getCurrentUsage();
      const budget = vscode.workspace.getConfiguration('deepseek-inline-copilot')
        .get<number>('dailyBudgetUsd', 0.50);
      const remaining = usageTracker.getRemainingBudget();

      const message = [
        `📊 DeepSeek Copilot — Today's Usage (${usage.date})`,
        `─────────────────────────────`,
        `💰 Cost:        $${usage.costUsd.toFixed(4)}`,
        budget > 0
          ? `📥 Budget:      $${budget.toFixed(2)} (${remaining === Infinity ? 'unlimited' : '$' + remaining.toFixed(4) + ' remaining'})`
          : `📥 Budget:      unlimited`,
        `🔢 Requests:    ${usage.requestCount}`,
        `📝 Input tokens:  ${usage.inputTokens.toLocaleString()}`,
        `📤 Output tokens: ${usage.outputTokens.toLocaleString()}`,
        `📊 Total tokens:  ${(usage.inputTokens + usage.outputTokens).toLocaleString()}`,
      ].join('\n');

      vscode.window.showInformationMessage(
        message,
        { modal: true },
        'OK'
      );
    }
  );
  context.subscriptions.push(showUsageCmd);

  // Register: open settings (via status bar click)
  const openSettingsCmd = vscode.commands.registerCommand(
    'deepseek-inline-copilot.openSettings',
    () => {
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'deepseek-inline-copilot'
      );
    }
  );
  context.subscriptions.push(openSettingsCmd);

  // Listen for configuration changes
  const configListener = vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('deepseek-inline-copilot')) {
      console.log('[DeepSeek Copilot] Configuration changed, updating...');

      // Update client with new settings
      const config = vscode.workspace.getConfiguration('deepseek-inline-copilot');
      client.updateConfig({
        apiKey: config.get<string>('apiKey', ''),
        model: config.get<string>('model', 'deepseek-v4-flash'),
        baseUrl: config.get<string>('baseUrl', 'https://api.deepseek.com'),
        maxTokens: config.get<number>('maxTokens', 256),
        temperature: config.get<number>('temperature', 0),
      });

      // Update status bar to reflect enabled/disabled state
      provider?.updateStatusBar(false);

      // If error checking was toggled off, clear existing diagnostics
      if (!config.get<boolean>('errorCheck', true)) {
        diagnosticsProvider?.clearAll();
      }
    }
  });
  context.subscriptions.push(configListener);

  console.log('[DeepSeek Copilot] Extension activated successfully');
}

export function deactivate() {
  console.log('[DeepSeek Copilot] Deactivating extension...');

  if (diagnosticsProvider) {
    diagnosticsProvider.dispose();
    diagnosticsProvider = undefined;
  }

  if (provider) {
    provider.dispose();
    provider = undefined;
  }

  if (usageTracker) {
    usageTracker.dispose();
    usageTracker = undefined;
  }

  if (registration) {
    registration.dispose();
    registration = undefined;
  }
}

/**
 * Create a DeepSeekClient from current VS Code settings.
 */
function createClient(): DeepSeekClient {
  const config = vscode.workspace.getConfiguration('deepseek-inline-copilot');

  return new DeepSeekClient({
    baseUrl: config.get<string>('baseUrl', 'https://api.deepseek.com'),
    apiKey: config.get<string>('apiKey', ''),
    model: config.get<string>('model', 'deepseek-v4-flash'),
    maxTokens: config.get<number>('maxTokens', 256),
    temperature: config.get<number>('temperature', 0)
  });
}
