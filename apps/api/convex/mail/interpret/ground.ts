/**
 * Mechanical grounding of an interpretation (SPEC §4, plan §11 S2/S3): which
 * of the model's proposed items, transitions, latest-update lines and facts
 * the message itself supports, and which derived strings need a human look.
 *
 * Rules:
 *   - every quote must appear verbatim (`./quoteMatch`: NFKC, quote/dash
 *     folding, whitespace collapse) in the segment it names; one failed quote
 *     rejects the claim it supports and marks coverage incomplete;
 *   - a claim with no quote is dropped (counted as unsupported);
 *   - items must quote the sender's fresh text, or a forwarded message whose
 *     fresh part hands it to us ("can you handle the below?"); asks that sit
 *     only in quoted history, a plain forward, a signature or a disclaimer stay
 *     context. Transitions and latest lines need fresh or forwarded text;
 *     facts may come from anything but a disclaimer;
 *   - every derived string (assertion, display text, options, latest lines,
 *     fact values) is screened with `detectInjection` and
 *     `isCredentialSolicitation`. A hit marks the claim `needsReview` (it
 *     restricts automation); it never deletes a claim, least of all a security
 *     or payment obligation.
 *
 * Pure and isolate-safe: both screens are pure modules with no Convex context.
 */

import type { SegmentKind, SegmentedMessage } from '@owlat/shared/mailSegments';
import { detectInjection } from '../../agent/steps/security_scan/patterns';
import { isCredentialSolicitation } from '../../inbox/clarificationSlots';
import { matchQuote, type NormalizedText, type QuoteFailureReason } from './quoteMatch';

export { normalizeForQuote } from './quoteMatch';

// Structural on purpose: they name only the fields grounding reads. The
// contract's `InterpretOutput` (`./schema`) satisfies them (the run passes one
// in, `run.ts`), and so does the eval's narrower oracle output.
export interface GroundQuote {
	segmentId: string;
	text: string;
}
interface Quoted {
	quotes: readonly GroundQuote[];
}
export interface GroundableOutput {
	mode: 'brief' | 'actions';
	items: readonly (Quoted & { facets?: readonly string[] })[];
	transitions: readonly Quoted[];
	latest?: Readonly<Record<string, readonly (Quoted & { text: string })[]>>;
	facts?: readonly Quoted[];
	coverage?: { segmentsRead?: readonly string[] | number; uncertain?: boolean; overflow?: boolean };
}

/** The part of `segmentMessage`'s result grounding needs. */
export type GroundSegmentation = Pick<SegmentedMessage, 'canonicalText' | 'segments' | 'uncertain'>;

export type QuoteVerdict =
	| { ok: true; start: number; end: number }
	| { ok: false; reason: QuoteFailureReason };

/** Whether `quote` appears verbatim in the segment it names (SPEC §4). */
export function verifyQuote(
	segments: GroundSegmentation['segments'],
	canonicalText: string,
	quote: GroundQuote
): QuoteVerdict {
	const match = matchQuote(segments, canonicalText, quote);
	return match.ok
		? { ok: true, start: match.start, end: match.end }
		: { ok: false, reason: match.reason };
}

export type ClaimKind = 'item' | 'transition' | 'latest' | 'fact';

export type RejectReason =
	/** The claim carries no quote at all. */
	| 'no_quote'
	/** At least one quote is not verbatim in its segment. */
	| 'quote_failed'
	/** Every quote is valid, but none is from text that may carry this claim. */
	| 'not_fresh';

export interface GroundedEvidence {
	segmentId: string;
	segmentKind: SegmentKind;
	start: number;
	end: number;
}

export interface ScreenFlag {
	/** Where in the claim, e.g. `display.de` or `options.1`. */
	path: string;
	kind: 'injection' | 'credential';
}

export interface GroundedClaim<T> {
	claim: T;
	evidence: GroundedEvidence[];
	flags: ScreenFlag[];
	/** A screen flagged a derived string: restrict automation, show the line marked. */
	needsReview: boolean;
	/** The item rests on forwarded text that the fresh part delegated to us. */
	viaDelegation?: true;
}

export interface RejectedClaim {
	kind: ClaimKind;
	index: number;
	locale?: string;
	reason: RejectReason;
	failures?: { segmentId: string; reason: QuoteFailureReason }[];
}

