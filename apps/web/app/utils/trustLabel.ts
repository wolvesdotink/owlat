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

/**
 * A message the renderer translates. This vocabulary is a module-scope registry,
 * so it never calls `useI18n`: every human-facing field carries an i18n KEY, and
 * a parameterized one carries `{ key, params }` (see the localization guide).
 */
export type TrustMessage = string | { key: string; params?: Record<string, unknown> };

export interface TrustLabel {
	level: TrustLevel;
	/** i18n key — "Ready to send" / "Worth a look" / "Needs you". */
	label: string;
	variant: TrustVariant;
	/** Plain-language reasons a reviewer should know — never raw flag strings. */
	reasons: TrustMessage[];
	/** Quiet power-user detail for the popover footer, e.g. "Agent confidence 62%". */
	detail: TrustMessage;
}

/** At or above this self-check score (with no flags) the draft reads "Ready to send". */
const TRUST_READY_MIN = 0.8;
/** At or above this self-check score the draft is at worst "Worth a look". */
const TRUST_LOOK_MIN = 0.6;

/**
 * Copy table translating the known self-check flag themes into plain language.
 *
 * The self-check produces FREE-FORM short phrases (its prompt steers it toward
 * completeness, grounding — invented facts/prices/policies/dates/commitments —
 * and tone; `mail/ai/coach.ts` categorizes the same flags heuristically), so the
 * table matches themes, first match wins. Order matters: the more specific
 * money/grounding/commitment themes sit above the broader policy/date buckets.
 */
export const TRUST_FLAG_COPY: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
	{
		pattern: /price|pricing|cost|quote|discount|fee\b|fees\b|amount|figure|\$|€|£/i,
		reason: 'shared.trustLabel.reasons.price',
	},
	{
		pattern:
			/invent|made.?up|fabricat|hallucinat|ungrounded|not grounded|no source|unverifi|unsupported|not (in|from) the (context|thread|email|conversation)|could ?n[o']?t verify/i,
		reason: 'shared.trustLabel.reasons.ungrounded',
	},
	{
		pattern: /commit|promis|guarantee|agree(s|d)? to|obligat|on your behalf/i,
		reason: 'shared.trustLabel.reasons.commitment',
	},
	{
		pattern: /polic(y|ies)|terms|legal|refund|warranty|contract/i,
		reason: 'shared.trustLabel.reasons.policy',
	},
	{
		pattern: /date|deadline|schedul|appointment|time(line|frame)?\b/i,
		reason: 'shared.trustLabel.reasons.date',
	},
	{
		pattern:
			/tone|rude|curt|harsh|abrupt|blunt|cold|aggressive|dismissive|impolite|unfriendly|too (formal|informal|casual)/i,
		reason: 'shared.trustLabel.reasons.tone',
	},
	{
		pattern:
			/incomplete|not complete|missing|missed|does ?n[o']?t (answer|address|respond)|unanswered|ignores|skipped|left out|partial/i,
		reason: 'shared.trustLabel.reasons.incomplete',
	},
	{
		pattern: /ambigu|vague|unclear|confusing|misread|open to interpretation|non.?committal/i,
		reason: 'shared.trustLabel.reasons.vague',
	},
	{
		pattern: /\bname\b|greeting|recipient|wrong person|salutation|addressee/i,
		reason: 'shared.trustLabel.reasons.recipient',
	},
	{
		pattern: /attach|\blink\b|\burl\b|\bfile\b/i,
		reason: 'shared.trustLabel.reasons.attachment',
	},
];

/** Fallback for a flag the copy table doesn't recognize — never the raw string. */
export const TRUST_GENERIC_REASON = 'shared.trustLabel.reasons.generic';

/** Shown when the self-check itself failed (previously the "Unverified" badge). */
export const TRUST_UNCHECKED_REASON = 'shared.trustLabel.reasons.unchecked';

/** Translate ONE self-check flag into plain language (generic on no match). */
export function trustFlagReason(flag: string): string {
	for (const entry of TRUST_FLAG_COPY) {
		if (entry.pattern.test(flag)) return entry.reason;
	}
	return TRUST_GENERIC_REASON;
}

const LABELS: Record<TrustLevel, { label: TrustLabel['label']; variant: TrustVariant }> = {
	ready: { label: 'shared.trustLabel.labels.ready', variant: 'success' },
	look: { label: 'shared.trustLabel.labels.look', variant: 'warning' },
	'needs-you': { label: 'shared.trustLabel.labels.needsYou', variant: 'error' },
};

function build(level: TrustLevel, reasons: TrustMessage[], detail: TrustMessage): TrustLabel {
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
		return build(
			'needs-you',
			[TRUST_UNCHECKED_REASON, ...reasons],
			'shared.trustLabel.detail.unavailable'
		);
	}

	const detail: TrustMessage = {
		key: 'shared.trustLabel.detail.confidence',
		params: { percent: Math.round(confidence * 100) },
	};

	if (confidence < TRUST_LOOK_MIN) {
		return build(
			'needs-you',
			reasons.length > 0 ? reasons : ['shared.trustLabel.reasons.lowConfidence'],
			detail
		);
	}
	if (confidence < TRUST_READY_MIN || reasons.length > 0) {
		return build(
			'look',
			reasons.length > 0 ? reasons : ['shared.trustLabel.reasons.quickRead'],
			detail
		);
	}
	return build('ready', ['shared.trustLabel.reasons.nothingStoodOut'], detail);
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
		['shared.trustLabel.reasons.escalation'],
		'shared.trustLabel.detail.noDraft'
	);
}
