/**
 * DeepSeek API Client
 *
 * Communicates with DeepSeek's FIM (Fill-in-the-Middle) API for inline completions.
 * Falls back to chat completions if FIM endpoint is unavailable.
 */

interface FimRequest {
  model: string;
  prompt: string;
  suffix: string;
  max_tokens: number;
  temperature: number;
  stop?: string[];
  stream?: false;
}

interface FimResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    text: string;
    index: number;
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens: number;
  temperature: number;
  stream?: false;
  thinking?: { type: 'disabled' };
}

interface ChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface CompletionResult {
  text: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface ReviewResult {
  /** Whether the code has errors */
  hasErrors: boolean;
  /** List of errors found */
  errors: Array<{
    /** 1-based line number */
    line: number;
    /** Severity: 'error' or 'warning' */
    severity: 'error' | 'warning';
    /** Description of the problem */
    message: string;
    /** Suggested fix (code) */
    fix: string;
    /** Character range of the issue on that line */
    columnStart?: number;
    columnEnd?: number;
  }>;
}

export class DeepSeekClient {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  // Track ongoing requests for potential cancellation
  private activeController: AbortController | null = null;

  constructor(config: {
    baseUrl: string;
    apiKey: string;
    model: string;
    maxTokens: number;
    temperature: number;
  }) {
    this.baseUrl = config.baseUrl.replace(/\/$/, ''); // strip trailing slash
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.maxTokens = config.maxTokens;
    this.temperature = config.temperature;
  }

  /**
   * Update client configuration at runtime (e.g., when settings change).
   */
  updateConfig(config: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
  }): void {
    if (config.baseUrl !== undefined) {
      this.baseUrl = config.baseUrl.replace(/\/$/, '');
    }
    if (config.apiKey !== undefined) {
      this.apiKey = config.apiKey;
    }
    if (config.model !== undefined) {
      this.model = config.model;
    }
    if (config.maxTokens !== undefined) {
      this.maxTokens = config.maxTokens;
    }
    if (config.temperature !== undefined) {
      this.temperature = config.temperature;
    }
  }

  /**
   * Get a code completion using DeepSeek's FIM (Fill-in-the-Middle) API.
   * Falls back to chat-based completion if FIM is not available.
   */
  async complete(
    prefix: string,
    suffix: string,
    signal?: AbortSignal,
    extraContext?: string
  ): Promise<CompletionResult> {
    // Cancel any previous in-flight request
    if (this.activeController) {
      this.activeController.abort();
    }
    this.activeController = new AbortController();

    // Merge external abort signal with our internal one
    const mergedSignal = signal
      ? this.mergeAbortSignals(signal, this.activeController.signal)
      : this.activeController.signal;

    try {
      // Try FIM endpoint first (preferred for inline completions)
      return await this.completeViaFim(prefix, suffix, mergedSignal);
    } catch (error: any) {
      // If FIM fails with 404 (endpoint not available), fall back to chat
      if (error?.statusCode === 404 || error?.status === 404) {
        console.log('[DeepSeek Copilot] FIM endpoint not available, falling back to chat completions');
        return await this.completeViaChat(prefix, suffix, extraContext, mergedSignal);
      }
      throw error;
    }
  }

