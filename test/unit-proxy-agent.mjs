/**
 * test/unit-proxy-agent.mjs
 *
 * 代理池核心逻辑单元测试（纯内联，不依赖 dist）
 * 覆盖：
 *  1. HTTP 代理 URL 校验
 *  2. 轮询顺序
 *  3. 冷却 / unhealthy 跳过
 *  4. 池失效后回退到 legacy proxy
 *  5. Vision 独立代理优先级
 *  6. 429 / 网络错误触发一次切换重试
 */

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        const result = fn();
        if (result && typeof result.then === 'function') {
            return result.then(() => {
                console.log(`  ✅  ${name}`);
                passed++;
            }).catch((e) => {
                console.error(`  ❌  ${name}`);
                console.error(`      ${e.message}`);
                failed++;
            });
        }
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

function assertEqual(a, b, msg) {
    const as = JSON.stringify(a), bs = JSON.stringify(b);
    if (as !== bs) throw new Error(msg || `Expected ${bs}, got ${as}`);
}

let mockConfig = {};
let runtimeEntries = new Map();
let runtimeUrls = [];
let roundRobinIndex = 0;
const failureMarks = [];
const dispatcherCache = new Map();

function resetState() {
    mockConfig = {
        proxy: '',
        vision: { proxy: '' },
        proxyPool: {
            enabled: false,
            urls: [],
            cooldownSeconds: 30,
            freshConnectionPerRequest: false,
            healthCheck: { enabled: false, intervalSeconds: 60, url: 'http://cp.cloudflare.com/generate_204' },
        },
    };
    runtimeEntries = new Map();
    runtimeUrls = [];
    roundRobinIndex = 0;
    failureMarks.length = 0;
    dispatcherCache.clear();
}

function isDirectProxyPoolUrl(url) {
    const normalized = String(url || '').trim().toLowerCase();
    return normalized === 'direct' || normalized === 'direct://' || normalized === '直连';
}

function normalizePoolUrl(url) {
    return isDirectProxyPoolUrl(url) ? 'direct' : url.trim();
}

function validateHttpProxyUrl(url, options = {}) {
    if (options.allowDirect && isDirectProxyPoolUrl(url)) return undefined;
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return 'invalid';
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) return 'unsupported';
    if (!parsed.hostname) return 'missing-host';
    return undefined;
}

function syncPool() {
    runtimeUrls = [...new Set((mockConfig.proxyPool.urls || []).map(normalizePoolUrl).filter(Boolean))];
    const next = new Map();
    for (const url of runtimeUrls) {
        const prev = runtimeEntries.get(url);
        const err = validateHttpProxyUrl(url, { allowDirect: true });
        next.set(url, {
            url,
            valid: !err,
            healthy: err ? false : prev?.healthy ?? true,
            cooldownUntil: prev?.cooldownUntil,
            lastError: err || prev?.lastError,
            lastUsedAt: prev?.lastUsedAt,
            consecutive429: prev?.consecutive429 ?? 0,
        });
    }
    runtimeEntries = next;
}

function isInCooldown(entry) {
    return !!entry.cooldownUntil && entry.cooldownUntil > Date.now();
}

function isAvailable(entry) {
    if (!entry.valid) return false;
    if (isInCooldown(entry)) return false;
    if (mockConfig.proxyPool.healthCheck.enabled && !entry.healthy) return false;
    return true;
}

function selectProxyPoolUrl(exclude = []) {
    syncPool();
    if (!mockConfig.proxyPool.enabled || runtimeUrls.length === 0) return undefined;
    const excluded = new Set(exclude);
    const total = runtimeUrls.length;
    const start = roundRobinIndex % total;
    for (let offset = 0; offset < total; offset++) {
        const index = (start + offset) % total;
        const entry = runtimeEntries.get(runtimeUrls[index]);
        if (!entry || excluded.has(entry.url) || !isAvailable(entry)) continue;
        roundRobinIndex = (index + 1) % total;
        entry.lastUsedAt = Date.now();
        return entry.url;
    }
    return undefined;
}

