import { autoContinueCursorToolResponseStream } from '../dist/handler.js';
import { parseToolCalls } from '../dist/converter.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
    Promise.resolve()
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

function buildCursorReq() {
    return {
        model: 'claude-sonnet-4-5',
        id: 'req_test',
        trigger: 'user',
        messages: [
            {
                id: 'msg_user',
                role: 'user',
                parts: [{ type: 'text', text: 'Write a long file.' }],
            },
        ],
    };
}

function createSseResponse(deltas) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        start(controller) {
            for (const delta of deltas) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'text-delta', delta })}\n\n`));
            }
            controller.close();
        },
    });

    return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
    });
}

console.log('\n📦 OpenAI 流式截断回归\n');

await (async () => {
    const originalFetch = global.fetch;
    const fetchCalls = [];

    try {
        global.fetch = async (url, init) => {
            fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });

            return createSseResponse([
                'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
                'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
                'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
                'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
                '"\n  }\n}\n```',
            ]);
        };

        const initialResponse = [
            '准备写入文件。',
            '',
            '```json action',
            '{',
            '  "tool": "Write",',
            '  "parameters": {',
            '    "file_path": "/tmp/long.txt",',
            '    "content": "AAAA' + 'A'.repeat(1800),
        ].join('\n');

        const fullResponse = await autoContinueCursorToolResponseStream(buildCursorReq(), initialResponse, true);
        const parsed = parseToolCalls(fullResponse);

        assertEqual(fetchCalls.length, 1, '长 Write 截断应触发一次续写请求');
        assertEqual(parsed.toolCalls.length, 1, '续写后应恢复出一个工具调用');
        assertEqual(parsed.toolCalls[0].name, 'Write');
        assert(typeof fetchCalls[0].body?.messages?.at(-1)?.parts?.[0]?.text === 'string', '续写请求应包含 user 引导消息');
        assert(fetchCalls[0].body.messages.at(-1).parts[0].text.includes('Continue EXACTLY from where you stopped'), '续写提示词应正确注入');

        const content = String(parsed.toolCalls[0].arguments.content || '');
        assert(content.startsWith('AAAA'), '应保留原始截断前缀');
        assert(content.includes('BBBB'), '应拼接续写补全内容');

        const argsStr = JSON.stringify(parsed.toolCalls[0].arguments);
        const CHUNK_SIZE = 128;
        const chunks = [];
        for (let j = 0; j < argsStr.length; j += CHUNK_SIZE) {
            chunks.push(argsStr.slice(j, j + CHUNK_SIZE));
        }
        assert(chunks.length > 1, '长 Write 参数在 OpenAI 流式中应拆成多帧 tool_calls');
        assertEqual(chunks.join(''), argsStr, '分块后重新拼接应等于原始 arguments');

        console.log('  ✅ 长 Write 截断后续写并恢复为多帧 tool_calls');
        passed++;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('  ❌ 长 Write 截断后续写并恢复为多帧 tool_calls');
        console.error(`      ${message}`);
        failed++;
    } finally {
        global.fetch = originalFetch;
    }
})();

await (async () => {
    const originalFetch = global.fetch;
    let fetchCount = 0;

    try {
        global.fetch = async () => {
            fetchCount++;
            throw new Error('短参数工具不应触发续写请求');
        };

        const initialResponse = [
            '```json action',
            '{',
            '  "tool": "Read",',
            '  "parameters": {',
            '    "file_path": "/tmp/config.yaml"',
            '  }',
        ].join('\n');

        const fullResponse = await autoContinueCursorToolResponseStream(buildCursorReq(), initialResponse, true);
        const parsed = parseToolCalls(fullResponse);

        assertEqual(fetchCount, 0, '短参数 Read 不应进入续写');
        assertEqual(parsed.toolCalls.length, 1, '即使未闭合也应直接恢复短参数工具');
        assertEqual(parsed.toolCalls[0].name, 'Read');

        console.log('  ✅ 短参数 Read 不会在 OpenAI 流式路径中误续写');
        passed++;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('  ❌ 短参数 Read 不会在 OpenAI 流式路径中误续写');
        console.error(`      ${message}`);
        failed++;
    } finally {
        global.fetch = originalFetch;
    }
})();

console.log(`\n结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计\n`);

if (failed > 0) process.exit(1);
