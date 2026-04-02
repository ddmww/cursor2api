import { ProxyAgent } from 'undici';
import { getConfig, onConfigReload } from './config.js';
import { buildClientHintHeaders, extractBrowserProfile, getLegacyClientHintHeaders } from './browser-fingerprint.js';
import { isDirectProxyPoolUrl, selectProxyPoolUrl } from './proxy-pool.js';
import type { FlareSolverrRuntimeStatus, ProxySource } from './types.js';

interface CookieLike {
    name?: unknown;
    value?: unknown;
}

interface FlareSolverrSolution {
    cookies?: CookieLike[];
    userAgent?: unknown;
}

interface FlareSolverrApiResponse {
    status?: unknown;
    message?: unknown;
    solution?: FlareSolverrSolution;
}

interface RuntimeState {
    cookieHeader: string;
    userAgent: string;
    browser: string;
    status: FlareSolverrRuntimeStatus['status'];
    lastSuccessAt?: number;
    lastAttemptAt?: number;
    lastError?: string;
    sourceProxy?: string;
    sourceProxySource?: ProxySource;
    nextRefreshAt?: number;
    refreshing: boolean;
}

const runtimeState: RuntimeState = {
    cookieHeader: '',
    userAgent: '',
    browser: '',
    status: 'disabled',
    refreshing: false,
};

const CURSOR_CHAT_API = 'https://cursor.com/api/chat';
const CURSOR_REQUIRED_COOKIE_NAMES = ['cursor_anonymous_id', 'statsig_stable_id', '_ca_device_id'];

let refreshPromise: Promise<boolean> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;

interface EffectiveFlareSolverrValues {
    cookieHeader: string;
    userAgent: string;
    browser: string;
    valueSource: FlareSolverrRuntimeStatus['valueSource'];
}

function clearRefreshTimer(): void {
    if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
    }
    runtimeState.nextRefreshAt = undefined;
}

function selectRefreshProxy(): { proxyUrl?: string; sourceProxy?: string; source: ProxySource } {
    const poolUrl = selectProxyPoolUrl();
    if (poolUrl) {
        return {
            proxyUrl: isDirectProxyPoolUrl(poolUrl) ? undefined : poolUrl,
            sourceProxy: isDirectProxyPoolUrl(poolUrl) ? 'direct' : poolUrl,
            source: 'pool',
        };
    }

    const fallback = getConfig().proxy?.trim();
    if (fallback) {
        return {
            proxyUrl: fallback,
            sourceProxy: fallback,
            source: 'fallback',
        };
    }

    return {
        sourceProxy: 'direct',
        source: 'direct',
    };
}

export function buildCookieHeaderFromCookies(cookies: CookieLike[] | undefined): string {
    if (!Array.isArray(cookies)) return '';
    return cookies
        .map(cookie => {
            const name = typeof cookie?.name === 'string' ? cookie.name.trim() : '';
            const value = typeof cookie?.value === 'string' ? cookie.value : '';
            return name ? `${name}=${value}` : '';
        })
        .filter(Boolean)
        .join('; ');
}

export function parseFlareSolverrSolution(solution: FlareSolverrSolution | undefined): {
    cookieHeader: string;
    userAgent: string;
    browser: string;
} {
    const cookieHeader = buildCookieHeaderFromCookies(solution?.cookies);
    const userAgent = typeof solution?.userAgent === 'string' ? solution.userAgent.trim() : '';
    const browser = extractBrowserProfile(userAgent);
    return { cookieHeader, userAgent, browser };
}

function getConfiguredCookieHeader(): string {
    return getConfig().flaresolverr.cookieHeader.trim();
}

function getConfiguredUserAgent(): string {
    return getConfig().flaresolverr.userAgent.trim();
}

function getConfiguredBrowser(userAgent = getConfiguredUserAgent()): string {
    const explicit = getConfig().flaresolverr.browser.trim();
    if (explicit) return explicit;
    return userAgent ? extractBrowserProfile(userAgent) : '';
}