function selectCursorProxy(exclude = []) {
    const poolUrl = selectProxyPoolUrl(exclude);
    if (poolUrl) return toSelection(poolUrl, 'pool');
    if (mockConfig.proxy && !exclude.includes(mockConfig.proxy)) return toSelection(mockConfig.proxy, 'fallback');
    return { source: 'direct' };
}

function selectVisionProxy(exclude = []) {
    if (mockConfig.vision?.proxy && !exclude.includes(mockConfig.vision.proxy)) {
        return toSelection(mockConfig.vision.proxy, 'vision');
    }
    return selectCursorProxy(exclude);
}

function toSelection(url, source) {
    if (!url) return { source: 'direct' };
    if (isDirectProxyPoolUrl(url)) return { source, url: 'direct' };
    if (mockConfig.proxyPool.freshConnectionPerRequest) {
        const agent = { id: randomId(), closed: false };
        return {
            source,
            url,
            dispatcher: agent,
            release: async () => { agent.closed = true; },
        };
    }
    if (!dispatcherCache.has(url)) {
        dispatcherCache.set(url, { id: randomId(), closed: false });
    }
    return { source, url, dispatcher: dispatcherCache.get(url) };
}

function randomId() {
    return Math.random().toString(36).slice(2, 10);
}

function markPoolFailure(url, reason, opts = {}) {
    const entry = runtimeEntries.get(url);
    if (!entry) return;
    entry.lastError = reason;
    entry.cooldownUntil = mockConfig.proxyPool.cooldownSeconds > 0
        ? Date.now() + mockConfig.proxyPool.cooldownSeconds * 1000
        : undefined;
    if (opts.rateLimited) entry.consecutive429 += 1;
    if (opts.transport) entry.healthy = false;
    failureMarks.push({ url, reason, ...opts });
}

function isRetryableTransportError(error) {
    return /ECONNRESET|ETIMEDOUT|UND_ERR_|fetch failed|timeout/i.test(error.message);
}

async function fetchWithProxyFailover(scope, fetchImpl) {
    const trace = { selectedProxy: undefined, proxySource: 'direct', proxyAttemptCount: 0, proxyRotated: false, proxyFailures: [] };
    const excluded = new Set();
    let previousUrl;

    for (let attempt = 1; attempt <= 2; attempt++) {
        const selection = scope === 'vision' ? selectVisionProxy([...excluded]) : selectCursorProxy([...excluded]);
        trace.proxyAttemptCount = attempt;
        trace.selectedProxy = selection.url;
        trace.proxySource = selection.source;
        trace.proxyRotated = !!(previousUrl && previousUrl !== selection.url);

        try {
            const response = await fetchImpl(selection);
            if (response.status === 429 && selection.source === 'pool' && selection.url) {
                markPoolFailure(selection.url, 'HTTP 429', { rateLimited: true });
                trace.proxyFailures.push('HTTP 429');
                if (attempt < 2) {
                    excluded.add(selection.url);
                    previousUrl = selection.url;
                    await selection.release?.();
                    continue;
                }
            }
            return { response, selection, trace };
        } catch (error) {
            await selection.release?.();
            if (!(selection.source === 'pool' && selection.url && isRetryableTransportError(error))) throw error;
            markPoolFailure(selection.url, error.message, { transport: true });
            trace.proxyFailures.push(error.message);
            if (attempt >= 2) throw error;
            excluded.add(selection.url);
            previousUrl = selection.url;
        }
    }

    throw new Error('unexpected');
}

console.log('\n📦 [1] URL 校验\n');

await test('支持 http 代理地址', () => {
    assertEqual(validateHttpProxyUrl('http://mihomo:10001'), undefined);
});

