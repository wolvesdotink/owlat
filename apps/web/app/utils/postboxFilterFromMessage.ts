/**
 * The filter builder's prefill for "Create filter from this message".
 *
 * The moment someone thinks "I want a rule for this" is while looking at the
 * mail, not while staring at an empty rule form in Preferences — so the sender
 * and the normalized subject travel along as query params (a shareable deep
 * link that survives a reload) and the builder seeds its conditions from them.
 * Null when the message gives the builder nothing to seed.
 */
export function postboxFilterQueryFrom(msg: {
	fromAddress?: string;
	subject?: string;
}): Record<string, string> | null {
	const query: Record<string, string> = {};
	if (msg.fromAddress) query['filterFrom'] = msg.fromAddress;
	// Strip the Re:/Fwd: run: a rule keyed on "Re: Invoice 4471" would miss the
	// original and every future thread on the same subject.
	const subject = (msg.subject ?? '').replace(/^((re|fwd|fw|aw|wg)\s*:\s*)+/i, '').trim();
	if (subject) query['filterSubject'] = subject;
	return Object.keys(query).length === 0 ? null : query;
}
