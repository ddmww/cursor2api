export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogSource = 'Handler' | 'OpenAI' | 'Cursor' | 'Auth' | 'System' | 'Converter';
export type LogPhase =
  | 'receive' | 'auth' | 'convert' | 'intercept' | 'send'
  | 'response' | 'refusal' | 'retry' | 'truncation' | 'continuation'
  | 'thinking' | 'toolparse' | 'sanitize' | 'stream' | 'complete' | 'error';

export interface LogEntry {
  id: string;
  requestId: string;
  timestamp: number;
  level: LogLevel;
  source: LogSource;
  phase: LogPhase;
  message: string;
  details?: unknown;
  duration?: number;
}

export interface PhaseTiming {
  phase: LogPhase;
  label: string;
  startTime: number;
  endTime?: number;
  duration?: number;
}

export interface RequestSummary {
  requestId: string;
  startTime: number;
  endTime?: number;
  method: string;
  path: string;
  model: string;
  stream: boolean;
  apiFormat: 'anthropic' | 'openai' | 'responses';
  hasTools: boolean;
  toolCount: number;
  messageCount: number;
  status: 'processing' | 'success' | 'error' | 'intercepted';
  responseChars: number;
  retryCount: number;
  continuationCount: number;
  stopReason?: string;
  error?: string;
  toolCallsDetected: number;
  ttft?: number;
  cursorApiTime?: number;
  phaseTimings: PhaseTiming[];
  thinkingChars: number;
  systemPromptLength: number;
  title?: string;
}

export interface Stats {
  totalRequests: number;
  successCount: number;
  errorCount: number;
  avgResponseTime: number;
  avgTTFT: number;
}

/** 对应后端 RequestPayload */
export interface Payload {
  // 原始请求
  originalRequest?: unknown;
  systemPrompt?: string;
  messages?: Array<{ role: string; contentPreview: string; contentLength: number; hasImages?: boolean }>;
  tools?: Array<{ name: string; description?: string }>;
  // 转换后请求
  cursorRequest?: unknown;
  cursorMessages?: Array<{ role: string; contentPreview: string; contentLength: number }>;
  // 模型响应
  rawResponse?: string;
  finalResponse?: string;
  thinkingContent?: string;
  toolCalls?: unknown[];
  retryResponses?: Array<{ attempt: number; response: string; reason: string }>;
  continuationResponses?: Array<{ index: number; response: string; dedupedLength: number }>;
}
