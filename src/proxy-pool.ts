import { ProxyAgent } from 'undici';
import { getConfig, onConfigReload } from './config.js';
import type { ProxyPoolStatus } from './types.js';

interface RuntimeProxyEntry {
    url: string;
    valid: boolean;
    healthy: boolean;
    cooldownUntil?: number;
    lastError?: string;
    lastUsedAt?: number;
    consecutive429: number;
    latencyMs?: number;
}

const HEALTHCHECK_TIMEOUT_MS = 5000;
export const DIRECT_PROXY_POOL_ENTRY = 'direct';

const runtimeEntries = new Map<string, RuntimeProxyEntry>();
const healthDispatchers = new Map<string, ProxyAgent>();

let runtimeUrls: string[] = [];
let roundRobinIndex = 0;
let healthTimer: ReturnType<typeof setInterval> | null = null;
let healthLoopRegistered = false;
let healthCheckInFlight = false;
let lastConfigSignature = '';

export function isDirectProxyPoolUrl(url: string): boolean {
    const normalized = url.trim().toLowerCase();
    return normalized === DIRECT_PROXY_POOL_ENTRY || normalized === 'direct://' || normalized === '直连';
}

function normalizeProxyPoolUrl(url: string): string {
    return isDirectProxyPoolUrl(url) ? DIRECT_PROXY_POOL_ENTRY : url.trim();
}

export function validateHttpProxyUrl(url: string, options?: { allowDirect?: boolean }): string | undefined {
    if (options?.allowDirect && isDirectProxyPoolUrl(url)) {
        return undefined;
    }

    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return '代理 URL 必须是有效的完整地址，例如 http://mihomo:10001。';
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return '代理池仅支持 http:// 或 https:// 代理。Mihomo 请暴露 mixed/http 入口，不支持 socks5://。';
    }

    if (!parsed.hostname) {
        return '代理 URL 必须包含主机名，例如 http://mihomo:10001。';
    }

    return undefined;
}

function normalizePoolUrls(urls: string[]): string[] {
    return [...new Set(urls.map(normalizeProxyPoolUrl).filter(Boolean))];
}

function isInCooldown(entry: RuntimeProxyEntry): boolean {
    return !!entry.cooldownUntil && entry.cooldownUntil > Date.now();
}

function toStatus(entry: RuntimeProxyEntry): ProxyPoolStatus {
    return {
        url: entry.url,
        healthy: entry.healthy,
        cooldownUntil: entry.cooldownUntil,
        inCooldown: isInCooldown(entry),
        lastError: entry.lastError,
        lastUsedAt: entry.lastUsedAt,
        consecutive429: entry.consecutive429,
        latencyMs: entry.latencyMs,
    };
}

function createRuntimeEntry(url: string, previous?: RuntimeProxyEntry): RuntimeProxyEntry {
    const validationError = validateHttpProxyUrl(url, { allowDirect: true });
    return {
        url,
        valid: !validationError,
        healthy: validationError ? false : previous?.healthy ?? true,
        cooldownUntil: previous?.cooldownUntil,
        lastError: validationError || previous?.lastError,
        lastUsedAt: previous?.lastUsedAt,
        consecutive429: previous?.consecutive429 ?? 0,
        latencyMs: previous?.latencyMs,
    };
}

function getRuntimeConfigSignature(): string {
    const cfg = getConfig().proxyPool;
    return JSON.stringify({
        enabled: cfg.enabled,
        urls: normalizePoolUrls(cfg.urls),
        cooldownSeconds: cfg.cooldownSeconds,
        healthCheck: cfg.healthCheck,
    });
}

function syncHealthLoop(): void {
    const cfg = getConfig().proxyPool;
    const shouldRun = cfg.enabled && cfg.healthCheck.enabled && runtimeUrls.length > 0;

    if (!shouldRun) {
        if (healthTimer) {
            clearInterval(healthTimer);
            healthTimer = null;
        }
        return;
    }

    const intervalMs = Math.max(10, cfg.healthCheck.intervalSeconds) * 1000;
    if (healthTimer) {
        clearInterval(healthTimer);
    }

    healthTimer = setInterval(() => {
        void runHealthChecks();
    }, intervalMs);
}

function syncRuntimeConfig(): void {
    if (!healthLoopRegistered) {
        healthLoopRegistered = true;
        onConfigReload(() => {
            syncRuntimeConfig();
        });
    }

    const signature = getRuntimeConfigSignature();
    if (signature === lastConfigSignature) return;
    lastConfigSignature = signature;

    const nextUrls = normalizePoolUrls(getConfig().proxyPool.urls);
    const nextEntries = new Map<string, RuntimeProxyEntry>();

    for (const url of nextUrls) {
        nextEntries.set(url, createRuntimeEntry(url, runtimeEntries.get(url)));
    }

    for (const staleUrl of runtimeEntries.keys()) {
        if (!nextEntries.has(staleUrl)) {
            const dispatcher = healthDispatchers.get(staleUrl);
            if (dispatcher) {
                void dispatcher.close().catch(() => undefined);
                healthDispatchers.delete(staleUrl);
            }
        }
    }

    runtimeEntries.clear();
    for (const [url, entry] of nextEntries.entries()) {
        runtimeEntries.set(url, entry);
    }

    runtimeUrls = nextUrls;
    if (roundRobinIndex >= runtimeUrls.length) {
        roundRobinIndex = 0;
    }

    syncHealthLoop();
    if (getConfig().proxyPool.enabled && getConfig().proxyPool.healthCheck.enabled && runtimeUrls.length > 0) {
        void runHealthChecks();
    }
}