function resolveEffectiveValues(): EffectiveFlareSolverrValues {
    if (runtimeState.cookieHeader || runtimeState.userAgent || runtimeState.browser) {
        const userAgent = runtimeState.userAgent;
        return {
            cookieHeader: runtimeState.cookieHeader,
            userAgent,
            browser: runtimeState.browser || (userAgent ? extractBrowserProfile(userAgent) : ''),
            valueSource: 'runtime',
        };
    }

    const cookieHeader = getConfiguredCookieHeader();
    const userAgent = getConfiguredUserAgent();
    const browser = getConfiguredBrowser(userAgent);
    if (cookieHeader || userAgent || browser) {
        return {
            cookieHeader,
            userAgent,
            browser,
            valueSource: 'config',
        };
    }

    return {
        cookieHeader: '',
        userAgent: '',
        browser: '',
        valueSource: 'none',
    };
}

function getSharedProxyPoolWarning(): string | undefined {
    if (!getConfig().proxyPool.enabled || resolveEffectiveValues().valueSource === 'none') return undefined;
    return '当前为代理池共享一份 cookie/UA；如果实际出口节点切换，浏览器校验可能失效。';
}

function getCursorReferer(): string {
    const configured = getConfig().flaresolverr.solveUrl?.trim();
    if (configured && /^https:\/\/cursor\.com\//i.test(configured)) {
        return configured;
    }
    return 'https://cursor.com/cn/docs';
}

function getMissingCursorCookieNames(cookieHeader: string): string[] {
    const cookieNames = new Set(
        cookieHeader
            .split(';')
            .map(part => part.split('=')[0]?.trim())
            .filter(Boolean),
    );
    return CURSOR_REQUIRED_COOKIE_NAMES.filter(name => !cookieNames.has(name));
}

function buildProbeHeaders(userAgent: string, browser: string, cookieHeader: string): Record<string, string> {
    const clientHints = userAgent
        ? buildClientHintHeaders(userAgent, browser)
        : getLegacyClientHintHeaders();

    return {
        'Content-Type': 'application/json',
        'accept': '*/*',
        'cache-control': 'no-cache',
        'origin': 'https://cursor.com',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'referer': getCursorReferer(),
        'accept-language': 'zh-CN,zh;q=0.9',
        'priority': 'u=1, i',
        'user-agent': userAgent,
        'cookie': cookieHeader,
        ...clientHints,
    };
}

async function probeCursorChat(cookieHeader: string, userAgent: string, browser: string, proxyUrl?: string): Promise<void> {
    if (!cookieHeader) {
        throw new Error('未提供 cookie，无法执行 /api/chat 连通性探测。');
    }

    const body = {
        context: [{ type: 'file', content: '', filePath: '/docs/' }],
        model: 'google/gemini-3-flash',
        id: `flaresolverr_probe_${Date.now()}`,
        messages: [
            {
                id: `msg_probe_${Date.now()}`,
                role: 'user',
                parts: [{ type: 'text', text: '你好' }],
            },
        ],
        trigger: 'submit-message',
    };

    const probeInit: RequestInit & { dispatcher?: ProxyAgent } = {
        method: 'POST',
        headers: buildProbeHeaders(userAgent, browser, cookieHeader),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45000),
    };

    let dispatcher: ProxyAgent | undefined;
    if (proxyUrl && !isDirectProxyPoolUrl(proxyUrl)) {
        dispatcher = new ProxyAgent(proxyUrl);
        probeInit.dispatcher = dispatcher;
    }

    try {
        const response = await fetch(CURSOR_CHAT_API, probeInit as any);
        const contentType = response.headers.get('content-type') || '';
        const text = await response.text();

        if (isVercelSecurityCheckpointResponse(response.status, contentType, text)) {
            throw new Error(`浏览器校验仍被拦截（HTTP ${response.status}）`);
        }
        if (!response.ok) {
            throw new Error(`上游探测返回 HTTP ${response.status}`);
        }
        if (!/text\/event-stream/i.test(contentType)) {
            throw new Error(`上游探测返回了非 SSE 响应：${contentType || 'unknown'}`);
        }
        if (!/data:\s*\{"type":"start"\}|data:\s*\{"type":"start-step"\}/.test(text)) {
            throw new Error('上游探测未返回预期的 Cursor SSE 起始事件。');
        }
    } finally {
        if (dispatcher) {
            try {
                await dispatcher.close();
            } catch {
                // ignore close failures
            }
        }
    }
}

