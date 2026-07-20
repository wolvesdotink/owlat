/**
 * The plugin's one piece of judgement: a deterministic, in-process detector that
 * decides whether an inbound message looks like an escalation (a legal threat, a
 * regulator, a churn/cancellation notice, or an explicit complaint).
 *
 * It is deliberately boring: pure, synchronous, allocation-bounded and with no
 * I/O, so the agent step, the automation contributions and the draft strategy
 * all share exactly one definition of "escalation" and every tier can be tested
 * without a host. Scanning is capped at `MAX_SCAN_LENGTH` code units so a very
 * large body cannot turn the classification step into a CPU sink.
 */

/** Rising order of concern. `escalate` is the only level that restricts the agent. */
export type EscalationLevel = 'none' | 'watch' | 'escalate';

/** One matched signal, reported so an operator can see WHY a message was held. */
export interface EscalationSignal {
	readonly id: string;
	readonly level: Exclude<EscalationLevel, 'none'>;
}

export interface EscalationVerdict {
	readonly level: EscalationLevel;
	/** Matched signals in declaration order; deduplicated and bounded. */
	readonly signals: readonly EscalationSignal[];
}

/** Upper bound on the characters scanned from any one field. */
export const MAX_SCAN_LENGTH = 20_000;

interface SignalRule {
	readonly id: string;
	readonly level: Exclude<EscalationLevel, 'none'>;
	readonly phrases: readonly string[];
}

/**
 * Phrase rules, lowercase and matched as substrings of the normalized text.
 * Substring matching (rather than a regex per phrase) keeps the scan linear and
 * free of catastrophic backtracking on adversarial input.
 */
const SIGNAL_RULES: readonly SignalRule[] = Object.freeze([
	Object.freeze({
		id: 'legal-threat',
		level: 'escalate',
		phrases: Object.freeze([
			'our lawyer',
			'our attorney',
			'legal action',
			'small claims',
			'see you in court',
			'cease and desist',
		]),
	} as const),
	Object.freeze({
		id: 'regulator',
		level: 'escalate',
		phrases: Object.freeze([
			'data protection authority',
			'gdpr complaint',
			'ftc complaint',
			'regulatory complaint',
			'ombudsman',
		]),
	} as const),
	Object.freeze({
		id: 'chargeback',
		level: 'escalate',
		phrases: Object.freeze(['chargeback', 'dispute the charge', 'disputing the charge']),
	} as const),
	Object.freeze({
		id: 'churn',
		level: 'watch',
		phrases: Object.freeze([
			'cancel our contract',
			'cancel my subscription',
			'not renewing',
			'switching to a competitor',
		]),
	} as const),
	Object.freeze({
		id: 'complaint',
		level: 'watch',
		phrases: Object.freeze([
			'unacceptable',
			'this is outrageous',
			'worst experience',
			'formal complaint',
		]),
	} as const),
]);

/**
 * Upper bound on the signals one verdict can carry: every rule contributes at
 * most one signal, so the rule set IS the bound. Derived rather than written
 * down so the exported number cannot drift away from the rules.
 */
export const MAX_SIGNALS = SIGNAL_RULES.length;

/** The subject/body projection the detector reads. */
export interface EscalationCandidate {
	readonly subject?: string;
	readonly textBody?: string;
	readonly htmlBody?: string;
}

/**
 * Lowercase, strip HTML tags, and collapse whitespace over a bounded prefix.
 * Tag stripping is intentionally crude — this is keyword triage, not sanitizing
 * for render — but it stops `<b>legal</b> action` from hiding a phrase.
 */
function normalize(value: string | undefined): string {
	if (!value) return '';
	return value
		.slice(0, MAX_SCAN_LENGTH)
		.replace(/<[^>]*>/g, ' ')
		.toLowerCase()
		.replace(/\s+/g, ' ');
}

const LEVEL_RANK: Readonly<Record<EscalationLevel, number>> = Object.freeze({
	none: 0,
	watch: 1,
	escalate: 2,
});

/** Return the more severe of two levels. */
export function worstLevel(left: EscalationLevel, right: EscalationLevel): EscalationLevel {
	return LEVEL_RANK[left] >= LEVEL_RANK[right] ? left : right;
}

/** True when `level` is at least as severe as `minimum`. */
export function meetsLevel(level: EscalationLevel, minimum: EscalationLevel): boolean {
	return LEVEL_RANK[level] >= LEVEL_RANK[minimum];
}

/**
 * Classify a message. The result is a pure function of the inputs — the same
 * message always yields the same verdict, in declaration order — so the agent
 * step, the automation trigger and the operator UI never disagree.
 */
export function detectEscalation(candidate: EscalationCandidate): EscalationVerdict {
	const haystack = [
		normalize(candidate.subject),
		normalize(candidate.textBody),
		normalize(candidate.htmlBody),
	].join(' ');

	const signals: EscalationSignal[] = [];
	let level: EscalationLevel = 'none';
	for (const rule of SIGNAL_RULES) {
		if (!rule.phrases.some((phrase) => haystack.includes(phrase))) continue;
		signals.push({ id: rule.id, level: rule.level });
		level = worstLevel(level, rule.level);
	}

	return { level, signals: Object.freeze(signals) };
}

/** A one-line, operator-facing summary of a verdict. Never includes mail content. */
export function summarizeVerdict(verdict: EscalationVerdict): string {
	if (verdict.signals.length === 0) return 'No escalation signals detected.';
	const ids = verdict.signals.map((signal) => signal.id).join(', ');
	return `Escalation signals detected (${ids}).`;
}
