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
    const angleText = `${'这是一段足够长的正文，用来验证纯文本尖括号在闭合时不会误触发续写。'.repeat(4)}<终于结束。>`;

    assertEqual(shouldAutoContinuePlainTextResponse(quoteText), false, '感叹号加引号不应续写');
    assertEqual(shouldAutoContinuePlainTextResponse(parenText), false, '感叹号加闭合括号不应续写');
    assertEqual(shouldAutoContinuePlainTextResponse(angleText), false, '终止标点加闭合尖括号不应续写');
});

test('闭合标签或闭合代码块结尾时不续写', () => {
    const tagText = `${'段落内容已经完整表达，最后以闭合标签结束。'.repeat(5)}</summary>`;
    const codeFenceText = Array.from({ length: 4 }, () => [
        '```md',
        '# Title',
        'This block is complete and should be treated as finished.',
        '```',
    ].join('\n')).join('\n\n');
    const tildeFenceText = Array.from({ length: 4 }, () => [
        '~~~md',
        'title: done',
        'body: this fenced block is already complete.',
        '~~~',
    ].join('\n')).join('\n\n');

    assertEqual(shouldAutoContinuePlainTextResponse(tagText), false, '闭合标签不应续写');
    assertEqual(shouldAutoContinuePlainTextResponse(codeFenceText), false, '闭合代码块不应续写');
    assertEqual(shouldAutoContinuePlainTextResponse(tildeFenceText), false, '闭合波浪线代码块不应续写');
});

test('短回复即使没句号也不续写', () => {
    assertEqual(shouldAutoContinuePlainTextResponse('好的'), false);
    assertEqual(shouldAutoContinuePlainTextResponse('42'), false);
    assertEqual(shouldAutoContinuePlainTextResponse('继续'), false);
});

test('未闭合标签或明显未完成符号结尾时继续续写', () => {
    const tagText = `${'这里是一段较长的正文，用来验证未闭合标签仍然会触发纯文本续写逻辑。'.repeat(4)}<summary>`;
    const unmatchedStartTagText = `<image_prompt>${'这是一段足够长的提示词正文，用来验证起始标签完整但缺少闭合标签时也会触发续写。'.repeat(5)}整个画面充满了柔和的二次元光影细节。`;
    const punctuationText = `${'这是另一段足够长的说明文本，用来验证全角冒号结尾也会被视为未完成。'.repeat(4)}接下来需要注意的是：`;

    assertEqual(shouldAutoContinuePlainTextResponse(tagText), true, '未闭合标签应续写');
    assertEqual(shouldAutoContinuePlainTextResponse(unmatchedStartTagText), true, '缺少闭合标签的完整起始标签应续写');
    assertEqual(shouldAutoContinuePlainTextResponse(punctuationText), true, '未完成符号结尾应续写');
});

test('未闭合行内代码和波浪线代码块会触发续写', () => {
    const inlineCodeText = `${'这是一段足够长的说明文本，用来验证行内反引号未闭合时也会触发续写。'.repeat(4)}最后他只留下了一个命令 \`npm run build`;
    const tildeFenceText = [
        '~~~md',
        'title: pending',
        'body: this block is still open and should continue.',
        'more: content',
    ].join('\n').repeat(3);

    assertEqual(shouldAutoContinuePlainTextResponse(inlineCodeText), true, '未闭合行内代码应续写');
    assertEqual(shouldAutoContinuePlainTextResponse(tildeFenceText), true, '未闭合波浪线代码块应续写');
});