function setDisabledState(): void {
    clearRefreshTimer();
    runtimeState.cookieHeader = '';
    runtimeState.userAgent = '';
    runtimeState.browser = '';
    runtimeState.status = 'disabled';
    runtimeState.refreshing = false;
    runtimeState.lastError = undefined;
    runtimeState.sourceProxy = undefined;
    runtimeState.sourceProxySource = undefined;
}

function scheduleNextRefresh(): void {
    clearRefreshTimer();

    const cfg = getConfig().flaresolverr;
    if (!cfg.enabled || !cfg.url.trim()) return;

    const delayMs = Math.max(1, cfg.refreshIntervalSeconds) * 1000;
    runtimeState.nextRefreshAt = Date.now() + delayMs;
    refreshTimer = setTimeout(() => {
        void refreshFlareSolverrNow('scheduled');
    }, delayMs);
}

export function getActiveFlareSolverrCookieHeader(): string | undefined {
    return resolveEffectiveValues().cookieHeader || undefined;
}

export function getActiveFlareSolverrUserAgent(): string | undefined {
    return resolveEffectiveValues().userAgent || undefined;
}

export function getActiveFlareSolverrBrowser(): string | undefined {
    return resolveEffectiveValues().browser || undefined;
}

export function isVercelSecurityCheckpointResponse(
    status: number,
    contentType: string | null | undefined,
    body: string,
): boolean {
    if (status !== 429) return false;
    if (!/text\/html/i.test(contentType || '')) return false;
    return /Vercel Security Checkpoint|We're verifying your browser/i.test(body);
}

function toErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

async function runRefresh(reason: string): Promise<boolean> {
    const cfg = getConfig().flaresolverr;

    runtimeState.lastAttemptAt = Date.now();
    runtimeState.refreshing = true;
    runtimeState.status = 'refreshing';
    runtimeState.lastError = undefined;

    if (!cfg.enabled) {
        setDisabledState();
        return false;
    }

    const baseUrl = cfg.url.trim().replace(/\/+$/, '');
    if (!baseUrl) {
        runtimeState.status = runtimeState.cookieHeader ? 'stale' : 'error';
        runtimeState.lastError = 'FlareSolverr 已启用，但未配置服务地址。';
        return false;
    }

    const proxySelection = selectRefreshProxy();
    runtimeState.sourceProxy = proxySelection.sourceProxy;
    runtimeState.sourceProxySource = proxySelection.source;

    try {
        const response = await fetch(`${baseUrl}/v1`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                cmd: 'request.get',
                url: cfg.solveUrl,
                maxTimeout: cfg.timeoutSeconds * 1000,
                ...(proxySelection.proxyUrl ? { proxy: { url: proxySelection.proxyUrl } } : {}),
            }),
            signal: AbortSignal.timeout((cfg.timeoutSeconds + 15) * 1000),
        });

        if (!response.ok) {
            const text = (await response.text()).slice(0, 300);
            throw new Error(`FlareSolverr HTTP ${response.status}: ${text}`);
        }

        const payload = await response.json() as FlareSolverrApiResponse;
        if (payload.status !== 'ok') {
            throw new Error(`FlareSolverr 返回错误: ${String(payload.status || 'unknown')} - ${String(payload.message || 'unknown error')}`);
        }

        const parsed = parseFlareSolverrSolution(payload.solution);
        if (!parsed.cookieHeader) {
            throw new Error('FlareSolverr 返回成功，但未提供可用 cookies。');
        }

        runtimeState.cookieHeader = parsed.cookieHeader;
        runtimeState.userAgent = parsed.userAgent || runtimeState.userAgent || getConfig().fingerprint.userAgent;
        runtimeState.browser = parsed.browser || extractBrowserProfile(runtimeState.userAgent);
        const missingCookieNames = getMissingCursorCookieNames(runtimeState.cookieHeader);
        if (missingCookieNames.length > 0) {
            runtimeState.lastError = `未检测到常见站点会话 cookie：${missingCookieNames.join(', ')}`;
        }

        await probeCursorChat(
            runtimeState.cookieHeader,
            runtimeState.userAgent,
            runtimeState.browser,
            proxySelection.proxyUrl,
        );

        runtimeState.status = 'ready';
        runtimeState.lastSuccessAt = Date.now();
        runtimeState.lastError = undefined;
        return true;
    } catch (error) {
        runtimeState.status = runtimeState.cookieHeader ? 'stale' : 'error';
        runtimeState.lastError = `[${reason}] ${toErrorMessage(error)}`;
        return false;
    } finally {
        runtimeState.refreshing = false;
        scheduleNextRefresh();
    }
}

