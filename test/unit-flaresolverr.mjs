import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
    const task = Promise.resolve()
        .then(fn)
        .then(() => {
            console.log(`  ✅ ${name}`);
            passed++;
        })
        .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`  ❌ ${name}`);
            console.error(`      ${message}`);
            failed++;
        });
    pending.push(task);
}

function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
        throw new Error(message || `Expected ${b}, got ${a}`);
    }
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'cursor2api-flaresolverr-'));
const tempConfigPath = join(tmpRoot, 'config.yaml');
const manualUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const runtimeUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0';

function writeConfig(content) {
    writeFileSync(tempConfigPath, content, 'utf-8');
}

writeConfig(`port: 3010
timeout: 120
cursor_model: "anthropic/claude-sonnet-4.6"
flaresolverr:
  enabled: false
  url: ""
  solve_url: "https://cursor.com/docs"
  refresh_interval_seconds: 3000
  timeout_seconds: 60
  cookie_header: "manual_a=1; manual_b=two"
  user_agent: "${manualUserAgent}"
  browser: ""
`);

process.env.CONFIG_PATH = tempConfigPath;

const configModule = await import('../dist/config.js');
const flaresolverrModule = await import('../dist/flaresolverr.js');
const cursorClientModule = await import('../dist/cursor-client.js');

const {
    reloadConfigFromDisk,
} = configModule;
const {
    buildCookieHeaderFromCookies,
    getActiveFlareSolverrBrowser,
    getActiveFlareSolverrCookieHeader,
    getActiveFlareSolverrUserAgent,
    getFlareSolverrStatusSnapshot,
    isVercelSecurityCheckpointResponse,
    parseFlareSolverrSolution,
    refreshFlareSolverrNow,
    stopFlareSolverrRefreshLoop,
} = flaresolverrModule;
const { buildCursorHeaders } = cursorClientModule;

console.log('\n📦 FlareSolverr 集成单元测试\n');

test('FlareSolverr cookies 能拼成完整 Cookie header', () => {
    const cookieHeader = buildCookieHeaderFromCookies([
        { name: '_vcrcs', value: 'token123' },
        { name: 'session', value: 'abc' },
    ]);

    assertEqual(cookieHeader, '_vcrcs=token123; session=abc');
});

test('FlareSolverr solution 能提取 cookies、UA 和 browser', () => {
    const parsed = parseFlareSolverrSolution({
        cookies: [{ name: '_vcrcs', value: 'runtime-cookie' }],
        userAgent: runtimeUserAgent,
    });

    assertEqual(parsed.cookieHeader, '_vcrcs=runtime-cookie');
    assertEqual(parsed.userAgent, runtimeUserAgent);
    assertEqual(parsed.browser, 'edge134');
});

test('手填配置会作为 FlareSolverr 的有效回退值注入请求头', () => {
    reloadConfigFromDisk();

    assertEqual(getActiveFlareSolverrCookieHeader(), 'manual_a=1; manual_b=two');
    assertEqual(getActiveFlareSolverrUserAgent(), manualUserAgent);
    assertEqual(getActiveFlareSolverrBrowser(), 'chrome140');

    const snapshot = getFlareSolverrStatusSnapshot();
    assertEqual(snapshot.valueSource, 'config', '应标记为手填配置来源');
    assertEqual(snapshot.cookieHeader, 'manual_a=1; manual_b=two');
    assertEqual(snapshot.hasCookies, true);

    const headers = buildCursorHeaders();
    assertEqual(headers.cookie, 'manual_a=1; manual_b=two', '请求头应注入手填 cookie');
    assertEqual(headers['user-agent'], manualUserAgent, '请求头应注入手填 UA');
    assert(headers['sec-ch-ua']?.includes('140'), '动态 client hints 应根据手填 UA 生成');
});

test('自动刷新成功后，运行时 cookies/UA 会覆盖手填配置', async () => {
    writeConfig(`port: 3010
timeout: 120
cursor_model: "anthropic/claude-sonnet-4.6"
flaresolverr:
  enabled: true
  url: "http://127.0.0.1:8191"
  solve_url: "https://cursor.com/docs"
  refresh_interval_seconds: 3000
  timeout_seconds: 60
  cookie_header: "manual_a=1; manual_b=two"
  user_agent: "${manualUserAgent}"
  browser: ""
`);
    reloadConfigFromDisk();

    const originalFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({
        status: 'ok',
        solution: {
            cookies: [{ name: '_vcrcs', value: 'runtime-cookie' }, { name: 'cursor_session', value: 'xyz' }],
            userAgent: runtimeUserAgent,
        },
    }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });

    try {
        const success = await refreshFlareSolverrNow('unit-test');
        assertEqual(success, true, '手动刷新应成功');

        const snapshot = getFlareSolverrStatusSnapshot();
        assertEqual(snapshot.valueSource, 'runtime', '成功刷新后应优先使用运行时值');
        assertEqual(snapshot.cookieHeader, '_vcrcs=runtime-cookie; cursor_session=xyz');
        assertEqual(snapshot.userAgent, runtimeUserAgent);
        assertEqual(snapshot.browser, 'edge134');

        const headers = buildCursorHeaders();
        assertEqual(headers.cookie, '_vcrcs=runtime-cookie; cursor_session=xyz', '请求头应优先注入运行时 cookie');
        assertEqual(headers['user-agent'], runtimeUserAgent, '请求头应优先注入运行时 UA');
        assert(headers['sec-ch-ua']?.includes('Microsoft Edge'), '动态 client hints 应根据运行时 UA/browser 生成');
    } finally {
        global.fetch = originalFetch;
        stopFlareSolverrRefreshLoop();
    }
});

test('能识别 Vercel Security Checkpoint HTML 响应', () => {
    assertEqual(
        isVercelSecurityCheckpointResponse(429, 'text/html; charset=utf-8', '<title>Vercel Security Checkpoint</title><p>We\'re verifying your browser</p>'),
        true,
    );
    assertEqual(
        isVercelSecurityCheckpointResponse(429, 'application/json', '{"ok":false}'),
        false,
    );
    assertEqual(
        isVercelSecurityCheckpointResponse(500, 'text/html', '<title>Vercel Security Checkpoint</title>'),
        false,
    );
});

await Promise.all(pending);

console.log(`\n结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计\n`);

rmSync(tmpRoot, { recursive: true, force: true });

if (failed > 0) process.exit(1);