function getHealthDispatcher(url: string): ProxyAgent {
    const cached = healthDispatchers.get(url);
    if (cached) return cached;

    const agent = new ProxyAgent(url);
    healthDispatchers.set(url, agent);
    return agent;
}

async function runHealthChecks(): Promise<void> {
    syncRuntimeConfig();

    if (healthCheckInFlight) return;
    const cfg = getConfig().proxyPool;
    if (!cfg.enabled || !cfg.healthCheck.enabled || runtimeUrls.length === 0) return;

    healthCheckInFlight = true;
    const targetUrl = cfg.healthCheck.url || 'http://cp.cloudflare.com/generate_204';

    try {
        await Promise.all(runtimeUrls.map(async url => {
            const entry = runtimeEntries.get(url);
            if (!entry || !entry.valid) return;

            const started = Date.now();
            try {
                const fetchInit: Record<string, unknown> = {
                    method: 'GET',
                    signal: AbortSignal.timeout(HEALTHCHECK_TIMEOUT_MS),
                    headers: {
                        'User-Agent': 'cursor2api-proxy-pool/1.0',
                    },
                };
                if (!isDirectProxyPoolUrl(url)) {
                    fetchInit.dispatcher = getHealthDispatcher(url);
                }

                const response = await fetch(targetUrl, fetchInit as any);

                entry.latencyMs = Date.now() - started;
                entry.healthy = response.ok || response.status === 204;
                if (entry.healthy) {
                    if (!isInCooldown(entry)) {
                        entry.lastError = undefined;
                    }
                } else {
                    entry.lastError = `Health check returned HTTP ${response.status}`;
                }

                try {
                    await response.arrayBuffer();
                } catch {
                    // ignore drain failure
                }
            } catch (error) {
                entry.healthy = false;
                entry.latencyMs = Date.now() - started;
                entry.lastError = formatProxyFailureReason(error);
            }
        }));
    } finally {
        healthCheckInFlight = false;
    }
}

function isEntryAvailable(entry: RuntimeProxyEntry): boolean {
    const cfg = getConfig().proxyPool;
    if (!entry.valid) return false;
    if (isInCooldown(entry)) return false;
    if (cfg.healthCheck.enabled && !entry.healthy) return false;
    return true;
}

export function selectProxyPoolUrl(excludeUrls: string[] = []): string | undefined {
    syncRuntimeConfig();

    const cfg = getConfig().proxyPool;
    if (!cfg.enabled || runtimeUrls.length === 0) return undefined;

    const exclude = new Set(excludeUrls);
    const total = runtimeUrls.length;
    const startIndex = total === 0 ? 0 : roundRobinIndex % total;

    for (let offset = 0; offset < total; offset++) {
        const index = (startIndex + offset) % total;
        const url = runtimeUrls[index];
        const entry = runtimeEntries.get(url);
        if (!entry || exclude.has(url) || !isEntryAvailable(entry)) continue;

        roundRobinIndex = (index + 1) % total;
        entry.lastUsedAt = Date.now();
        return url;
    }

    return undefined;
}

export function markProxyPoolSuccess(url: string): void {
    syncRuntimeConfig();
    const entry = runtimeEntries.get(url);
    if (!entry) return;
    entry.healthy = true;
    entry.lastError = undefined;
    entry.consecutive429 = 0;
}

export function markProxyPoolFailure(
    url: string,
    reason: string,
    opts?: { rateLimited?: boolean; transport?: boolean },
): void {
    syncRuntimeConfig();
    const entry = runtimeEntries.get(url);
    if (!entry) return;

    entry.lastError = reason;
    const cooldownSeconds = Math.max(0, getConfig().proxyPool.cooldownSeconds);
    entry.cooldownUntil = cooldownSeconds > 0
        ? Date.now() + cooldownSeconds * 1000
        : undefined;
    if (opts?.rateLimited) {
        entry.consecutive429 += 1;
    }
    if (opts?.transport) {
        entry.healthy = false;
    }
}

export function getProxyPoolStatus(): ProxyPoolStatus[] {
    syncRuntimeConfig();
    return runtimeUrls.map(url => toStatus(runtimeEntries.get(url)!));
}

export function formatProxyFailureReason(error: unknown): string {
    if (error instanceof Error) {
        const cause = error.cause as { code?: string; message?: string } | undefined;
        const code = (error as Error & { code?: string }).code || cause?.code;
        return code ? `${code}: ${error.message}` : error.message;
    }
    return String(error);
}

syncRuntimeConfig();
