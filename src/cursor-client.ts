/**
 * cursor-client.ts - Cursor API 客户端
 *
 * 职责：
 * 1. 发送请求到 https://cursor.com/api/chat（带 Chrome TLS 指纹模拟 headers）
 * 2. 流式解析 SSE 响应
 * 3. 使用代理池执行 429 / 网络错误切换（仅在响应开始前重试）
 *
 * 注：x-is-human token 验证已被 Cursor 停用，直接发送空字符串即可。
 */

import type { CursorChatRequest, CursorSSEEvent } from './types.js';
import { getConfig } from './config.js';
import {
    fetchWithProxyFailover,
    reportProxySelectionFailure,
    reportProxySelectionSuccess,
    shouldRetryProxyTransportError,
    type ProxyTraceHook,
} from './proxy-agent.js';

const CURSOR_CHAT_API = 'https://cursor.com/api/chat';

// Chrome 浏览器请求头模拟
function getChromeHeaders(): Record<string, string> {
    const config = getConfig();
    return {
        'Content-Type': 'application/json',
        'sec-ch-ua-platform': '"Windows"',
        'x-path': '/api/chat',
        'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
        'x-method': 'POST',
        'sec-ch-ua-bitness': '"64"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-arch': '"x86"',
        'sec-ch-ua-platform-version': '"19.0.0"',
        'origin': 'https://cursor.com',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'referer': 'https://cursor.com/',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'priority': 'u=1, i',
        'user-agent': config.fingerprint.userAgent,
        'x-is-human': '',
    };
}

// ==================== API 请求 ====================

/**
 * 发送请求到 Cursor /api/chat 并以流式方式处理响应
 */
export async function sendCursorRequest(
    req: CursorChatRequest,
    onChunk: (event: CursorSSEEvent) => void,
    externalSignal?: AbortSignal,
    hook?: ProxyTraceHook,
): Promise<void> {
    try {
        await sendCursorRequestInner(req, onChunk, externalSignal, hook);
    } catch (err) {
        if (externalSignal?.aborted) throw err;
        if (err instanceof Error && err.message === 'DEGENERATE_LOOP_ABORTED') return;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Cursor] 请求失败: ${msg.substring(0, 120)}`);
        throw err;
    }
}

async function sendCursorRequestInner(
    req: CursorChatRequest,
    onChunk: (event: CursorSSEEvent) => void,
    externalSignal?: AbortSignal,
    hook?: ProxyTraceHook,
): Promise<void> {
    const headers = getChromeHeaders();
    const config = getConfig();
    const controller = new AbortController();

    if (externalSignal) {
        if (externalSignal.aborted) {
            controller.abort();
        } else {
            externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
        }
    }

    const IDLE_TIMEOUT_MS = config.timeout * 1000;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            console.warn(`[Cursor] 空闲超时（${config.timeout}s 无新数据），中止请求`);
            controller.abort();
        }, IDLE_TIMEOUT_MS);
    };

    resetIdleTimer();

    try {
        const { response: resp, selection } = await fetchWithProxyFailover(CURSOR_CHAT_API, {
            method: 'POST',
            headers,
            body: JSON.stringify(req),
            signal: controller.signal,
        }, 'cursor', {
            signal: controller.signal,
            onProxyTrace: hook?.onProxyTrace,
        });

        if (!resp.ok) {
            const body = await resp.text();
            throw new Error(`Cursor API 错误: HTTP ${resp.status} - ${body}`);
        }

        if (!resp.body) {
            throw new Error('Cursor API 响应无 body');
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let lastDelta = '';
        let repeatCount = 0;
        const REPEAT_THRESHOLD = 8;
        let degenerateAborted = false;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                resetIdleTimer();

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6).trim();
                    if (!data) continue;

                    try {
                        const event: CursorSSEEvent = JSON.parse(data);

                        if (event.type === 'text-delta' && event.delta) {
                            const trimmedDelta = event.delta.trim();
                            if (trimmedDelta.length > 0 && trimmedDelta.length <= 20) {
                                if (trimmedDelta === lastDelta) {
                                    repeatCount++;
                                    if (repeatCount >= REPEAT_THRESHOLD) {
                                        console.warn(`[Cursor] ⚠️ 检测到退化循环: "${trimmedDelta}" 已连续重复 ${repeatCount} 次，中止流`);
                                        degenerateAborted = true;
                                        await reader.cancel();
                                        break;
                                    }
                                } else {
                                    lastDelta = trimmedDelta;
                                    repeatCount = 1;
                                }
                            } else {
                                lastDelta = '';
                                repeatCount = 0;
                            }
                        }

                        onChunk(event);
                    } catch {
                        // ignore non-JSON data
                    }
                }

                if (degenerateAborted) break;
            }
        } catch (error) {
            if (shouldRetryProxyTransportError(error, externalSignal)) {
                reportProxySelectionFailure(selection, error, false);
            }
            throw error;
        }

        if (degenerateAborted) {
            throw new Error('DEGENERATE_LOOP_ABORTED');
        }

        if (buffer.startsWith('data: ')) {
            const data = buffer.slice(6).trim();
            if (data) {
                try {
                    const event: CursorSSEEvent = JSON.parse(data);
                    onChunk(event);
                } catch {
                    // ignore
                }
            }
        }

        reportProxySelectionSuccess(selection);
    } finally {
        if (idleTimer) clearTimeout(idleTimer);
    }
}

/**
 * 发送非流式请求，收集完整响应
 */
export async function sendCursorRequestFull(
    req: CursorChatRequest,
    externalSignal?: AbortSignal,
    hook?: ProxyTraceHook,
): Promise<string> {
    let fullText = '';
    await sendCursorRequest(req, (event) => {
        if (event.type === 'text-delta' && event.delta) {
            fullText += event.delta;
        }
    }, externalSignal, hook);
    return fullText;
}
