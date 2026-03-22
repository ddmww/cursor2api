import { getConfig } from './config.js';

export const DEFAULT_UPSTREAM_BLOCK_MESSAGE = '上游渠道商拦截了当前请求，请尝试换个说法后重试，或稍后再试。';

export class UpstreamBlockedError extends Error {
    readonly status: number;
    readonly type: string;
    readonly code: string;
    readonly matchedKeyword: string;

    constructor(matchedKeyword: string, message?: string) {
        super(message || DEFAULT_UPSTREAM_BLOCK_MESSAGE);
        this.name = 'UpstreamBlockedError';
        this.status = 502;
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

export function assertUpstreamResponseAllowed(text: string): void {
    const matchedKeyword = findUpstreamBlockedKeyword(text);
    if (!matchedKeyword) return;
    const message = getConfig().upstreamBlocker.message?.trim() || DEFAULT_UPSTREAM_BLOCK_MESSAGE;
    throw new UpstreamBlockedError(matchedKeyword, message);
}
