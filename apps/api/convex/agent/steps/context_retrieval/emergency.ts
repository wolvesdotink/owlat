/**
 * Emergency-tier compaction helpers for the `context_retrieval` step.
 *
 * Split out of `index.ts` (domain sibling) so the step file stays under the
 * file-size gate. Holds the emergency grounding budget, the pure snippet/
 * truncation helpers, and the compact re-assembly used when the full briefing
 * is too large to keep. All pure — no Convex seams — so they unit-test directly.
 */

/**
 * Emergency-tier grounding budget. The emergency tier fires on the longest,
 * hardest threads — precisely the ones that most need grounding — so instead of
 * collapsing to contact + current-message only (which throws away every fact,
 * commitment, and file), it PRESERVES a compact grounding set: the top few
 * knowledge facts and open commitments, each truncated to one short line, plus a
 * budget-bounded slice of the current message. Counts + per-fact truncation keep
 * this bounded no matter how large the discarded material was.
 */
export const EMERGENCY_BUDGET = {
	knowledgeLimit: 3,
	commitmentLimit: 3,
	// Per-fact content truncation (chars) inside the compact emergency block.
	factChars: 240,
	// Floor on chars reserved for the (truncated) current message, so grounding
	// facts can never crowd out the message we are actually replying to.
	minCurrentMessageChars: 4000,
};

/** One-line activity content snippet (chars). Keeps [RECENT ACTIVITY] terse. */
export const ACTIVITY_SNIPPET_CHARS = 120;

/** Truncate to `max` chars with an ellipsis marker, collapsing internal newlines
 * so a compacted one-liner stays one line. */
export function truncateOneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

/**
 * A one-line CONTENT snippet for a contact activity, derived from its typed
 * metadata (email subject / clicked link / topic / property change / bounce
 * reason / creation source). Pure + exported so a unit test can assert the
 * mapping. Returns '' when there is nothing human-meaningful to show, in which
 * case [RECENT ACTIVITY] falls back to the bare type+timestamp line.
 *
 * SECURITY: metadata is NOT uniformly first-party — `emailSubject` on
 * inbound_received/inbound_replied activities is the attacker-controlled inbound
 * Subject (see inbox/messages.ts), so this snippet can surface attacker text. It
 * is safe to surface only because the whole context block is delivered inside
 * `<untrusted_email_content>` downstream (draft/index.ts), i.e. it stays DATA,
 * never instruction — do NOT lift this snippet out of that frame. Also
 * length-capped to keep the briefing terse.
 */
export function activityContentSnippet(activity: {
	metadata?:
		| {
				emailSubject?: string;
				linkUrl?: string;
				topicName?: string;
				propertyKey?: string;
				newValue?: string;
				bounceType?: string;
				errorMessage?: string;
				reason?: string;
				source?: string;
		  }
		| null;
}): string {
	const m = activity.metadata;
	if (!m) return '';
	let raw: string | undefined;
	if (m.emailSubject) raw = `"${m.emailSubject}"`;
	else if (m.linkUrl) raw = m.linkUrl;
	else if (m.topicName) raw = m.topicName;
	else if (m.propertyKey) raw = `${m.propertyKey}${m.newValue ? ` → ${m.newValue}` : ''}`;
	else if (m.errorMessage) raw = m.errorMessage;
	else if (m.bounceType) raw = m.bounceType;
	else if (m.reason) raw = m.reason;
	else if (m.source) raw = m.source;
	if (!raw) return '';
	return truncateOneLine(raw, ACTIVITY_SNIPPET_CHARS);
}

/**
 * Re-assemble a COMPACT grounding briefing for the emergency tier. The full
 * briefing was too large to keep, but this tier fires on the longest/hardest
 * threads — the ones that most need grounding. So rather than collapse to
 * contact + current-message only (dropping every fact, commitment, and file),
 * we rebuild from the top knowledge facts + open commitments captured upstream,
 * plus a budget-bounded slice of the current message. Bounded by counts +
 * per-fact truncation upstream, so it can't itself blow the budget. Pure.
 */
export function assembleEmergencyContext(params: {
	contactSection?: string;
	commitmentLines: string[];
	knowledgeLines: string[];
	recentActivitySection?: string;
	currentMessageSection: string;
	maxChars: number;
}): string {
	const groundingParts: string[] = [];
	if (params.contactSection) groundingParts.push(params.contactSection);
	if (params.commitmentLines.length > 0) {
		groundingParts.push(
			'[OPEN COMMITMENTS — still owed to this contact; honour these]\n' +
				params.commitmentLines.join('\n')
		);
	}
	if (params.knowledgeLines.length > 0) {
		groundingParts.push('[KEY FACTS]\n' + params.knowledgeLines.join('\n'));
	}
	if (params.recentActivitySection) groundingParts.push(params.recentActivitySection);

	const groundingBlock = groundingParts.join('\n\n');
	// Reserve room for the current message: whatever the compact grounding block
	// didn't use, floored so grounding can never starve the message we're replying to.
	const currentBudget = Math.max(
		EMERGENCY_BUDGET.minCurrentMessageChars,
		params.maxChars - groundingBlock.length
	);
	const currentTrimmed =
		params.currentMessageSection.length > currentBudget
			? params.currentMessageSection.slice(0, currentBudget) + '\n…[truncated]'
			: params.currentMessageSection;
	return groundingBlock ? `${groundingBlock}\n\n${currentTrimmed}` : currentTrimmed;
}
