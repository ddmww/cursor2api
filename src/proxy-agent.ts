/**
 * proxy-agent.ts - 代理选择与故障切换
 *
 * 说明：
 * - 兼容旧的单 proxy 配置，作为代理池失效时的兜底
 * - 代理池仅支持 http / https 代理地址
 * - Vision 显式配置 vision.proxy 时，优先走专用代理，不参与代理池轮询
 */

import { ProxyAgent, type Dispatcher } from 'undici';
import { getConfig } from './config.js';
import type { ProxySource, ProxyTraceSnapshot } from './types.js';
import {
    selectProxyPoolUrl,
    markProxyPoolFailure,
    markProxyPoolSuccess,
    getProxyPoolStatus,
    validateHttpProxyUrl,
    formatProxyFailureReason,
} from './proxy-pool.js';

export type ProxyScope = 'cursor' | 'vision';

export interface ProxySelection {
    dispatcher?: Dispatcher;
    url?: string;
    source: ProxySource;
}

export interface ProxyTraceHook {
    onProxyTrace?: (trace: ProxyTraceSnapshot) => void;
}

const dispatcherCache = new Map<string, ProxyAgent>();

function getCachedProxyAgent(url: string): ProxyAgent {
    const cached = dispatcherCache.get(url);
    if (cached) return cached;

    const agent = new ProxyAgent(url);
    dispatcherCache.set(url, agent);
    return agent;
}

function toSelection(url: string | undefined, source: ProxySource): ProxySelection {
    if (!url) return { source: 'direct' };
    const validationError = validateHttpProxyUrl(url);
    if (validationError) {
        console.warn(`[Proxy] 跳过无效代理 ${url}: ${validationError}`);
        return { source: 'direct' };
    }
    return {
        url,
        source,
        dispatcher: getCachedProxyAgent(url),
    };
}

export function selectCursorProxy(options?: { excludeUrls?: string[] }): ProxySelection {
    const poolUrl = selectProxyPoolUrl(options?.excludeUrls);
    if (poolUrl) {
        return toSelection(poolUrl, 'pool');
    }

    const fallbackProxy = getConfig().proxy?.trim();
    if (fallbackProxy && !options?.excludeUrls?.includes(fallbackProxy)) {
        return toSelection(fallbackProxy, 'fallback');
    }

    return { source: 'direct' };
}

export function selectVisionProxy(options?: { excludeUrls?: string[] }): ProxySelection {
    const visionProxy = getConfig().vision?.proxy?.trim();
    if (visionProxy && !options?.excludeUrls?.includes(visionProxy)) {
        return toSelection(visionProxy, 'vision');
    }
    return selectCursorProxy(options);
}

export function getProxyFetchOptions(selection: ProxySelection): Record<string, unknown> {
    return selection.dispatcher ? { dispatcher: selection.dispatcher } : {};
}

function emitProxyTrace(trace: ProxyTraceSnapshot, hook?: ProxyTraceHook): void {
    hook?.onProxyTrace?.({ ...trace, proxyFailures: [...trace.proxyFailures] });
}

function isRetryableTransportError(error: unknown, externalSignal?: AbortSignal): boolean {
    if (externalSignal?.aborted) return false;

    if (!(error instanceof Error)) return false;

    const anyError = error as Error & { code?: string; cause?: { code?: string; message?: string } };
    const code = anyError.code || anyError.cause?.code || '';
    const message = `${anyError.message} ${anyError.cause?.message || ''}`;

    return (
        code === 'ECONNRESET' ||
        code === 'ETIMEDOUT' ||
        code === 'UND_ERR_CONNECT_TIMEOUT' ||
        code === 'UND_ERR_HEADERS_TIMEOUT' ||
        code === 'UND_ERR_SOCKET' ||
        code === 'UND_ERR_ABORTED' ||
        /\bECONNRESET\b|\bETIMEDOUT\b|\bENOTFOUND\b|\bEHOSTUNREACH\b|\bECONNREFUSED\b|\bUND_ERR_/i.test(code || message) ||
        /fetch failed|socket|timeout|timed out|connect|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ECONNREFUSED|AbortError/i.test(message)
    );
}

function markSelectionFailure(selection: ProxySelection, error: unknown, rateLimited = false): void {
    if (selection.source !== 'pool' || !selection.url) return;
    markProxyPoolFailure(selection.url, formatProxyFailureReason(error), {
        rateLimited,
        transport: !rateLimited,
    });
}

export function reportProxySelectionSuccess(selection: ProxySelection): void {
    if (selection.source === 'pool' && selection.url) {
        markProxyPoolSuccess(selection.url);
    }
}

export function reportProxySelectionFailure(selection: ProxySelection, error: unknown, rateLimited = false): void {
    markSelectionFailure(selection, error, rateLimited);
}

export function shouldRetryProxyTransportError(error: unknown, externalSignal?: AbortSignal): boolean {
    return isRetryableTransportError(error, externalSignal);
}

export async function fetchWithProxyFailover(
    url: string,
    init: Record<string, unknown>,
    scope: ProxyScope,
    options?: ProxyTraceHook & { signal?: AbortSignal },
): Promise<{ response: Response; selection: ProxySelection; trace: ProxyTraceSnapshot }> {
    const trace: ProxyTraceSnapshot = {
        selectedProxy: undefined,
        proxySource: 'direct',
        proxyAttemptCount: 0,
        proxyRotated: false,
        proxyFailures: [],
    };

    const excludedUrls = new Set<string>();
    let previousProxyUrl: string | undefined;

    for (let attempt = 1; attempt <= 2; attempt++) {
        const selection = scope === 'vision'
            ? selectVisionProxy({ excludeUrls: [...excludedUrls] })
            : selectCursorProxy({ excludeUrls: [...excludedUrls] });

        trace.proxyAttemptCount = attempt;
        trace.selectedProxy = selection.url;
        trace.proxySource = selection.source;
        trace.proxyRotated = Boolean(previousProxyUrl && previousProxyUrl !== selection.url);
        emitProxyTrace(trace, options);

        try {
            const response = await fetch(url, {
                ...init,
                ...getProxyFetchOptions(selection),
                signal: options?.signal || init.signal,
            } as any);

            if (response.status === 429 && selection.source === 'pool' && selection.url) {
                const failure = new Error(`HTTP 429 - Rate limit exceeded via ${selection.url}`);
                markSelectionFailure(selection, failure, true);
                trace.proxyFailures.push(formatProxyFailureReason(failure));
                emitProxyTrace(trace, options);

                if (attempt < 2) {
                    excludedUrls.add(selection.url);
                    previousProxyUrl = selection.url;
                    try {
                        await response.arrayBuffer();
                    } catch {
                        // ignore drain errors
                    }
                    continue;
                }
            }

            return { response, selection, trace };
        } catch (error) {
            const retryable = selection.source === 'pool' && selection.url && isRetryableTransportError(error, options?.signal);
            if (!retryable) throw error;

            markSelectionFailure(selection, error, false);
            trace.proxyFailures.push(formatProxyFailureReason(error));
            emitProxyTrace(trace, options);

            if (attempt >= 2) throw error;

            excludedUrls.add(selection.url!);
            previousProxyUrl = selection.url;
        }
    }

    throw new Error('Proxy failover exhausted');
}

export function getProxyPoolStatusSnapshot() {
    return getProxyPoolStatus();
}
