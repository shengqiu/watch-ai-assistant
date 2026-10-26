/**
 * 身份验证会话（纯逻辑，可单测）。
 *
 * 设计（2026-10-26 用户定）：
 *   - 白名单用户长时间无互动后，须回答验证问题才恢复服务；
 *     未验证状态下的一切问题/指令都不转发给 LLM / Codespace。
 *   - 验证通过 → 会话有效 VERIFY_SESSION_MIN 分钟（默认 30），
 *     期间任何交互自动滑动延续；超时无互动 → 重新验证。
 *
 * 设备限制说明：Telegram Bot API 不提供发送设备信息——设备限制由
 * 「账号白名单（ALLOWED_USERS）+ 本验证问题」共同达成：
 * 只有登录了该 Telegram 账号的设备（iPhone/Watch/Mac 等）能发消息。
 */

export interface VerifyState {
  /** 验证会话到期时间戳（ms）；0/过去 = 未验证 */
  exp: number;
}

export function isVerified(state: VerifyState | undefined, now: number): boolean {
  return (state?.exp ?? 0) > now;
}

/** 下一次到期时间（滑动窗口）。 */
export function nextExpiry(now: number, sessionMs: number): number {
  return now + sessionMs;
}

/** 归一化验证答案：去首尾空白与标点（「爸爸。」「 爸爸！」→「爸爸」）。 */
export function normalizeAnswer(text: string): string {
  return text
    .trim()
    .replace(/^[。．.!！?？,，、~～\s]+/, "")
    .replace(/[。．.!！?？,，、~～\s]+$/, "");
}

/** 验证答案匹配（宽松匹配首尾标点）。 */
export function isAnswerMatch(text: string, answer: string): boolean {
  const a = normalizeAnswer(text);
  return a.length > 0 && a === normalizeAnswer(answer);
}

/** 验证问题文案（用户指定）。 */
export const CHALLENGE_TEXT = "我可以回答你的问题，但我要知道你是谁...";