test('未闭合的中英文单双引号会触发续写', () => {
    const asciiDoubleQuoteText = `"既然是学长的命令……那亚子，一定会表现得像个最听话的‘妹妹’一样。"

${'亚子发出一声压抑的、带着哭腔的娇喘，娇小的身体颤抖得如同秋风中的落叶。'.repeat(6)}

"学长……看吧，这就是为了学长而‘坏掉’的亚子。除了这身肉体……`;
    const asciiSingleQuoteText = `${'The narration keeps escalating and should be long enough to trigger the heuristic. '.repeat(4)}Then she whispered, 'please don't stop until the last light fades away…`;
    const chineseSingleQuoteText = `${'这段独白已经铺垫了很久，用来验证中文单引号未闭合时也会触发续写。'.repeat(4)}她忽然压低声音，说自己会永远记住这句‘誓言`;

    assertEqual(shouldAutoContinuePlainTextResponse(asciiDoubleQuoteText), true, '未闭合英文双引号应续写');
    assertEqual(shouldAutoContinuePlainTextResponse(asciiSingleQuoteText), true, '未闭合英文单引号应续写');
    assertEqual(shouldAutoContinuePlainTextResponse(chineseSingleQuoteText), true, '未闭合中文单引号应续写');
});

test('未闭合括号和纯文本尖括号会触发续写', () => {
    const parenText = `${'她把前因后果都铺陈得很长，只为了验证括号未闭合时应被视为半句截断。'.repeat(4)}最后她又补了一句（这还不是结尾`;
    const angleText = `${'这是一段足够长的叙述文本，用来验证纯文本尖括号未闭合时同样会触发续写。'.repeat(4)}直到最后他才留下一个<未完的称呼`;
    const cjkAngleText = `${'这是一段足够长的说明，用来验证新增的中文配对符号也会参与未闭合检测。'.repeat(4)}最后她轻声念出了〈未完成的名字`;
    const cjkBracketText = `${'这是一段足够长的说明，用来验证全角括号与方头括号未闭合时也会触发续写。'.repeat(4)}他把备注写进了〔尚未结束的旁白`;

    assertEqual(shouldAutoContinuePlainTextResponse(parenText), true, '未闭合括号应续写');
    assertEqual(shouldAutoContinuePlainTextResponse(angleText), true, '未闭合纯文本尖括号应续写');
    assertEqual(shouldAutoContinuePlainTextResponse(cjkAngleText), true, '未闭合中文尖括号应续写');
    assertEqual(shouldAutoContinuePlainTextResponse(cjkBracketText), true, '未闭合中文龟甲括号应续写');
});

test('英文单词内撇号不应被视为未闭合引号', () => {
    const text = `${"don't stop believing, it's only rock'n'roll when the story is already complete. ".repeat(4)}Everything has already ended properly.`;
    assertEqual(shouldAutoContinuePlainTextResponse(text), false, '单词内部撇号不应触发续写');
});

test('标签、泛型和比较表达式不应因为尖括号误触发续写', () => {
    const tagText = `${'这里是一段足够长的正文，用来验证完整标签不会被当成未闭合尖括号。'.repeat(4)}<summary>完整标签已经结束。</summary>`;
    const genericText = `${'This is a sufficiently long explanation showing that generic syntax should not be treated as plain-text angle brackets. '.repeat(3)}Type examples like Promise<string> and Map<K, V> are already complete.`;
    const comparisonText = `${'This is another long explanation proving comparisons with spaces are not plain-text brackets. '.repeat(3)}The final formula a < b is only an example, not a truncation.`;
    const cjkClosedText = `${'这是一段足够长的说明，用来验证新增的中文闭合配对符号不会导致误判。'.repeat(4)}最后她把标题写成了〈已经结束。〉`;
    const emoticonText = `${'这是一段足够长的说明，用来验证颜文字中的尖括号不会触发续写。'.repeat(12)}她只是小声嘟囔了一句 ( > ρ < )，然后认真把故事收在了这里。`;

    assertEqual(shouldAutoContinuePlainTextResponse(tagText), false, '完整标签不应触发续写');
    assertEqual(shouldAutoContinuePlainTextResponse(genericText), false, '泛型尖括号不应触发续写');
    assertEqual(shouldAutoContinuePlainTextResponse(comparisonText), false, '比较表达式不应触发续写');
    assertEqual(shouldAutoContinuePlainTextResponse(cjkClosedText), false, '闭合中文尖括号不应触发续写');
    assertEqual(shouldAutoContinuePlainTextResponse(emoticonText), false, '颜文字尖括号不应触发续写');
});