export function getFlareSolverrStatusSnapshot(): FlareSolverrRuntimeStatus {
    const cfg = getConfig().flaresolverr;
    const effective = resolveEffectiveValues();
    const autoRefreshEnabled = cfg.enabled;
    let status: FlareSolverrRuntimeStatus['status'];

    if (runtimeState.refreshing) {
        status = 'refreshing';
    } else if (autoRefreshEnabled) {
        if (runtimeState.status !== 'disabled') {
            status = runtimeState.status;
        } else if (effective.valueSource !== 'none') {
            status = 'ready';
        } else {
            status = 'idle';
        }
    } else if (effective.valueSource !== 'none') {
        status = 'ready';
    } else {
        status = 'disabled';
    }

    return {
        enabled: autoRefreshEnabled,
        configured: Boolean(
            cfg.url.trim() ||
            cfg.cookieHeader.trim() ||
            cfg.userAgent.trim() ||
            cfg.browser.trim(),
        ),
        refreshing: runtimeState.refreshing,
        status,
        hasCookies: effective.cookieHeader.length > 0,
        cookieLength: effective.cookieHeader.length,
        cookieHeader: effective.cookieHeader,
        userAgent: effective.userAgent,
        browser: effective.browser,
        valueSource: effective.valueSource,
        lastSuccessAt: runtimeState.lastSuccessAt,
        lastAttemptAt: runtimeState.lastAttemptAt,
        lastError: runtimeState.lastError,
        sourceProxy: runtimeState.sourceProxy,
        sourceProxySource: runtimeState.sourceProxySource,
        nextRefreshAt: runtimeState.nextRefreshAt,
        solveUrl: cfg.solveUrl,
        refreshIntervalSeconds: cfg.refreshIntervalSeconds,
        sharedProxyPoolWarning: getSharedProxyPoolWarning(),
    };
}

export async function refreshFlareSolverrNow(reason = 'manual'): Promise<boolean> {
    if (refreshPromise) return refreshPromise;

    clearRefreshTimer();
    const promise = runRefresh(reason).finally(() => {
        if (refreshPromise === promise) {
            refreshPromise = null;
        }
    });
    refreshPromise = promise;
    return promise;
}

export function noteVercelSecurityCheckpoint(status: number, sourceProxy?: string): void {
    runtimeState.lastError = `上游触发 Vercel Security Checkpoint（HTTP ${status}）`;
    runtimeState.status = resolveEffectiveValues().cookieHeader ? 'stale' : 'error';
    if (sourceProxy) runtimeState.sourceProxy = sourceProxy;

    if (!getConfig().flaresolverr.enabled) return;
    void refreshFlareSolverrNow('upstream-checkpoint');
}

export function initFlareSolverrRefreshLoop(): void {
    if (initialized) return;
    initialized = true;

    onConfigReload((_cfg, changes) => {
        if (!changes.some(change =>
            change.startsWith('flaresolverr:') ||
            change.startsWith('proxy:') ||
            change.startsWith('proxy_pool:'),
        )) {
            return;
        }
        const cfg = getConfig().flaresolverr;
        if (!cfg.enabled) {
            setDisabledState();
            return;
        }
        void refreshFlareSolverrNow('config-reload');
    });

    if (getConfig().flaresolverr.enabled) {
        void refreshFlareSolverrNow('startup');
    } else {
        setDisabledState();
    }
}

export function stopFlareSolverrRefreshLoop(): void {
    clearRefreshTimer();
}
