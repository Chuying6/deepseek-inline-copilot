/**
 * Usage Tracker — Daily Quota & Cost Tracking
 *
 * Tracks API token usage per day, converts tokens to monetary cost,
 * enforces daily budget limits, and provides over-limit alerts.
 *
 * Token costs are based on DeepSeek's published pricing:
 *   - deepseek-v4-flash:  input $0.14/1M, output $0.28/1M
 *   - deepseek-v4-pro:    input $0.54/1M, output $1.10/1M
 *   - deepseek-v4 (chat): input $0.27/1M, output $1.10/1M
 *   - default/fallback:   input $0.27/1M, output $1.10/1M
 */

import * as vscode from 'vscode';

/** Pricing per million tokens for each model */
interface ModelPricing {
  inputPricePer1M: number;
  outputPricePer1M: number;
}

/** Known model pricing tiers */
const MODEL_PRICING: Record<string, ModelPricing> = {
  'deepseek-v4-flash': { inputPricePer1M: 0.14, outputPricePer1M: 0.28 },
  'deepseek-v4-pro':   { inputPricePer1M: 0.54, outputPricePer1M: 1.10 },
  'deepseek-v4':       { inputPricePer1M: 0.27, outputPricePer1M: 1.10 },
  'deepseek-chat':     { inputPricePer1M: 0.27, outputPricePer1M: 1.10 },
  'deepseek-coder':    { inputPricePer1M: 0.14, outputPricePer1M: 0.28 },
};

/** Fallback pricing for unknown models */
const DEFAULT_PRICING: ModelPricing = { inputPricePer1M: 0.27, outputPricePer1M: 1.10 };

/** Daily usage data persisted to globalState */
interface DailyUsage {
  /** Date string in YYYY-MM-DD format */
  date: string;
  /** Total input tokens consumed */
  inputTokens: number;
  /** Total output tokens consumed */
  outputTokens: number;
  /** Total estimated cost in USD */
  costUsd: number;
  /** Number of API requests made */
  requestCount: number;
}

/** Format a USD cost value with adaptive precision — shows meaningful digits even for tiny costs. */
export function formatCost(cost: number): string {
  if (cost === 0) return '0.00';
  const abs = Math.abs(cost);
  const precision = abs < 0.001 ? 6 : abs < 0.01 ? 5 : abs < 1 ? 4 : 3;
  let formatted = cost.toFixed(precision);
  // Strip trailing zeros after decimal, keep at least 2 decimals
  if (formatted.includes('.')) {
    formatted = formatted.replace(/(\.\d*?)0+$/, '$1');
    if (formatted.endsWith('.')) formatted = formatted.slice(0, -1);
    const parts = formatted.split('.');
    if (parts.length === 1) formatted += '.00';
    else if (parts[1].length === 1) formatted += '0';
  }
  return formatted;
}

export class UsageTracker {
  private readonly context: vscode.ExtensionContext;
  private currentUsage: DailyUsage;
  private quotaExceededNotified = false;
  private quotaWarningNotified = false;

  /** Status bar item for showing remaining budget */
  private statusBarItem: vscode.StatusBarItem;

  private static readonly STORAGE_KEY = 'deepseek-copilot.dailyUsage';

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.currentUsage = this.loadUsage();

