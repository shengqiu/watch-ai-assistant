/**
 * 纯逻辑单测：意图解析 + 长文本分段 + Telegram Update 提取。
 * 运行：npm test（内部先 tsc 编译到 /tmp/wi-test 再 node 跑）
 */
import { parseIntent, effortFor } from "../src/router/intent.js";
import { clampEffort, modelOrder } from "../src/router/providers.js";
import { escapeV2, mdToV2 } from "../src/telegram/markdown.js";
import { chunkText } from "../src/asr.js";
import { extractIncoming } from "../src/telegram/update.js";

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; } else { fail++; console.log(`FAIL ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
}

// ---- 意图解析 ----
check("gemini 编程", parseIntent("用 gemini 帮我写个爬虫").provider, "gemini");
check("gemini 任务类型", parseIntent("用 gemini 帮我写个爬虫").taskType, "code");
check("gemini prompt 清洗", parseIntent("用 gemini 帮我写个爬虫").prompt, "帮我写个爬虫");
check("deepseek", parseIntent("让 deepseek 重构这个函数").provider, "deepseek");
check("gpt", parseIntent("@gpt 解释这段报错").provider, "openai");
check("fallback 链", parseIntent("先用 deepseek，不行再用 gemini").chain, ["deepseek", "gemini"]);
check("pro 档 flagship", parseIntent("这个问题很复杂，用 pro 档").modelTier, "flagship");
check("product 不误伤", parseIntent("做个 product 页面").modelTier, "default");
check("flash fast", parseIntent("用 gemini flash 快点写").modelTier, "fast");
check("claude 仍识别", parseIntent("用 claude 写代码").provider, "anthropic");
check("google 别名", parseIntent("google 帮我看看这个").provider, "gemini");
check("未指定厂商", parseIntent("今天天气怎么样").provider, null);
check("闲聊类型", parseIntent("今天天气怎么样").taskType, "chat");
check("clean 空转原文", parseIntent("你好").prompt, "你好");

// ---- 思考档位（Gemini reasoning_effort 映射）----
check("闲聊 → minimal", effortFor(parseIntent("你好")), "minimal");
check("天气闲聊 → minimal", effortFor(parseIntent("今天天气怎么样")), "minimal");
check("写代码 → low", effortFor(parseIntent("帮我写个爬虫")), "low");
check("重构代码 → low", effortFor(parseIntent("重构这个函数")), "low");
check("明确 fast → minimal", effortFor(parseIntent("用 gemini flash 快点写")), "minimal");
check("明确 pro 档 → high", effortFor(parseIntent("这个问题很复杂，用 pro 档")), "high");
check("代码+复杂词 → high", effortFor(parseIntent("写个复杂的架构设计")), "high");

// ---- 思考档位钳制（3.7/3.8 Flash 已移除 minimal，传了直接 400）----
check("3.8-flash minimal→low", clampEffort("gemini-3.8-flash", "minimal"), "low");
check("3.7-flash minimal→low", clampEffort("gemini-3.7-flash", "minimal"), "low");
check("3.8-flash low 保持", clampEffort("gemini-3.8-flash", "low"), "low");
check("flash-lite minimal 保持", clampEffort("gemini-3.5-flash-lite", "minimal"), "minimal");
check("pro minimal→low", clampEffort("gemini-3.1-pro-preview", "minimal"), "low");
check("无档位透传 undefined", clampEffort("gemini-3.8-flash", undefined), undefined);

// ---- 模型尝试顺序 ----
const fakeCfg = {
  default_model: "gemini-3.8-flash",
  fast_model: "gemini-3.5-flash-lite",
  flagship_model: "gemini-3.1-pro-preview",
};
check("默认顺序 [主, fast]", modelOrder(fakeCfg, "default"), ["gemini-3.8-flash", "gemini-3.5-flash-lite"]);
check("闲聊顺序 [fast, 主]", modelOrder(fakeCfg, "default", true), ["gemini-3.5-flash-lite", "gemini-3.8-flash"]);
check("fast 档顺序", modelOrder(fakeCfg, "fast"), ["gemini-3.5-flash-lite"]);
check("旗舰顺序", modelOrder(fakeCfg, "flagship"), ["gemini-3.1-pro-preview", "gemini-3.5-flash-lite"]);
check("fast=default 去重", modelOrder({ ...fakeCfg, fast_model: "gemini-3.8-flash" }, "default"), ["gemini-3.8-flash"]);
check("无 fast 模型", modelOrder({ ...fakeCfg, fast_model: "" }, "default"), ["gemini-3.8-flash"]);

// ---- 长文本分段 ----
check("短文本不分段", chunkText("你好", 800), ["你好"]);
check("长文本分段数", chunkText("a".repeat(2000), 800).length, 3);
check("按换行断", chunkText("第一段\n第二段", 5), ["第一段", "第二段"]);
check("空文本", chunkText("  ", 800), []);

// ---- MarkdownV2 转义（防 Telegram 400）----
check("普通文本转义", escapeV2("你好. 世界! (x)"), "你好\\. 世界\\! \\(x\\)");
check("下划线转义", escapeV2("my_var = 1"), "my\\_var \\= 1");
check("代码块内不转义括号", mdToV2("```python\nprint(1 + 2)\n```"), "```python\nprint(1 + 2)\n```");
check("代码块语言保留", mdToV2("```js\nlet x = 1;\n```"), "```js\nlet x = 1;\n```");
check("无语言围栏", mdToV2("```\nplain code\n```"), "```\nplain code\n```");
check("行内代码保留", mdToV2("用 `print(x)` 输出"), "用 `print(x)` 输出");
check("混合文本+代码块", mdToV2("写法如下:\n```python\ndef f():\n    pass\n```\n搞定!"),
  "写法如下:\n```python\ndef f():\n    pass\n```\n搞定\\!");
check("未闭合围栏→字面量不抛错", mdToV2("```python\nx = 1"), "\\`\\`\\`python\nx \\= 1");
check("代码块内反引号转义", mdToV2("```\na`b\n```"), "```\na\\`b\n```");

// ---- 缩进代码块兜底提升（MarkdownV2 不认缩进代码块，必须转 ``` 围栏）----
check("缩进代码块→围栏", mdToV2("快排如下:\n\n    def q(l):\n        return l\n\n搞定"),
  "快排如下:\n\n```\ndef q(l):\n    return l\n```\n搞定");
check("tab 缩进→围栏", mdToV2("\tdef f():\n\t    pass"), "```\ndef f():\n    pass\n```");
check("缩进代码含特殊字符只转义引号", mdToV2("代码:\n\n    x = f(1) - 2\n    y = g(3)\n"),
  "代码:\n\n```\nx = f(1) - 2\ny = g(3)\n```");
check("嵌套列表 4 空格不误判", mdToV2("- 一级\n\n    - 三级"), "\\- 一级\n\n    \\- 三级");
check("引用块不误判", mdToV2("引用:\n\n    > 深层引用"), "引用:\n\n    \\> 深层引用");
check("单行缩进不转换", mdToV2("说明\n\n    单独一句"), "说明\n\n    单独一句");
check("段内缩进(列表续行)不转换", mdToV2("- 项\n    续行"), "\\- 项\n    续行");
check("围栏内缩进行不受影响", mdToV2("```python\ndef f():\n    pass\n```"), "```python\ndef f():\n    pass\n```");
check("缩进+围栏混合", mdToV2("第一种:\n\n    a = 1\n    b = 2\n\n第二种:\n\n```js\nlet x = 1;\n```\n"),
  "第一种:\n\n```\na = 1\nb = 2\n```\n第二种:\n\n```js\nlet x = 1;\n```\n");

// ---- 正文富文本（markdown 行内 → MarkdownV2 实体）----
check("粗体", mdToV2("这是**重点**内容"), "这是*重点*内容");
check("斜体", mdToV2("这是*强调*内容"), "这是_强调_内容");
check("删除线", mdToV2("~~旧方法~~ 新方法"), "~旧方法~ 新方法");
check("标题转粗体", mdToV2("## 快速排序"), "*快速排序*");
check("三级标题", mdToV2("### 小节"), "*小节*");
check("粗体内部转义", mdToV2("**注意. 这个!**"), "*注意\\. 这个\\!*");
check("数学乘号不误判斜体", mdToV2("2 * 3 * 4 = 24"), "2 \\* 3 \\* 4 \\= 24");
check("snake_case 不误判", mdToV2("my_var = 1"), "my\\_var \\= 1");
check("链接", mdToV2("看[文档](https://a.com/x)了解"), "看[文档](https://a.com/x)了解");
check("富文本+行内代码混合", mdToV2("**加粗** 和 `print(x)` 和 *斜体*"),
  "*加粗* 和 `print(x)` 和 _斜体_");
check("富文本+代码块混合", mdToV2("**用法**:\n```python\nf(1)\n```\n**注意**: 传参"),
  "*用法*:\n```python\nf(1)\n```\n*注意*: 传参");
check("围栏内 markdown 不转换", mdToV2("```\n**not bold**\n```"), "```\n**not bold**\n```");
check("不成对星号字面", mdToV2("a ** b"), "a \\*\\* b");

// ---- 代码块感知分段 ----
// 短代码块不被切断
const shortBlock = "前言\n```python\nx = 1\n```\n结语";
const sc = chunkText(shortBlock, 20);
check("短代码块完整保留", sc.some((c) => c.includes("```python\nx = 1\n```")), true);
// 长代码块：每段都带完整围栏
const longLines = Array.from({ length: 6 }, (_, i) => `line_${i}_xxxxxxxxxx`).join("\n");
const lc = chunkText("```python\n" + longLines + "\n```", 40);
check("长代码块被切分", lc.length > 1, true);
check("每段都有围栏", lc.every((c) => c.startsWith("```python") && c.endsWith("```")), true);
// 切分后拼接回去 = 原始代码行
const joined = lc.map((c) => c.replace(/^```python\n/, "").replace(/\n```$/, "")).join("\n");
check("代码内容不丢失", joined, longLines);

// ---- Telegram Update 提取 ----
// 文本消息
const textUpdate = {
  update_id: 100,
  message: { message_id: 1, chat: { id: 555, type: "private" }, from: { id: 555 }, date: 1, text: "  用 gemini 写个快排  " },
};
const t = extractIncoming(textUpdate);
check("文本 chat_id", t?.chatId, "555");
check("文本 trim", t?.text, "用 gemini 写个快排");
check("文本无语音", t?.voiceFileId, null);

// 语音消息（Apple Watch 场景）
const voiceUpdate = {
  update_id: 101,
  message: {
    message_id: 2,
    chat: { id: 555, type: "private" },
    from: { id: 555 },
    date: 2,
    voice: { file_id: "VOICE123", file_unique_id: "u", duration: 3, mime_type: "audio/ogg" },
  },
};
const v = extractIncoming(voiceUpdate);
check("语音 file_id", v?.voiceFileId, "VOICE123");
check("语音无文本", v?.text, "");
check("语音 mime", v?.voiceMime, "audio/ogg");

// 非消息类 update（如 callback_query）→ null
check("无 message 返回 null", extractIncoming({ update_id: 102 }), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
