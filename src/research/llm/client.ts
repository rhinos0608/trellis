/**
 * LLM chat client — OpenAI-compatible HTTP client using plain fetch.
 *
 * Mirrors search-mcp's llm/chat.ts core behavior (retry, backoff, dual-model
 * routing) but drops class-heavy config and uses Trellis's config directly.
 * No new dependencies needed.
 */

import { logger } from '../../logger.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface LlmClientConfig {
  baseUrl: string;
  workerBaseUrl?: string;
  model: string;
  workerModel?: string;
  apiToken?: string;
}

export interface LlmCallOptions {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json_object';
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface LlmResponse {
  content: string;
  model: string;
  tokensUsed: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface TokenBudget {
  recordTokens(count: number): boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 300_000;
const ORCHESTRATOR_TEMP = 0.7;
const WORKER_TEMP = 0.3;
const MAX_RETRIES = 8;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function backoffDelay(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function normalizeBaseUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1\/chat\/completions$/, '')
    .replace(/\/v1$/, '');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function normalizeMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (isRecord(part) && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter((p) => p.length > 0)
      .join('\n');
  }
  if (isRecord(content) && typeof content.text === 'string') return content.text;
  return JSON.stringify(content);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let abortListener: (() => void) | null = null;
    const timer = setTimeout(() => {
      if (abortListener) signal?.removeEventListener('abort', abortListener);
      resolve();
    }, ms);
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      reject(new Error('LLM retry sleep aborted'));
      return;
    }
    abortListener = () => {
      clearTimeout(timer);
      reject(new Error('LLM retry sleep aborted'));
    };
    signal.addEventListener('abort', abortListener, { once: true });
  });
}

/** Parse JSON from LLM text — tries direct parse, then fence extraction. */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function parseJsonFromText<T>(text: string): T | undefined {
  try {
    return JSON.parse(text.trim()) as T;
  } catch {
    /* fall through to fence extraction */
  }
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  let m: RegExpExecArray | null;
  while ((m = fenceRegex.exec(text)) !== null) {
    if (m[1]) {
      try {
        return JSON.parse(m[1].trim()) as T;
      } catch {
        /* try next fence */
      }
    }
  }
  return undefined;
}

// ── Client ─────────────────────────────────────────────────────────────────

export class LlmClient {
  private readonly baseUrl: string;
  private readonly workerBaseUrl: string;
  private readonly model: string;
  private readonly workerModel: string;
  private readonly apiToken: string | undefined;
  private readonly budget: TokenBudget | undefined;

