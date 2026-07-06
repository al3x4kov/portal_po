/**
 * Remove chain-of-thought «reasoning» wrappers from a model answer (todo_18).
 *
 * Thinking models (e.g. Qwen3.5 / Qwen3.6) emit a `<think>…</think>` block with
 * their reasoning around the real payload, which breaks JSON extraction (the
 * reasoning text itself may contain brackets) and pollutes chat/description
 * output. This cuts every such block wherever it sits — before, after or
 * around a JSON array — and tolerates an unterminated block (a truncated
 * answer). It is a pure text transform and a strict no-op when no tag is
 * present (so non-thinking models — `reasoning: 'none'` — are never touched).
 *
 * Applied only when the effective model preset has `reasoning === 'strip'`.
 */
export function stripReasoning(content: string): string {
  if (!content || content.indexOf('<') < 0) return content;
  // 1) Paired blocks, any case, across newlines, non-greedy — handles
  //    surrounding / leading / trailing / repeated reasoning wrappers.
  let out = content.replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, '');
  // 2) A dangling close tag with no matching open (reasoning emitted without
  //    an opening tag): drop everything up to and including the last one.
  const closeRe = /<\/think\s*>/gi;
  let lastClose = -1;
  let m: RegExpExecArray | null;
  while ((m = closeRe.exec(out)) !== null) lastClose = m.index + m[0].length;
  if (lastClose >= 0) out = out.slice(lastClose);
  // 3) An unterminated open tag (answer cut off inside the reasoning): drop
  //    from it to the end.
  const openIdx = out.search(/<think\b[^>]*>/i);
  if (openIdx >= 0) out = out.slice(0, openIdx);
  return out.trim();
}