await test('支持 https 代理地址', () => {
    assertEqual(validateHttpProxyUrl('https://proxy.example.com:443'), undefined);
});

await test('代理池支持 direct 直连节点', () => {
    assertEqual(validateHttpProxyUrl('direct', { allowDirect: true }), undefined);
});

await test('拒绝 socks5 代理地址', () => {
    assertEqual(validateHttpProxyUrl('socks5://mihomo:10001'), 'unsupported');
});

console.log('\n📦 [2] 轮询与回退\n');

await test('代理池按 round robin 轮询', () => {
    resetState();
    mockConfig.proxyPool.enabled = true;
    mockConfig.proxyPool.urls = ['http://mihomo:10001', 'http://mihomo:10002'];
    assertEqual(selectCursorProxy().url, 'http://mihomo:10001');
    assertEqual(selectCursorProxy().url, 'http://mihomo:10002');
    assertEqual(selectCursorProxy().url, 'http://mihomo:10001');
});

await test('代理池可以在 direct 和代理之间轮询', () => {
    resetState();
    mockConfig.proxyPool.enabled = true;
    mockConfig.proxyPool.urls = ['direct', 'http://mihomo:10001'];
    const first = selectCursorProxy();
    const second = selectCursorProxy();
    assertEqual(first.url, 'direct');
    assertEqual(first.dispatcher, undefined);
    assertEqual(second.url, 'http://mihomo:10001');
});

await test('冷却中的代理会被跳过', () => {
    resetState();
    mockConfig.proxyPool.enabled = true;
    mockConfig.proxyPool.urls = ['http://mihomo:10001', 'http://mihomo:10002'];
    syncPool();
    runtimeEntries.get('http://mihomo:10001').cooldownUntil = Date.now() + 60_000;
    assertEqual(selectCursorProxy().url, 'http://mihomo:10002');
});

await test('冷却秒数为 0 时失败节点不会进入冷却窗口', async () => {
    resetState();
    mockConfig.proxyPool.enabled = true;
    mockConfig.proxyPool.cooldownSeconds = 0;
    mockConfig.proxyPool.urls = ['http://mihomo:10001', 'http://mihomo:10002'];
    await fetchWithProxyFailover('cursor', async (selection) => {
        if (selection.url === 'http://mihomo:10001') return { status: 429 };
        return { status: 200 };
    });
    const entry = runtimeEntries.get('http://mihomo:10001');
    assertEqual(entry.cooldownUntil, undefined);
    assertEqual(selectCursorProxy().url, 'http://mihomo:10001');
});

await test('健康检查开启时会跳过 unhealthy 节点', () => {
    resetState();
    mockConfig.proxyPool.enabled = true;
    mockConfig.proxyPool.healthCheck.enabled = true;
    mockConfig.proxyPool.urls = ['http://mihomo:10001', 'http://mihomo:10002'];
    syncPool();
    runtimeEntries.get('http://mihomo:10001').healthy = false;
    assertEqual(selectCursorProxy().url, 'http://mihomo:10002');
});

await test('池不可用时回退到 legacy proxy', () => {
    resetState();
    mockConfig.proxy = 'http://fallback:7890';
    mockConfig.proxyPool.enabled = true;
    mockConfig.proxyPool.healthCheck.enabled = true;
    mockConfig.proxyPool.urls = ['http://mihomo:10001'];
    syncPool();
    runtimeEntries.get('http://mihomo:10001').healthy = false;
    const selection = selectCursorProxy();
    assertEqual(selection.source, 'fallback');
    assertEqual(selection.url, 'http://fallback:7890');
});

await test('Vision 独立代理优先于共享池', () => {
    resetState();
    mockConfig.vision.proxy = 'http://vision-only:9000';
    mockConfig.proxyPool.enabled = true;
    mockConfig.proxyPool.urls = ['http://mihomo:10001', 'http://mihomo:10002'];
    const selection = selectVisionProxy();
    assertEqual(selection.source, 'vision');
    assertEqual(selection.url, 'http://vision-only:9000');
});

