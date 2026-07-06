/**
 * Human trust language for agent-drafted replies.
 *
 * Maps the draft-quality self-check output (a 0..1 confidence score + the
 * free-form self-check flags the critique pass produced — see
 * `agent/shared/draftService.ts` `runDraftSelfCheck`) onto THREE human states:
 *
 *   - "Ready to send"  — nothing stood out; a glance is enough.
 *   - "Worth a look"   — something is worth a skim before it goes out.
 *   - "Needs you"      — the agent is not confident (or couldn't check);
 *                        read it before anything is sent.
 *
 * The raw score and flag strings never reach the UI directly: flags are
 * translated through a plain-language copy table (unknown flags fall back to a
 * generic reason, never the raw string), and the numeric confidence survives
 * only as a quiet power-user detail line ("Agent confidence 62%") behind
 * progressive disclosure.
 *
 * Pure presentation mapping — no backend semantics change. The review gate
 * still decides auto-send on the backend; this is REVIEW language only.
 */

export type TrustLevel = 'ready' | 'look' | 'needs-you';
export type TrustVariant = 'success' | 'warning' | 'error';

export interface TrustLabel {
	level: TrustLevel;
	label: 'Ready to send' | 'Worth a look' | 'Needs you';
	variant: TrustVariant;
	/** Plain-language reasons a reviewer should know — never raw flag strings. */
	reasons: string[];
	/** Quiet power-user detail for the popover footer, e.g. "Agent confidence 62%". */
	detail: string;
}

/** At or above this self-check score (with no flags) the draft reads "Ready to send". */
export const TRUST_READY_MIN = 0.8;
/** At or above this self-check score the draft is at worst "Worth a look". */
export const TRUST_LOOK_MIN = 0.6;

/**
 * Copy table translating the known self-check flag themes into plain language.
 *
 * The self-check produces FREE-FORM short phrases (its prompt steers it toward
 * completeness, grounding — invented facts/prices/policies/dates/commitments —
 * and tone; `mail/aiCoach.ts` categorizes the same flags heuristically), so the
 * table matches themes, first match wins. Order matters: the more specific
 * money/grounding/commitment themes sit above the broader policy/date buckets.
 */
export const TRUST_FLAG_COPY: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
	{
		pattern: /price|pricing|cost|quote|discount|fee\b|fees\b|amount|figure|\$|€|£/i,
		reason: "Mentions a price or number I couldn't verify",
	},
	{
		pattern:
			/invent|made.?up|fabricat|hallucinat|ungrounded|not grounded|no source|unverifi|unsupported|not (in|from) the (context|thread|email|conversation)|could ?n[o']?t verify/i,
		reason: "States something I couldn't trace back to the conversation",
	},
	{
		pattern: /commit|promis|guarantee|agree(s|d)? to|obligat|on your behalf/i,
		reason: 'Makes a commitment on your behalf',
	},
	{
		pattern: /polic(y|ies)|terms|legal|refund|warranty|contract/i,
		reason: 'References a policy or terms worth double-checking',
	},
	{
		pattern: /date|deadline|schedul|appointment|time(line|frame)?\b/i,
		reason: 'Mentions a date or time worth confirming',
	},
	{
		pattern:
			/tone|rude|curt|harsh|abrupt|blunt|cold|aggressive|dismissive|impolite|unfriendly|too (formal|informal|casual)/i,
		reason: 'Tone reads harsher than your usual replies',
	},
	{
		pattern:
			/incomplete|not complete|missing|missed|does ?n[o']?t (answer|address|respond)|unanswered|ignores|skipped|left out|partial/i,
		reason: 'May not answer everything they asked',
	},
	{
		pattern: /ambigu|vague|unclear|confusing|misread|open to interpretation|non.?committal/i,
		reason: 'Part of the reply is vague and could be misread',
	},
	{
		pattern: /\bname\b|greeting|recipient|wrong person|salutation|addressee/i,
		reason: 'Double-check names and who the reply addresses',
	},
	{
		pattern: /attach|\blink\b|\burl\b|\bfile\b/i,
		reason: 'Mentions an attachment or link that may be missing',
	},
];

/** Fallback for a flag the copy table doesn't recognize — never the raw string. */
export const TRUST_GENERIC_REASON = 'Something else looked off — worth a skim before you send';

/** Shown when the self-check itself failed (previously the "Unverified" badge). */
export const TRUST_UNCHECKED_REASON =
	"I couldn't run my usual checks on this draft, so please read it closely";

/** Translate ONE self-check flag into plain language (generic on no match). */
export function trustFlagReason(flag: string): string {
	for (const entry of TRUST_FLAG_COPY) {
		if (entry.pattern.test(flag)) return entry.reason;
	}
	return TRUST_GENERIC_REASON;
}

const LABELS: Record<TrustLevel, { label: TrustLabel['label']; variant: TrustVariant }> = {
	ready: { label: 'Ready to send', variant: 'success' },
	look: { label: 'Worth a look', variant: 'warning' },
	'needs-you': { label: 'Needs you', variant: 'error' },
};

function build(level: TrustLevel, reasons: string[], detail: string): TrustLabel {
	const { label, variant } = LABELS[level];
	return { level, label, variant, reasons, detail };
}

/**
 * Map (self-check confidence, self-check flags) → the human trust state.
 *
 * `confidence` is the 0..1 draft-quality score; pass `null`/`undefined` when
 * the self-check failed (the old "Unverified" state) — that always reads
 * "Needs you", conservatively. Any translated flag demotes a high score to
 * "Worth a look": a clean-scoring draft that still tripped a flag deserves
 * eyes. Reasons are deduped and never empty — every state explains WHY.
 */
export function trustLabel(
	confidence: number | null | undefined,
	selfCheckFlags: readonly string[] = []
): TrustLabel {
	const reasons = [
		...new Set(
			selfCheckFlags
				.filter((flag) => typeof flag === 'string' && flag.trim().length > 0)
				.map(trustFlagReason)
		),
	];

	if (confidence === null || confidence === undefined) {
		return build('needs-you', [TRUST_UNCHECKED_REASON, ...reasons], 'Agent confidence unavailable');
	}

	const detail = `Agent confidence ${Math.round(confidence * 100)}%`;

	if (confidence < TRUST_LOOK_MIN) {
		return build(
			'needs-you',
			reasons.length > 0
				? reasons
				: ['The agent is not confident in this draft — please read it before it goes out'],
			detail
		);
	}
	if (confidence < TRUST_READY_MIN || reasons.length > 0) {
		return build(
			'look',
			reasons.length > 0 ? reasons : ['A quick read is worth it before this goes out'],
			detail
		);
	}
	return build('ready', ['Nothing stood out — the reply looks complete and accurate'], detail);
}

/**
 * Trust state for a draftless escalation (the agent held the message for a
 * human instead of drafting at all). Always "Needs you" — there is no draft to
 * score, so no confidence detail either; the caller surfaces the classifier's
 * confidence as an extra quiet detail line if it wants.
 */
export function escalationTrustLabel(): TrustLabel {
	return build(
		'needs-you',
		['The agent held this for you instead of answering on its own'],
		'No agent draft'
	);
}
