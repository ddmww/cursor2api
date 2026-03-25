let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅  ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌  ${name}`);
        console.error(`      ${e.message}`);
        failed++;
    }
}

function assert(condition, msg) {
    if (!condition) throw new Error(msg || 'Assertion failed');
}

const DEFAULT_UPSTREAM_BLOCK_MESSAGE = '上游渠道商拦截了当前请求，请尝试换个说法后重试，或稍后再试。';
const EMPTY_UPSTREAM_RESPONSE_MATCH = '__empty_upstream_response__';
const UPSTREAM_BLOCKED_HTTP_STATUS = 500;

class UpstreamBlockedError extends Error {
    constructor(matchedKeyword, message) {
        super(message || DEFAULT_UPSTREAM_BLOCK_MESSAGE);
        this.name = 'UpstreamBlockedError';
        this.status = UPSTREAM_BLOCKED_HTTP_STATUS;
        this.type = 'upstream_blocked';
        this.code = 'upstream_blocked';
        this.matchedKeyword = matchedKeyword;
    }
}

let mockConfig = {
    upstreamBlocker: {
        enabled: false,
        blockEmptyResponse: false,
        keywords: [],
        message: DEFAULT_UPSTREAM_BLOCK_MESSAGE,
    },
};

function normalizeKeywords(keywords) {
    return [...new Set(keywords.map(keyword => String(keyword).trim()).filter(Boolean))];
}

function findUpstreamBlockedKeyword(text) {
    const cfg = mockConfig.upstreamBlocker;
    if (!cfg.enabled || !text) return undefined;
    const haystack = cfg.caseSensitive ? String(text) : String(text).toLocaleLowerCase();
    for (const keyword of normalizeKeywords(cfg.keywords)) {
        const needle = cfg.caseSensitive ? keyword : keyword.toLocaleLowerCase();
        if (haystack.includes(needle)) {
            return keyword;
        }
    }
    return undefined;
}

function assertUpstreamResponseAllowed(text) {
    if (mockConfig.upstreamBlocker.blockEmptyResponse && String(text ?? '').trim().length === 0) {
        throw new UpstreamBlockedError(
            EMPTY_UPSTREAM_RESPONSE_MATCH,
            mockConfig.upstreamBlocker.message?.trim() || DEFAULT_UPSTREAM_BLOCK_MESSAGE,
        );
    }

    const matchedKeyword = findUpstreamBlockedKeyword(text);
    if (!matchedKeyword) return;
    throw new UpstreamBlockedError(
        matchedKeyword,
        mockConfig.upstreamBlocker.message?.trim() || DEFAULT_UPSTREAM_BLOCK_MESSAGE,
    );
}

console.log('\n📦 [1] upstream_blocker 关键词匹配\n');

mockConfig = {
    upstreamBlocker: {
        enabled: true,
        blockEmptyResponse: false,
        caseSensitive: false,
        keywords: ['cursor', 'I cannot fulfill this request.'],
        message: '上游渠道商拦截了当前请求，请换个说法后重试。',
    },
};

test('大小写不敏感匹配关键词', () => {
    const matched = findUpstreamBlockedKeyword('I am a support assistant for Cursor.');
    assert(matched === 'cursor', `Expected "cursor", got ${matched}`);
});

test('支持长句关键词匹配', () => {
    const matched = findUpstreamBlockedKeyword('I cannot fulfill this request. Please rephrase.');
    assert(matched === 'I cannot fulfill this request.', `Unexpected match: ${matched}`);
});

test('命中时抛出 UpstreamBlockedError', () => {
    let blocked = false;
    try {
        assertUpstreamResponseAllowed('This looks like a Cursor support response.');
    } catch (error) {
        blocked = error instanceof UpstreamBlockedError;
        assert(error.message.includes('上游渠道商拦截'), 'Expected configured block message');
        assert(error.status === UPSTREAM_BLOCKED_HTTP_STATUS, `Expected status=${UPSTREAM_BLOCKED_HTTP_STATUS}`);
    }
    assert(blocked, 'Expected UpstreamBlockedError to be thrown');
});

console.log('\n📦 [2] 开关关闭时不拦截\n');

mockConfig = {
    upstreamBlocker: {
        enabled: false,
        blockEmptyResponse: false,
        caseSensitive: false,
        keywords: ['cursor'],
        message: DEFAULT_UPSTREAM_BLOCK_MESSAGE,
    },
};

test('关闭开关后不匹配', () => {
    const matched = findUpstreamBlockedKeyword('Cursor support assistant');
    assert(matched === undefined, `Expected no match, got ${matched}`);
});

test('关闭开关后不抛错', () => {
    assertUpstreamResponseAllowed('Cursor support assistant');
});

console.log('\n📦 [3] 大小写敏感开关\n');

mockConfig = {
    upstreamBlocker: {
        enabled: true,
        blockEmptyResponse: false,
        caseSensitive: true,
        keywords: ['Cursor'],
        message: DEFAULT_UPSTREAM_BLOCK_MESSAGE,
    },
};

test('开启大小写敏感后，大小写完全一致才命中', () => {
    const matched = findUpstreamBlockedKeyword('Cursor support assistant');
    assert(matched === 'Cursor', `Expected "Cursor", got ${matched}`);
});

test('开启大小写敏感后，大小写不同不命中', () => {
    const matched = findUpstreamBlockedKeyword('cursor support assistant');
    assert(matched === undefined, `Expected no match, got ${matched}`);
});

console.log('\n📦 [4] 空回复拦截开关\n');

mockConfig = {
    upstreamBlocker: {
        enabled: false,
        blockEmptyResponse: true,
        caseSensitive: false,
        keywords: [],
        message: '上游返回空回复，请稍后再试。',
    },
};

test('开启空回复拦截后，空白字符串抛出 UpstreamBlockedError', () => {
    let blocked = false;
    try {
        assertUpstreamResponseAllowed('   \n\t  ');
    } catch (error) {
        blocked = error instanceof UpstreamBlockedError;
        assert(error.matchedKeyword === EMPTY_UPSTREAM_RESPONSE_MATCH, `Unexpected matched keyword: ${error.matchedKeyword}`);
        assert(error.message === '上游返回空回复，请稍后再试。', `Unexpected message: ${error.message}`);
        assert(error.status === UPSTREAM_BLOCKED_HTTP_STATUS, `Expected status=${UPSTREAM_BLOCKED_HTTP_STATUS}`);
    }
    assert(blocked, 'Expected UpstreamBlockedError to be thrown');
});

mockConfig = {
    upstreamBlocker: {
        enabled: false,
        blockEmptyResponse: false,
        caseSensitive: false,
        keywords: [],
        message: DEFAULT_UPSTREAM_BLOCK_MESSAGE,
    },
};

test('关闭空回复拦截后，空白字符串不抛错', () => {
    assertUpstreamResponseAllowed('   ');
});

console.log(`\n✅ 通过 ${passed} 项`);
if (failed > 0) {
    console.error(`❌ 失败 ${failed} 项`);
    process.exit(1);
}
