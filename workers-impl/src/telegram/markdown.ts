/**
 * LLM markdown → Telegram MarkdownV2 安全转换。
 *
 * 为什么需要：LLM 按系统提示输出 markdown 代码块（```python ... ```），
 * 但 Telegram 默认按纯文本渲染——用户看到的是原始 ``` 符号。
 * 直接加 parse_mode 不行：MarkdownV2 有 18 个特殊字符（. ! ( ) - # = 等），
 * LLM 输出必然包含，不转义会被 Telegram 以 400 "can't parse entities" 拒收。
 *
 * 策略（安全优先）：
 *   - 围栏代码块 ```lang ... ``` → 原样转为 V2 pre 块（块内只转义 ` 和 \，
 *     代码里的 ( ) . ! 等保持原样，正确渲染）
 *   - 行内代码 `x` → 保留，内容同样只转义 ` 和 \
 *   - 正文行内 markdown → V2 实体：**粗体**→*粗体*、*斜体*→_斜体_、
 *     ~~删除线~~→~删除线~、## 标题→*粗体*（V2 无标题实体）、[文字](url)→链接
 *   - 其余文本 → 全量转义（特殊字符变字面量，显示原字符，不会 400）
 *   - 不成对的 ```（模型偶尔输出未闭合围栏）→ 按普通文本转义，降级为字面量
 *   - 4 空格/tab 缩进代码块（模型另一种常见代码输出格式）→ 提升为 ``` 围栏。
 *     为什么必须转：Telegram MarkdownV2 只认 ``` 围栏，不认缩进代码块——
 *     不转的话代码渲染成普通文本（用户实测踩坑：手机端看到无底色非等宽代码）。
 *   - V2 无实体的 markdown 特性（列表 - 1.、引用 >、表格）→ 只能字面显示，
 *     这是平台限制，非转换缺陷。
 */

/** MarkdownV2 普通文本中需转义的特殊字符（官方文档全集） */
const V2_SPECIAL = /([_*[\]()~`>#+\-=|{}.!])/g;

/** 4 空格或 1 个 tab 起始 = 缩进行（CommonMark 代码块判定） */
const INDENTED = /^( {4}|\t)/;

/** 去掉缩进后是列表项/引用 → 是排版结构不是代码（防嵌套列表误判） */
const NOT_CODE = /^\s*([-*+]|\d+[.)]|>)\s/;

/**
 * 把 4 空格/tab 缩进的连续行块提升为 ``` 围栏代码块。
 * 保守策略（误判成本 > 漏判成本）：
 *   - 块起始要求：文本开头或前一行是空行（排除段内缩进，如列表续行）
 *   - 块内 ≥2 行才转（单行缩进更可能是普通缩进句子）
 *   - 列表项/引用样子的行不当代码
 */
function liftIndentedCode(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let block: string[] | null = null;

  const endBlock = () => {
    if (block === null) return;
    const code = block;
    block = null;
    while (code.length > 0 && code[code.length - 1] === "") code.pop(); // 去尾部空行
    if (code.length >= 2) {
      out.push("```", ...code, "```");
    } else if (code.length === 1) {
      out.push("    " + code[0]); // 单行缩进还原，保持普通文本
    }
  };

  for (const line of lines) {
    const stripped = INDENTED.test(line) ? line.replace(/^( {4}|\t)/, "") : null;
    if (block !== null) {
      if (stripped !== null) block.push(stripped);
      else if (line.trim() === "") block.push(""); // 块内空行暂存，后续有代码行则属块内
      else {
        endBlock();
        out.push(line);
      }
      continue;
    }
    if (stripped !== null && !NOT_CODE.test(stripped)) {
      const prev = out.length > 0 ? out[out.length - 1] : "";
      if (out.length === 0 || prev === "") block = [stripped];
      else out.push(line); // 段内缩进（列表续行等）→ 原样保留
    } else {
      out.push(line);
    }
  }
  endBlock();
  return out.join("\n");
}

/** 转义普通文本 */
export function escapeV2(text: string): string {
  return text.replace(V2_SPECIAL, "\\$1");
}

/** 转义代码块/行内代码内容（V2 规定块内只需转义 ` 和 \） */
function escapeCode(text: string): string {
  return text.replace(/([`\\])/g, "\\$1");
}

/** 链接 URL 内只有 ) 和 \ 需要转义（它们是 URL 的结束/转义符） */
function escapeUrl(url: string): string {
  return url.replace(/([)\\])/g, "\\$1");
}

/**
 * 单行富文本转换：markdown 行内语法 → MarkdownV2 实体。
 *   **粗体** → *粗体*    *斜体* → _斜体_    ~~删除线~~ → ~删除线~
 *   [文字](url) → 链接实体
 * 约束：内容首尾不能是空白（防 "2 * 3 * 4" 数学式误判为斜体）。
 * 不认识的形态 → 逐字符转义为字面量，绝不抛错、绝不 400。
 */
function convertSpans(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let m = /^\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/.exec(rest);
    if (m) {
      out += "*" + escapeV2(m[1]) + "*";
      i += m[0].length;
      continue;
    }
    m = /^~~(?!\s)([^~\n]+?)(?<!\s)~~/.exec(rest);
    if (m) {
      out += "~" + escapeV2(m[1]) + "~";
      i += m[0].length;
      continue;
    }
    m = /^\*(?!\s)([^*\n]+?)(?<!\s)\*/.exec(rest);
    if (m) {
      out += "_" + escapeV2(m[1]) + "_";
      i += m[0].length;
      continue;
    }
    m = /^\[([^\]\n]+)\]\((\S+)\)/.exec(rest);
    if (m) {
      out += "[" + escapeV2(m[1]) + "](" + escapeUrl(m[2]) + ")";
      i += m[0].length;
      continue;
    }
    out += escapeV2(text[i]); // 普通字符：转义为字面量
    i += 1;
  }
  return out;
}

/** 按行处理：标题行（# ~ ######）→ 粗体（V2 无标题实体，粗体视觉最接近） */
function convertRich(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      return h ? "*" + convertSpans(h[2]) + "*" : convertSpans(line);
    })
    .join("\n");
}

/** 行内代码 `x` → 保留围栏并转义内容；其余部分转富文本（markdown 行内 → V2 实体） */
function convertInline(text: string): string {
  const parts = text.split(/(`[^`\n]+`)/g);
  return parts
    .map((p, i) => (i % 2 === 1 ? "`" + escapeCode(p.slice(1, -1)) + "`" : convertRich(p)))
    .join("");
}

/** LLM markdown → Telegram MarkdownV2。任何输入都不会抛错，最差退化为字面量显示。 */
export function mdToV2(md: string): string {
  const lifted = liftIndentedCode(md); // 先把缩进代码块提升为围栏，再统一转围栏
  const parts = lifted.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 0) return convertInline(part);
      const m = /^```([^\n]*)\n?([\s\S]*?)\n?```$/.exec(part);
      if (!m) return escapeV2(part); // 不成型的围栏 → 字面量
      const lang = m[1].trim();
      const head = lang ? "```" + lang + "\n" : "```\n";
      return head + escapeCode(m[2]) + "\n```";
    })
    .join("");
}
