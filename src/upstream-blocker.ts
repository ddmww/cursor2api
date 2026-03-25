import { getConfig } from './config.js';

export const DEFAULT_UPSTREAM_BLOCK_MESSAGE = '上游渠道商拦截了当前请求，请尝试换个说法后重试，或稍后再试。';
export const EMPTY_UPSTREAM_RESPONSE_MATCH = '__empty_upstream_response__';
export const UPSTREAM_BLOCKED_HTTP_STATUS = 500;

export class UpstreamBlockedError extends Error {
    readonly status: number;
    readonly type: string;
    readonly code: string;
    readonly matchedKeyword: string;

    constructor(matchedKeyword: string, message?: string) {
        super(message || DEFAULT_UPSTREAM_BLOCK_MESSAGE);
        this.name = 'UpstreamBlockedError';
        this.status = UPSTREAM_BLOCKED_HTTP_STATUS;
        this.type = 'upstream_blocked';
        this.code = 'upstream_blocked';
        this.matchedKeyword = matchedKeyword;
    }
}

function normalizeKeywords(keywords: string[]): string[] {
    return [...new Set(keywords.map(keyword => keyword.trim()).filter(Boolean))];
}

export function findUpstreamBlockedKeyword(text: string): string | undefined {
    const cfg = getConfig().upstreamBlocker;
    if (!cfg.enabled || !text) return undefined;

    const haystack = cfg.caseSensitive ? text : text.toLocaleLowerCase();
    for (const keyword of normalizeKeywords(cfg.keywords)) {
        const needle = cfg.caseSensitive ? keyword : keyword.toLocaleLowerCase();
        if (haystack.includes(needle)) {
            return keyword;
        }
    }
    return undefined;
}

export function shouldDelayUpstreamSuccessStatus(): boolean {
    const cfg = getConfig().upstreamBlocker;
    return cfg.enabled || cfg.blockEmptyResponse;
}

function shouldBlockEmptyUpstreamResponse(text: string | null | undefined): boolean {
    const cfg = getConfig().upstreamBlocker;
    return cfg.blockEmptyResponse === true && String(text ?? '').trim().length === 0;
}

export function assertUpstreamResponseAllowed(text: string | null | undefined): void {
    const message = getConfig().upstreamBlocker.message?.trim() || DEFAULT_UPSTREAM_BLOCK_MESSAGE;
    if (shouldBlockEmptyUpstreamResponse(text)) {
        throw new UpstreamBlockedError(EMPTY_UPSTREAM_RESPONSE_MATCH, message);
    }

    const normalizedText = String(text ?? '');
    const matchedKeyword = findUpstreamBlockedKeyword(normalizedText);
    if (!matchedKeyword) return;
    throw new UpstreamBlockedError(matchedKeyword, message);
}