test('较早位置的未闭合结构不应影响已完整结尾', () => {
    const earlyTagText = `<content>${'这是一段很长的正文，用来验证早前出现的结构片段不应单独触发续写。'.repeat(20)}最终这一段已经完整结束。`;
    const earlyQuoteText = `"${'这是一段很长的正文，用来验证较早出现的未闭合引号不应影响末尾已经收口的结果。'.repeat(20)}最后这一句已经平稳落下。`;

    assertEqual(shouldAutoContinuePlainTextResponse(earlyTagText), false, '较早位置的未闭合标签不应单独触发续写');
    assertEqual(shouldAutoContinuePlainTextResponse(earlyQuoteText), false, '较早位置的未闭合引号不应单独触发续写');
});

test('未闭合 HTML 注释、CDATA 和处理指令会触发续写', () => {
    const commentText = `${'这是一段足够长的正文，用来验证 HTML 注释未闭合时也要触发续写。'.repeat(4)}<!-- 这里的注释还没有结束`;
    const cdataText = `${'这是一段足够长的正文，用来验证 CDATA 块未闭合时也要触发续写。'.repeat(4)}<![CDATA[里面的内容还在继续`;
    const piText = `${'这是一段足够长的正文，用来验证处理指令未闭合时也要触发续写。'.repeat(4)}<?xml version="1.0"`;
    const closedCommentText = `${'这是一段足够长的正文，用来验证闭合的 HTML 注释不会误触发续写。'.repeat(4)}<!-- comment is closed -->最终这一句已经说完。`;

    assertEqual(shouldAutoContinuePlainTextResponse(commentText), true, '未闭合 HTML 注释应续写');
    assertEqual(shouldAutoContinuePlainTextResponse(cdataText), true, '未闭合 CDATA 应续写');
    assertEqual(shouldAutoContinuePlainTextResponse(piText), true, '未闭合处理指令应续写');
    assertEqual(shouldAutoContinuePlainTextResponse(closedCommentText), false, '闭合 HTML 注释不应触发续写');
});

test('纯文本 Markdown 表格和列表骨架会触发续写', () => {
    const tableText = `${'这是一段足够长的说明文字，用来验证 Markdown 表格骨架在纯文本路径中也能识别。'.repeat(4)}\n| name |`;
    const separatorText = `${'这是一段足够长的说明文字，用来验证 Markdown 表格分隔线骨架也能识别。'.repeat(4)}\n| --- | --- |`;
    const listText = `${'这是一段足够长的说明文字，用来验证列表骨架在纯文本路径中也能识别。'.repeat(4)}\n- `;
    const quoteText = `${'这是一段足够长的说明文字，用来验证 blockquote 骨架在纯文本路径中也能识别。'.repeat(4)}\n> `;

    assertEqual(shouldAutoContinuePlainTextResponse(tableText), true, 'Markdown 表格骨架应续写');
    assertEqual(shouldAutoContinuePlainTextResponse(separatorText), true, 'Markdown 表格分隔线骨架应续写');
    assertEqual(shouldAutoContinuePlainTextResponse(listText), true, 'Markdown 列表骨架应续写');
    assertEqual(shouldAutoContinuePlainTextResponse(quoteText), true, 'Markdown 引用骨架应续写');
});

test('统一判定开关关闭时，纯文本半句不续写；开启时续写', () => {
    const text = `${'This is a sufficiently long plain-text response that clearly ends mid sentence without a final punctuation mark. '.repeat(3)}and then it just stop`;

    assertEqual(shouldAutoContinueResponse(text, false, false), false, '关闭开关时不应续写');
    assertEqual(shouldAutoContinueResponse(text, false, true), true, '开启开关时应续写');
});

console.log(`\n结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计\n`);

if (failed > 0) process.exit(1);