  constructor(config: LlmClientConfig, budget?: TokenBudget) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.workerBaseUrl = normalizeBaseUrl(
      config.workerBaseUrl && config.workerBaseUrl.trim().length > 0
        ? config.workerBaseUrl
        : config.baseUrl,
    );
    this.model = config.model;
    this.workerModel = config.workerModel ?? config.model;
    this.apiToken = config.apiToken;
    this.budget = budget;
  }

  async callOrchestrator(options: LlmCallOptions): Promise<LlmResponse> {
    return this.callModel(
      this.model,
      options,
      options.temperature ?? ORCHESTRATOR_TEMP,
    );
  }

  async callWorker(options: LlmCallOptions): Promise<LlmResponse> {
    return this.callModel(
      this.workerModel,
      options,
      options.temperature ?? WORKER_TEMP,
      this.workerBaseUrl,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  async callJSON<T>(
    options: LlmCallOptions & { model: 'orchestrator' | 'worker' },
  ): Promise<
    | { success: true; data: T; response: LlmResponse }
    | { success: false; response: LlmResponse; parseError?: string }
  > {
    const callFn =
      options.model === 'orchestrator'
        ? this.callOrchestrator.bind(this)
        : this.callWorker.bind(this);
    const { model: _, ...callOptions } = options;
    const response = await callFn(callOptions);
    if (!response.success) return { success: false, response };
    const data = parseJsonFromText<T>(response.content);
    if (data !== undefined) return { success: true, data, response };
    return {
      success: false,
      response,
      parseError: 'LLM returned non-JSON content',
    };
  }

  private async callModel(
    model: string,
    options: LlmCallOptions,
    temperature: number,
    baseUrl?: string,
  ): Promise<LlmResponse> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const deadline = startTime + timeoutMs;
    const endpoint = `${baseUrl ?? this.baseUrl}/v1/chat/completions`;
    const promptTokens = options.messages.reduce(
      (sum, msg) => sum + estimateTokens(msg.content),
      0,
    );

    const body: Record<string, unknown> = {
      model,
      messages: options.messages,
      max_tokens: options.maxTokens ?? 4096,
      temperature,
    };
    if (options.responseFormat !== undefined) {
      body.response_format = { type: options.responseFormat };
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          return {
            content: '',
            model,
            tokensUsed: 0,
            durationMs: Date.now() - startTime,
            success: false,
            error: `LLM request timed out after ${String(timeoutMs)}ms`,
          };
        }

        const controller = new AbortController();
        const timeout = setTimeout(
          () => { controller.abort(new Error('LLM request timed out')); },
          remainingMs,
        );

        const externalSignal = options.signal;
        let abortListener: (() => void) | undefined;
        if (externalSignal) {
          if (externalSignal.aborted) {
            controller.abort(externalSignal.reason);
          } else {
            abortListener = () => {
              controller.abort(externalSignal.reason);
            };
            externalSignal.addEventListener('abort', abortListener, {
              once: true,
            });
          }
        }

        let response: Response | undefined;
        try {
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...(this.apiToken
              ? { Authorization: `Bearer ${this.apiToken}` }
              : {}),
          };
          response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
          if (abortListener && externalSignal) {
            externalSignal.removeEventListener('abort', abortListener);
          }
        }

        if (!response.ok) {
          const status = response.status;
          const errorText = await response.text().catch(() => '');
          if (attempt < MAX_RETRIES && RETRYABLE.has(status)) {
            const delay = Math.min(
              backoffDelay(attempt),
              Math.max(0, deadline - Date.now()),
            );
            logger.warn({ status, attempt, delay }, 'LLM retryable error');
            try {
              await sleep(delay, options.signal);
            } catch (err) {
              return {
                content: '',
                model,
                tokensUsed: 0,
                durationMs: Date.now() - startTime,
                success: false,
                error: err instanceof Error ? err.message : String(err),
              };
            }
            continue;
          }
          return {
            content: '',
            model,
            tokensUsed: 0,
            durationMs: Date.now() - startTime,
            success: false,
            error: `HTTP ${String(status)}: ${errorText.slice(0, 500)}`,
          };
        }

        const data = (await response.json()) as {
          choices?: [{ message?: { content?: unknown } }];
        };
        const rawContent = normalizeMessageContent(
          data.choices?.[0]?.message?.content,
        );
        const totalTokens = promptTokens + estimateTokens(rawContent);
        this.budget?.recordTokens(totalTokens);

        return {
          content: rawContent,
          model,
          tokensUsed: totalTokens,
          durationMs: Date.now() - startTime,
          success: true,
        };
      } catch (err) {
        if (attempt >= MAX_RETRIES || options.signal?.aborted) {
          return {
            content: '',
            model,
            tokensUsed: 0,
            durationMs: Date.now() - startTime,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        const delay = Math.min(
          backoffDelay(attempt),
          Math.max(0, deadline - Date.now()),
        );
        logger.warn({ err, attempt, delay }, 'LLM call error, retrying');
        try {
          await sleep(delay, options.signal);
        } catch (sleepErr) {
          return {
            content: '',
            model,
            tokensUsed: 0,
            durationMs: Date.now() - startTime,
            success: false,
            error:
              sleepErr instanceof Error ? sleepErr.message : String(sleepErr),
          };
        }
      }
    }

    return {
      content: '',
      model,
      tokensUsed: 0,
      durationMs: Date.now() - startTime,
      success: false,
      error: 'Unexpected exit from retry loop',
    };
  }
}
