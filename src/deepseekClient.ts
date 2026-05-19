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
  /** The model that generated this completion (for cost tracking) */
  model: string;
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
    const url = `${this.baseUrl}/chat/completions`;

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
      stream: false,
      stop: this.buildFimStopSequences(suffix)
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
      return { text: '', model: this.model };
    }

    // Trim leading whitespace/newlines from the completion for cleaner insertion
    let text = data.choices[0].text || '';
    // Only trim leading newlines, preserve indentation spaces
    text = text.replace(/^\n+/, '');

    return {
      text,
      model: this.model,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens
      } : undefined
    };
  }

  /**
   * Fallback: Use chat completions endpoint with an optimized system prompt
   * designed to maximize completion accuracy (hit rate).
   */
  private async completeViaChat(
    prefix: string,
    suffix: string,
    extraContext: string | undefined,
    signal: AbortSignal
  ): Promise<CompletionResult> {
    const url = `${this.baseUrl}/chat/completions`;

    // Build a comprehensive system prompt for high-quality completions.
    // The prompt is engineered to:
    // 1. Prevent the model from repeating existing code
    // 2. Encourage idiomatic, style-consistent output
    // 3. Handle edge cases (empty suffix, single-line completions, etc.)
    // 4. Support multiple languages through dynamic context hints
    const systemPrompt = this.buildSystemPrompt(extraContext);

    // User message with clear delimiters so the model understands
    // exactly where the cursor is and what text surrounds it.
    const userMessage = this.buildUserMessage(prefix, suffix);

    // Use stop sequences to prevent the model from continuing past the natural
    // completion point (e.g., generating the suffix that already exists).
    const stopSequences = this.buildStopSequences(suffix);

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
      return { text: '', model: this.model };
    }

    let text = data.choices[0].message?.content || '';

    // Apply post-processing to clean the model's output
    text = this.cleanChatCompletion(text, prefix, suffix);

    return {
      text,
      model: this.model,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens
      } : undefined
    };
  }

  /**
   * Build an optimized system prompt for code completion.
   * The prompt is structured to maximize "hit rate" — the percentage
   * of suggestions that the user accepts.
   */
  private buildSystemPrompt(extraContext?: string): string {
    const parts: string[] = [
      // Identity and core task
      'You are an expert code completion engine embedded in an IDE.',
      'Your sole task: generate the EXACT code that should appear at the <CURSOR> marker.',

      // Critical rules — ordered by impact on hit rate
      '',
      '## CRITICAL RULES (follow strictly):',
      '1. Output ONLY the insertion text. No explanations, no markdown fences, no code blocks.',
      '2. NEVER repeat or echo the prefix (code before <CURSOR>) or suffix (code after <CURSOR>).',
      '3. Match the EXACT indentation style of the surrounding code (tabs/spaces, indent width).',
      '4. If the line before cursor is incomplete, complete just that line naturally.',
      '5. For multi-line completions, ensure balanced braces, brackets, and parentheses.',
      '6. Prefer the MOST LIKELY completion — be predictable, not creative.',
      '7. If the context is a comment or docstring, generate code that matches the description.',

      // Quality heuristics
      '',
      '## QUALITY GUIDELINES:',
      '- Use the same coding style (camelCase/snake_case, semicolons, quote type) as the prefix.',
      '- Match the variable naming conventions visible in the surrounding code.',
      '- For function calls: prefer arguments consistent with the nearby code patterns.',
      '- For imports/includes: only suggest imports that are already used in the file.',
      '- When suffix is non-empty, ensure your completion flows seamlessly into it.',
      '- When suffix is empty (end of file), you may close the current block/function.',
      '- In string literals: complete the string content, not just close the quote.',
      '- In comments: do NOT generate code, just complete the comment naturally.',
    ];

    if (extraContext) {
      parts.push('');
      parts.push(`## CURRENT FILE CONTEXT:\n${extraContext}`);
    }

    return parts.join('\n');
  }

  /**
   * Build the user message with clear cursor markers.
   */
  private buildUserMessage(prefix: string, suffix: string): string {
    const lines: string[] = [];
    lines.push('Complete the code at <CURSOR>. The text before and after is shown below.');
    lines.push('');
    lines.push('<BEFORE_CURSOR>');
    lines.push(prefix);
    lines.push('</BEFORE_CURSOR>');
    lines.push('<CURSOR>');
    lines.push('</CURSOR>');
    lines.push('<AFTER_CURSOR>');
    lines.push(suffix || '(end of file)');
    lines.push('</AFTER_CURSOR>');
    lines.push('');
    lines.push('Generate ONLY the code that belongs between <CURSOR> and </CURSOR>.');
    return lines.join('\n');
  }

  /**
   * Build stop sequences for the FIM endpoint.
   * FIM models often continue until they hit the suffix, so we need
   * stop sequences to prevent generating text that already exists.
   */
  private buildFimStopSequences(suffix: string): string[] {
    const stops: string[] = [];
    if (suffix) {
      // First non-empty line of the suffix
      const firstLine = suffix.split('\n').find(l => l.trim().length > 0);
      if (firstLine && firstLine.trim().length >= 2) {
        stops.push(firstLine);
      }
      // Also add common structural stops
      stops.push('\n\n\n'); // triple newline (likely end of completion)
    }
    return stops;
  }

  /**
   * Build stop sequences based on the suffix, so the model doesn't
   * generate text that already exists after the cursor.
   */
  private buildStopSequences(suffix: string): string[] {
    const stops: string[] = [];
    if (suffix) {
      // Use the first line of the suffix as a stop sequence
      const firstLine = suffix.split('\n')[0].trim();
      if (firstLine.length >= 3) {
        stops.push(firstLine);
      }
    }
    return stops;
  }

  /**
   * Clean up the chat completion output to remove artifacts
   * and handle common failure modes.
   */
  private cleanChatCompletion(
    text: string,
    prefix: string,
    suffix: string
  ): string {
    // 1. Strip markdown code fences
    text = text.replace(/^```[\w]*\s*\n?/g, '').replace(/\n?```\s*$/g, '');

    // 2. Remove "Here's the completion:" style preambles
    text = text.replace(
      /^(here'?s?\s+(the\s+)?(code\s+)?(completion|suggestion|result)[:.]?\s*\n?)/i,
      ''
    );

    // 3. If the completion repeats the entire prefix + cursor pattern, extract just the new part
    const cursorMarker = '<CURSOR>';
    const cursorIdx = text.indexOf(cursorMarker);
    if (cursorIdx >= 0) {
      text = text.substring(cursorIdx + cursorMarker.length);
    }

    // 4. Trim the suffix if the model generated it
    if (suffix && suffix.trim().length > 0 && text.includes(suffix.trim())) {
      const suffixStart = text.indexOf(suffix.trim());
      if (suffixStart > 0) {
        text = text.substring(0, suffixStart);
      }
    }

    // 5. Remove leading newlines but preserve indentation spaces
    text = text.replace(/^\n+/, '');

    // 6. Remove trailing blank lines (keep at most one trailing newline)
    text = text.replace(/\n{3,}$/, '\n\n');

    return text;
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
