import {
    shouldAutoContinuePlainTextResponse,
    shouldAutoContinueResponse,
} from '../dist/handler.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`  ❌ ${name}`);
        console.error(`      ${message}`);
        failed++;
    }
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(message || `Expected ${expected}, got ${actual}`);
    }
}

console.log('\n📦 纯文本半句自动续写判定\n');

test('长纯文本停在半句中间时继续续写', () => {
    const text = `${'夜色沉静，草叶在风里慢慢起伏，空气中带着一点潮湿的凉意。'.repeat(5)}而他只是缓缓抬起手，像是还想再说些什`;
    assertEqual(
        shouldAutoContinuePlainTextResponse(text),
        true,
        '长纯文本没有结束表达时应继续续写',
    );
});

test('句号结尾的长纯文本不续写', () => {
    const text = `${'这是一段已经完整结束的说明文字，用来验证正常句号收尾不会误触发续写。'.repeat(4)}最终结论已经说完。`;
    assertEqual(
        shouldAutoContinuePlainTextResponse(text),
        false,
        '句号结尾不应继续续写',
    );
});

test('终止标点加闭合引号或括号时不续写', () => {
    const quoteText = `${'He kept explaining the plan in detail so the message is long enough to trigger the heuristic. '.repeat(3)}"We should stop here!"`;
    const parenText = `${'她把前因后果都解释清楚了，所以这一段应该被视为完整结尾，而不是半句截断。'.repeat(4)}这就是最后的安排！）`;

    assertEqual(shouldAutoContinuePlainTextResponse(quoteText), false, '感叹号加引号不应续写');
    assertEqual(shouldAutoContinuePlainTextResponse(parenText), false, '感叹号加闭合括号不应续写');
});

test('闭合标签或闭合代码块结尾时不续写', () => {
    const tagText = `${'段落内容已经完整表达，最后以闭合标签结束。'.repeat(5)}</summary>`;
    const codeFenceText = [
        '```md',
        '# Title',
        'This block is complete and should be treated as finished.',
        '```',
    ].join('\n').repeat(4);

    assertEqual(shouldAutoContinuePlainTextResponse(tagText), false, '闭合标签不应续写');
    assertEqual(shouldAutoContinuePlainTextResponse(codeFenceText), false, '闭合代码块不应续写');
});

test('短回复即使没句号也不续写', () => {
    assertEqual(shouldAutoContinuePlainTextResponse('好的'), false);
    assertEqual(shouldAutoContinuePlainTextResponse('42'), false);
    assertEqual(shouldAutoContinuePlainTextResponse('继续'), false);
});

test('未闭合标签或明显未完成符号结尾时继续续写', () => {
    const tagText = `${'这里是一段较长的正文，用来验证未闭合标签仍然会触发纯文本续写逻辑。'.repeat(4)}<summary>`;
    const punctuationText = `${'这是另一段足够长的说明文本，用来验证全角冒号结尾也会被视为未完成。'.repeat(4)}接下来需要注意的是：`;

    assertEqual(shouldAutoContinuePlainTextResponse(tagText), true, '未闭合标签应续写');
    assertEqual(shouldAutoContinuePlainTextResponse(punctuationText), true, '未完成符号结尾应续写');
});

test('统一判定开关关闭时，纯文本半句不续写；开启时续写', () => {
    const text = `${'This is a sufficiently long plain-text response that clearly ends mid sentence without a final punctuation mark. '.repeat(3)}and then it just stop`;

    assertEqual(shouldAutoContinueResponse(text, false, false), false, '关闭开关时不应续写');
    assertEqual(shouldAutoContinueResponse(text, false, true), true, '开启开关时应续写');
});

console.log(`\n结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计\n`);

if (failed > 0) process.exit(1);