  /**
   * Review code for errors and suggest corrections.
   * Uses the chat endpoint to analyze code and find issues.
   */
  async reviewCode(
    code: string,
    languageId: string,
    signal?: AbortSignal,
    maxTokens?: number
  ): Promise<ReviewResult> {
    const url = `${this.baseUrl}/v1/chat/completions`;

    const outputTokens = Math.min(maxTokens || 256, 2048);

    const systemPrompt = [
      'You are a code reviewer. Analyze the given code for errors, bugs, and issues.',
      'Return your findings in STRICT JSON format with this structure:',
      '{',
      '  "hasErrors": true/false,',
      '  "errors": [',
      '    {',
      '      "line": <1-based line number>,',
      '      "severity": "error" or "warning",',
      '      "message": "<description of the problem>",',
      '      "fix": "<suggested corrected code for that line>",',
      '      "columnStart": <optional number>,',
      '      "columnEnd": <optional number>',
      '    }',
      '  ]',
      '}',
      'ONLY output the JSON, no markdown fences, no commentary.',
      'If there are no errors, output {"hasErrors": false, "errors": []}.',
      'Focus on syntax errors, logic bugs, undefined variables, and type issues.',
      `The code language is: ${languageId}.`
    ].join('\n');

    const body: ChatRequest = {
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: code }
      ],
      max_tokens: outputTokens,
      temperature: 0,
      stream: false,
      thinking: { type: 'disabled' }  // non-thinking for speed
    };

    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'Accept': 'application/json'
      },
      body: JSON.stringify(body),
      signal: signal || new AbortController().signal
    }, 10000);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      console.error(`[DeepSeek Copilot] Review error (${response.status}): ${errorBody}`);
      return { hasErrors: false, errors: [] };
    }

    const data = await response.json() as ChatResponse;
    const rawText = data.choices[0]?.message?.content || '';

    // Parse the JSON response, handling markdown code fences
    try {
      const jsonStr = rawText
        .replace(/^```(?:json)?\s*\n?/i, '')
        .replace(/\n?```\s*$/, '')
        .trim();
      const parsed: ReviewResult = JSON.parse(jsonStr);
      return {
        hasErrors: parsed.hasErrors || false,
        errors: Array.isArray(parsed.errors) ? parsed.errors : []
      };
    } catch {
      console.error('[DeepSeek Copilot] Failed to parse review JSON:', rawText);
      return { hasErrors: false, errors: [] };
    }
  }

  /**
   * Use DeepSeek's /beta/completions endpoint for FIM (Fill-in-the-Middle).
   */
  private async completeViaFim(
    prefix: string,
    suffix: string,
    signal: AbortSignal
  ): Promise<CompletionResult> {
    const url = `${this.baseUrl}/beta/completions`;

    const body: FimRequest = {
      model: this.model,
      prompt: prefix,
      suffix: suffix,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      stream: false
    };

    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'Accept': 'application/json'
      },
      body: JSON.stringify(body),
      signal
    }, 8000); // 8 second timeout

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw Object.assign(
        new Error(`DeepSeek API error (${response.status}): ${errorBody}`),
        { statusCode: response.status, status: response.status }
      );
    }

    const data = await response.json() as FimResponse;

    if (!data.choices || data.choices.length === 0) {
      return { text: '' };
    }

    // Trim leading whitespace/newlines from the completion for cleaner insertion
    let text = data.choices[0].text || '';
    // Only trim leading newlines, preserve indentation spaces
    text = text.replace(/^\n+/, '');

    return {
      text,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens
      } : undefined
    };
  }

  /**
   * Fallback: Use chat completions endpoint with a system prompt for FIM-like behavior.
   */
  private async completeViaChat(
    prefix: string,
    suffix: string,
    extraContext: string | undefined,
    signal: AbortSignal
  ): Promise<CompletionResult> {
    const url = `${this.baseUrl}/v1/chat/completions`;

    const systemPrompt = [
      'You are a code completion assistant. Your task is to complete the code at the <CURSOR> position.',
      'ONLY output the code that should appear at the cursor. Do NOT repeat the prefix or suffix.',
      'Do NOT include any explanation, markdown fences, or commentary.',
      'Preserve the exact indentation and style of the surrounding code.',
      extraContext ? `Additional context: ${extraContext}` : ''
    ].filter(Boolean).join('\n');

    const userMessage = [
      'Complete the code at <CURSOR>:',
      '',
      '```',
      prefix,
      '<CURSOR>',
      suffix,
      '```',
      '',
      'Output ONLY the code that replaces <CURSOR>.'
    ].join('\n');

    const body: ChatRequest = {
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      stream: false,
      thinking: { type: 'disabled' }  // non-thinking for speed
    };

    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'Accept': 'application/json'
      },
      body: JSON.stringify(body),
      signal
    }, 10000); // 10 second timeout

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw Object.assign(
        new Error(`DeepSeek API error (${response.status}): ${errorBody}`),
        { statusCode: response.status, status: response.status }
      );
    }

    const data = await response.json() as ChatResponse;

    if (!data.choices || data.choices.length === 0) {
      return { text: '' };
    }

    let text = data.choices[0].message?.content || '';
    // Clean up the response: remove markdown code fences, trim
    text = text.replace(/^```[\s\S]*?\n/, '').replace(/\n```$/, '').trim();
    text = text.replace(/^\n+/, '');

    return {
      text,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens
      } : undefined
    };
  }

  /**
   * Fetch with a timeout. Uses AbortController for cancellation.
   */
  private async fetchWithTimeout(
    url: string,
    options: RequestInit & { signal: AbortSignal },
    timeoutMs: number
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // Merge the provided signal with our timeout signal
    const mergedSignal = this.mergeAbortSignals(options.signal, controller.signal);
    const fetchOptions = { ...options, signal: mergedSignal };

    try {
      const response = await fetch(url, fetchOptions);
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Merge two AbortSignals so that either one aborting triggers the merged signal.
   */
  private mergeAbortSignals(signal1: AbortSignal, signal2: AbortSignal): AbortSignal {
    if (signal1.aborted || signal2.aborted) {
      return AbortSignal.abort();
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal1.addEventListener('abort', onAbort, { once: true });
    signal2.addEventListener('abort', onAbort, { once: true });
    return controller.signal;
  }

  /**
   * Get the current configuration summary (without API key).
   */
  getConfig(): { baseUrl: string; model: string; maxTokens: number; temperature: number } {
    return {
      baseUrl: this.baseUrl,
      model: this.model,
      maxTokens: this.maxTokens,
      temperature: this.temperature
    };
  }
}