    // Create status bar item (left side, low priority)
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBarItem.command = 'deepseek-inline-copilot.openSettings';
    this.updateStatusBar();
    this.statusBarItem.show();
  }

  // ==================== Public API ====================

  /**
   * Check if the daily budget has been exceeded.
   * Returns true if requests should be BLOCKED.
   */
  isQuotaExceeded(): boolean {
    this.ensureFreshDate();
    const budget = this.getDailyBudget();
    if (budget <= 0) {
      return false; // budget = 0 means unlimited
    }
    return this.currentUsage.costUsd >= budget;
  }

  /**
   * Check if usage is approaching the daily budget (>= 80%).
   */
  isQuotaWarning(): boolean {
    const budget = this.getDailyBudget();
    if (budget <= 0) {
      return false;
    }
    return this.currentUsage.costUsd >= budget * 0.8;
  }

  /**
   * Record a completed API request's token usage.
   *
   * @param model - The model name used (for pricing lookup)
   * @param inputTokens - Prompt tokens consumed
   * @param outputTokens - Completion tokens consumed
   */
  recordUsage(model: string, inputTokens: number, outputTokens: number): void {
    this.ensureFreshDate();

    const pricing = this.getPricing(model);
    const cost =
      (inputTokens / 1_000_000) * pricing.inputPricePer1M +
      (outputTokens / 1_000_000) * pricing.outputPricePer1M;

    this.currentUsage.inputTokens += inputTokens;
    this.currentUsage.outputTokens += outputTokens;
    this.currentUsage.costUsd += cost;
    this.currentUsage.requestCount += 1;

    this.saveUsage();
    this.updateStatusBar();

    // Show alerts based on thresholds
    this.checkAlerts();
  }

  /**
   * Get remaining budget in USD. Returns Infinity if budget is unlimited.
   */
  getRemainingBudget(): number {
    const budget = this.getDailyBudget();
    if (budget <= 0) {
      return Infinity;
    }
    return Math.max(0, budget - this.currentUsage.costUsd);
  }

  /**
   * Get a summary string for display.
   */
  getSummary(): string {
    const budget = this.getDailyBudget();
    const remaining = this.getRemainingBudget();

    let summary = `DeepSeek: $${formatCost(this.currentUsage.costUsd)}`;
    if (budget > 0) {
      summary += ` / $${budget.toFixed(2)}`;
      if (remaining <= 0) {
        summary += ' (exceeded)';
      } else if (remaining < budget * 0.2) {
        summary += ` (${(remaining * 100 / budget).toFixed(0)}% left)`;
      }
    }
    summary += ` | ${this.currentUsage.requestCount} reqs`;
    return summary;
  }

  /**
   * Reset usage for the current day (for debugging/testing).
   */
  resetToday(): void {
    this.currentUsage = this.createEmptyUsage();
    this.saveUsage();
    this.updateStatusBar();
    this.quotaExceededNotified = false;
    this.quotaWarningNotified = false;
  }

  /**
   * Get the current daily usage data (for display/debug).
   */
  getCurrentUsage(): Readonly<DailyUsage> {
    this.ensureFreshDate();
    return { ...this.currentUsage };
  }

  /**
   * Dispose the status bar item.
   */
  dispose(): void {
    this.statusBarItem.dispose();
  }

  // ==================== Private Methods ====================

  /**
   * Load usage from globalState, resetting if it's a new day.
   */
  private loadUsage(): DailyUsage {
    const stored = this.context.globalState.get<DailyUsage>(UsageTracker.STORAGE_KEY);
    if (stored && stored.date === this.getToday()) {
      return stored;
    }
    return this.createEmptyUsage();
  }

  /**
   * Ensure the usage data is for today (reset if date changed).
   */
  private ensureFreshDate(): void {
    if (this.currentUsage.date !== this.getToday()) {
      this.currentUsage = this.createEmptyUsage();
      this.quotaExceededNotified = false;
      this.quotaWarningNotified = false;
      this.updateStatusBar();
    }
  }

  private getToday(): string {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  private createEmptyUsage(): DailyUsage {
    return {
      date: this.getToday(),
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      requestCount: 0
    };
  }

  private saveUsage(): void {
    this.context.globalState.update(UsageTracker.STORAGE_KEY, this.currentUsage);
  }

  /**
   * Get pricing for a given model name.
   * Uses custom pricing from config if set, otherwise looks up known models.
   */
  private getPricing(model: string): ModelPricing {
    // Check for custom pricing in config
    const config = vscode.workspace.getConfiguration('deepseek-inline-copilot');
    const customInput = config.get<number>('inputPricePer1M', 0);
    const customOutput = config.get<number>('outputPricePer1M', 0);

    if (customInput > 0 || customOutput > 0) {
      return {
        inputPricePer1M: customInput > 0 ? customInput : DEFAULT_PRICING.inputPricePer1M,
        outputPricePer1M: customOutput > 0 ? customOutput : DEFAULT_PRICING.outputPricePer1M,
      };
    }

    // Exact match first
    if (MODEL_PRICING[model]) {
      return MODEL_PRICING[model];
    }
    // Prefix match (e.g., "deepseek-v4-flash-custom" matches "deepseek-v4-flash")
    for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
      if (model.startsWith(key)) {
        return pricing;
      }
    }
    return DEFAULT_PRICING;
  }

  private getDailyBudget(): number {
    const config = vscode.workspace.getConfiguration('deepseek-inline-copilot');
    return config.get<number>('dailyBudgetUsd', 0.50);
  }

  public updateStatusBar(): void {
    const budget = this.getDailyBudget();
    const remaining = this.getRemainingBudget();

    if (budget <= 0) {
      // Unlimited budget
      this.statusBarItem.text = `$(dashboard) DeepSeek: $${formatCost(this.currentUsage.costUsd)}`;
      this.statusBarItem.tooltip = `Usage today: $${formatCost(this.currentUsage.costUsd)} | ${this.currentUsage.requestCount} requests | Budget: unlimited`;
      this.statusBarItem.backgroundColor = undefined;
    } else if (remaining <= 0) {
      this.statusBarItem.text = `$(circle-slash) DeepSeek: limit reached`;
      this.statusBarItem.tooltip = `Daily budget exhausted: $${formatCost(this.currentUsage.costUsd)} / $${budget.toFixed(2)} | Click to adjust settings`;
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (remaining < budget * 0.2) {
      this.statusBarItem.text = `$(warning) DeepSeek: $${formatCost(this.currentUsage.costUsd)} / $${budget.toFixed(2)}`;
      this.statusBarItem.tooltip = `Approaching daily limit! $${formatCost(remaining)} remaining | ${this.currentUsage.requestCount} requests today`;
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.statusBarItem.text = `$(dashboard) DeepSeek: $${formatCost(this.currentUsage.costUsd)} / $${budget.toFixed(2)}`;
      this.statusBarItem.tooltip = `Daily usage: $${formatCost(this.currentUsage.costUsd)} of $${budget.toFixed(2)} | ${this.currentUsage.requestCount} requests today | Click to adjust budget`;
      this.statusBarItem.backgroundColor = undefined;
    }
  }

  /**
   * Show alert notifications when thresholds are crossed.
   */
  private checkAlerts(): void {
    const budget = this.getDailyBudget();
    if (budget <= 0) {
      return;
    }

    const remaining = this.getRemainingBudget();
    const costStr = `$${formatCost(this.currentUsage.costUsd)} of $${budget.toFixed(2)}`;

    // Warning at 80%
    if (!this.quotaWarningNotified && remaining <= budget * 0.2 && remaining > 0) {
      this.quotaWarningNotified = true;
      vscode.window.showWarningMessage(
        `⚠️ DeepSeek Copilot: Approaching daily budget limit (${costStr}). ` +
        `Only $${formatCost(remaining)} remaining. Consider increasing the budget in settings.`,
        'Open Settings',
        'Dismiss'
      ).then(choice => {
        if (choice === 'Open Settings') {
          vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'deepseek-inline-copilot.dailyBudgetUsd'
          );
        }
      });
    }

    // Exceeded notification
    if (!this.quotaExceededNotified && remaining <= 0) {
      this.quotaExceededNotified = true;
      vscode.window.showErrorMessage(
        `🛑 DeepSeek Copilot: Daily budget EXCEEDED (${costStr}). ` +
        `Completions are now blocked until tomorrow. Increase the budget or wait for reset.`,
        'Open Settings',
        'Reset & Continue'
      ).then(choice => {
        if (choice === 'Open Settings') {
          vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'deepseek-inline-copilot.dailyBudgetUsd'
          );
        } else if (choice === 'Reset & Continue') {
          const config = vscode.workspace.getConfiguration('deepseek-inline-copilot');
          config.update('dailyBudgetUsd', budget * 2, vscode.ConfigurationTarget.Global);
          this.quotaExceededNotified = false;
          this.quotaWarningNotified = false;
          this.updateStatusBar();
          vscode.window.showInformationMessage(
            `DeepSeek Copilot: Budget doubled to $${(budget * 2).toFixed(2)}. Completions resumed.`
          );
        }
      });
    }
  }
}
