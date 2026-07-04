/**
 * Confirmed-facts assembly for the `draft` step — extracted from
 * `draft/index.ts` to keep it under the ~500 LOC cap (CONVENTIONS.md).
 */

/**
 * Turn the answered questions on a message's `pendingClarification` into the
 * TRUSTED confirmed-facts block the draft step renders outside the untrusted
 * tags. Pure + exported so a unit test can assert the framing without a live
 * model. Returns '' when there is nothing confirmed (no pending clarification,
 * or every question is still unanswered — the abandoned-question fallback path),
 * so an unanswered best-guess draft carries no confirmed block. The values come
 * from the authenticated owner (or their stored memory), never from the inbound
 * email, so they are safe to present as trusted.
 */
export function buildConfirmedContext(
	pending:
		| {
				questions: ReadonlyArray<{
					text: string;
					answer?: { value: string } | undefined;
				}>;
		  }
		| undefined
		| null
): string {
	if (!pending) return '';
	const lines: string[] = [];
	for (const q of pending.questions) {
		if (q.answer && q.answer.value.trim().length > 0) {
			lines.push(`- ${q.text.trim()} ${q.answer.value.trim()}`);
		}
	}
	if (lines.length === 0) return '';
	return lines.join('\n');
}