export type CoverageGap =
	| 'quote_failed'
	| 'model_uncertain'
	| 'overflow'
	| 'segmentation_uncertain'
	| 'unread_segments';

export interface GroundingResult<O extends GroundableOutput> {
	items: GroundedClaim<O['items'][number]>[];
	transitions: GroundedClaim<O['transitions'][number]>[];
	/** Accepted latest-update lines per locale; absent in actions mode. */
	latest?: Record<string, GroundedClaim<NonNullable<O['latest']>[string][number]>[]>;
	facts?: GroundedClaim<NonNullable<O['facts']>[number]>[];
	rejected: RejectedClaim[];
	counts: { proposed: number; accepted: number; rejected: number; flagged: number };
	coverage: { complete: boolean; gaps: CoverageGap[] };
}

export interface GroundOptions {
	/** Screens, injectable for tests; default to the pipeline's own. */
	detectInjection?: (text: string) => { detected: boolean };
	isCredentialSolicitation?: (text: string) => boolean;
	/** Override the delegation reading of the fresh text (default: {@link delegatesForward}). */
	delegates?: boolean;
}

const DELEGATION = [
	/\b(?:can|could|would|will) you(?: please)? (?:handle|take care of|deal with|look (?:at|into)|take over|follow up|answer|reply|respond|action|sort)\b/i,
	/\bplease (?:handle|take care|deal with|take over|follow up|reply|respond|answer|action|sort)\b/i,
	/\b(?:over to you|for you to (?:handle|action|answer)|your call|can you own)\b/i,
	/\b(?:kannst|könntest|würdest) du (?:dich )?(?:(?:bitte )?(?:darum|drum) kümmern|das (?:bitte )?(?:übernehmen|erledigen|beantworten|klären))/i,
	/\bbitte (?:übernehmen|kümmer(?:e)? dich|erledigen|beantworten|klären)\b/i,
	/\b(?:übernimmst du|kümmerst du dich)\b/i,
	/\b(?:peux|pourrais)[- ]tu (?:t'en|t’en) (?:occuper|charger)/i,
	/\b(?:pouvez|pourriez)[- ]vous (?:vous en )?(?:occuper|charger|traiter|répondre)/i,
	/\bmerci de (?:t'en|t’en|vous en) (?:occuper|charger)\b/i,
];

/** Whether the sender's fresh text hands the forwarded message to us. */
export function delegatesForward(segmented: GroundSegmentation): boolean {
	return segmented.segments.some(
		(s) =>
			s.kind === 'fresh' &&
			DELEGATION.some((pattern) => pattern.test(segmented.canonicalText.slice(s.start, s.end)))
	);
}

/** Keys that hold references or quotes, not derived text. */
const NOT_DERIVED = new Set(['quotes', 'segmentId', 'matchItemId', 'matchFactId', 'itemId']);

function derivedStrings(value: unknown, path: string, out: [string, string][]): void {
	if (typeof value === 'string') {
		out.push([path, value]);
	} else if (Array.isArray(value)) {
		for (const [k, entry] of value.entries())
			derivedStrings(entry, path ? `${path}.${k}` : `${k}`, out);
	} else if (value && typeof value === 'object') {
		for (const [key, entry] of Object.entries(value)) {
			if (!NOT_DERIVED.has(key)) derivedStrings(entry, path ? `${path}.${key}` : key, out);
		}
	}
}

/** Mechanically ground `output` against the segmented message it was produced from. */
export function groundProposals<O extends GroundableOutput>(
	output: O,
	segmented: GroundSegmentation,
	options: GroundOptions = {}
): GroundingResult<O> {
	const injection = options.detectInjection ?? detectInjection;
	const credential = options.isCredentialSolicitation ?? isCredentialSolicitation;
	const delegates = options.delegates ?? delegatesForward(segmented);
	const kindOf = new Map(segmented.segments.map((s) => [s.id, s.kind]));
	const cache = new Map<string, NormalizedText>();
	const rejected: RejectedClaim[] = [];
	const gaps = new Set<CoverageGap>();
	let proposed = 0;
	let flagged = 0;

	const ground = <T extends Quoted>(
		claim: T,
		kind: ClaimKind,
		index: number,
		carries: (kinds: SegmentKind[]) => 'yes' | 'delegated' | 'no',
		locale?: string
	): GroundedClaim<T> | null => {
		proposed++;
		const reject = (reason: RejectReason, failures?: RejectedClaim['failures']) => {
			rejected.push({
				kind,
				index,
				reason,
				...(locale ? { locale } : {}),
				...(failures ? { failures } : {}),
			});
			return null;
		};
		if (claim.quotes.length === 0) return reject('no_quote');
		const evidence: GroundedEvidence[] = [];
		const failures: NonNullable<RejectedClaim['failures']> = [];
		for (const quote of claim.quotes) {
			const match = matchQuote(segmented.segments, segmented.canonicalText, quote, cache);
			if (!match.ok) failures.push({ segmentId: match.segmentId, reason: match.reason });
			else {
				const segmentKind = kindOf.get(match.segmentId) as SegmentKind;
				evidence.push({
					segmentId: match.segmentId,
					segmentKind,
					start: match.start,
					end: match.end,
				});
			}
		}
		if (failures.length > 0) {
			gaps.add('quote_failed');
			return reject('quote_failed', failures);
		}
		const carried = carries(evidence.map((e) => e.segmentKind));
		if (carried === 'no') return reject('not_fresh');
		const strings: [string, string][] = [];
		derivedStrings(claim, '', strings);
		const flags: ScreenFlag[] = [];
		for (const [path, text] of strings) {
			if (injection(text).detected) flags.push({ path, kind: 'injection' });
			if (credential(text)) flags.push({ path, kind: 'credential' });
		}
		if (flags.length > 0) flagged++;
		return {
			claim,
			evidence,
			flags,
			needsReview: flags.length > 0,
			...(carried === 'delegated' ? { viaDelegation: true as const } : {}),
		};
	};

	const itemCarrier = (kinds: SegmentKind[]) =>
		kinds.includes('fresh') ? 'yes' : delegates && kinds.includes('forwarded') ? 'delegated' : 'no';
	const freshOrForwarded = (kinds: SegmentKind[]) =>
		kinds.some((k) => k === 'fresh' || k === 'forwarded') ? 'yes' : 'no';
	const notDisclaimer = (kinds: SegmentKind[]) =>
		kinds.some((k) => k !== 'disclaimer') ? 'yes' : 'no';
	const keep = <T>(claims: (GroundedClaim<T> | null)[]) =>
		claims.filter((c): c is GroundedClaim<T> => c !== null);

	const items = keep(output.items.map((c, i) => ground(c, 'item', i, itemCarrier)));
	const transitions = keep(
		output.transitions.map((c, i) => ground(c, 'transition', i, freshOrForwarded))
	);
	let latest: GroundingResult<O>['latest'];
	if (output.latest) {
		latest = {};
		for (const [locale, lines] of Object.entries(output.latest)) {
			latest[locale] = keep(lines.map((c, i) => ground(c, 'latest', i, freshOrForwarded, locale)));
		}
	}
	const facts = output.facts
		? keep(output.facts.map((c, i) => ground(c, 'fact', i, notDisclaimer)))
		: undefined;

	const coverage = output.coverage;
	if (coverage?.uncertain) gaps.add('model_uncertain');
	if (coverage?.overflow) gaps.add('overflow');
	if (segmented.uncertain) gaps.add('segmentation_uncertain');
	if (unreadSegments(coverage?.segmentsRead, segmented)) gaps.add('unread_segments');

	return {
		items,
		transitions,
		...(latest ? { latest } : {}),
		...(facts ? { facts } : {}),
		rejected,
		counts: { proposed, accepted: proposed - rejected.length, rejected: rejected.length, flagged },
		coverage: { complete: gaps.size === 0, gaps: [...gaps] },
	};
}

/** Whether the model says it skipped a fresh or forwarded segment. */
function unreadSegments(
	read: readonly string[] | number | undefined,
	segmented: GroundSegmentation
): boolean {
	if (read === undefined) return false;
	const required = segmented.segments.filter((s) => s.kind === 'fresh' || s.kind === 'forwarded');
	if (typeof read === 'number') return read < segmented.segments.length;
	const seen = new Set(read);
	return required.some((s) => !seen.has(s.id));
}