await test('启用每请求新建连接后，同一代理不会复用 dispatcher', async () => {
    resetState();
    mockConfig.proxyPool.enabled = true;
    mockConfig.proxyPool.freshConnectionPerRequest = true;
    mockConfig.proxyPool.urls = ['http://mihomo:10001'];
    const first = selectCursorProxy();
    const second = selectCursorProxy();
    assert(first.dispatcher && second.dispatcher, '应存在 dispatcher');
    assert(first.dispatcher !== second.dispatcher, '每次应创建新的 dispatcher');
    await first.release?.();
    assert(first.dispatcher.closed === true, '释放后应关闭临时 dispatcher');
});

console.log('\n📦 [3] 429 / 网络错误切换\n');

await test('HTTP 429 会立即切换到下一个池节点重试一次', async () => {
    resetState();
    mockConfig.proxyPool.enabled = true;
    mockConfig.proxyPool.urls = ['http://mihomo:10001', 'http://mihomo:10002'];
    const calls = [];
    const result = await fetchWithProxyFailover('cursor', async (selection) => {
        calls.push(selection.url);
        if (selection.url === 'http://mihomo:10001') return { status: 429 };
        return { status: 200 };
    });
    assertEqual(calls, ['http://mihomo:10001', 'http://mihomo:10002']);
    assertEqual(result.selection.url, 'http://mihomo:10002');
    assert(result.trace.proxyRotated, '应标记发生了代理切换');
    assertEqual(failureMarks[0].url, 'http://mihomo:10001');
    assert(failureMarks[0].rateLimited, '第一个代理应记录为 rate limited');
});

await test('direct 节点命中 429 后会切换到下一个代理节点', async () => {
    resetState();
    mockConfig.proxyPool.enabled = true;
    mockConfig.proxyPool.urls = ['direct', 'http://mihomo:10001'];
    const calls = [];
    const result = await fetchWithProxyFailover('cursor', async (selection) => {
        calls.push(selection.url);
        if (selection.url === 'direct') return { status: 429 };
        return { status: 200 };
    });
    assertEqual(calls, ['direct', 'http://mihomo:10001']);
    assertEqual(result.selection.url, 'http://mihomo:10001');
    assertEqual(failureMarks[0].url, 'direct');
});

await test('网络错误会切到下一个池节点', async () => {
    resetState();
    mockConfig.proxyPool.enabled = true;
    mockConfig.proxyPool.urls = ['http://mihomo:10001', 'http://mihomo:10002'];
    const calls = [];
    const result = await fetchWithProxyFailover('cursor', async (selection) => {
        calls.push(selection.url);
        if (selection.url === 'http://mihomo:10001') {
            throw new Error('ECONNRESET: socket hang up');
        }
        return { status: 200 };
    });
    assertEqual(calls, ['http://mihomo:10001', 'http://mihomo:10002']);
    assertEqual(result.selection.url, 'http://mihomo:10002');
    assert(failureMarks[0].transport, '第一个代理应记录为 transport failure');
});

await test('只会重试一次，第二个代理继续 429 时直接返回', async () => {
    resetState();
    mockConfig.proxyPool.enabled = true;
    mockConfig.proxyPool.urls = ['http://mihomo:10001', 'http://mihomo:10002'];
    const calls = [];
    const result = await fetchWithProxyFailover('cursor', async (selection) => {
        calls.push(selection.url);
        return { status: 429 };
    });
    assertEqual(calls, ['http://mihomo:10001', 'http://mihomo:10002']);
    assertEqual(result.response.status, 429);
    assertEqual(result.trace.proxyAttemptCount, 2);
});

console.log('\n' + '═'.repeat(55));
console.log(`  结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计`);
console.log('═'.repeat(55) + '\n');

if (failed > 0) process.exit(1);
