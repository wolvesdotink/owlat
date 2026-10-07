/**
 * Whether the sender's fresh text hands a forwarded message to us (plan §11:
 * "can you handle the below?"). Grounding (`./ground.ts`) lets an item rest on
 * forwarded text only when the reading for that forwarded segment is
 * `delegated`; otherwise forwarded asks stay context.
 *
 * Each forwarded segment is read against the fresh text that introduces it:
 * the fresh segments since the previous forward. A forward nested in another
 * one (no fresh text of its own) inherits the outer forward's reading.
 *
 * The fresh text delegates only when a handover phrase points at the forward
 * ("handle this", "take care of the below", "kümmer dich darum", "t'en
 * occuper") and nothing marks it as information ("FYI", "no action needed",
 * "zur Info", "pour info"). A handover verb aimed at something else ("handle
 * the meeting"), or a handover beside an information marker, is `ambiguous`:
 * grounding rejects the item and calls coverage incomplete. A negated handover
 * ("no need to handle this") reads as `none`.
 *
 * Pure and isolate-safe.
 */
import type { SegmentedMessage } from '@owlat/shared/mailSegments';

export type DelegationReading = 'delegated' | 'ambiguous' | 'none';

export interface Delegation {
	reading: DelegationReading;
	/** The fresh handover phrase, as canonical offsets (for `delegated`). */
	evidence?: { segmentId: string; start: number; end: number };
}

const DEICTIC =
	'(?:this(?: one)?|it|that|these|them|the (?:below|following|(?:e-?mail|message|mail|thread) below|forwarded (?:e-?mail|message|mail))|below)';
const HANDOVER = [
	new RegExp(
		`\\b(?:handle|take care of|deal with|look (?:at|into)|take over|action|sort out|follow up on|reply to|respond to|answer|own)\\s+${DEICTIC}\\b`,
		'i'
	),
	/\b(?:can|could|would|will) you(?: please)? (?:handle|take care of|take over|sort|action)\s*(?:[?.!]|$)/i,
	/\bplease (?:handle|take over|action)\s*(?:[?.!]|$)/i,
	/\b(?:over to you|for you to (?:handle|action|answer))\b/i,
	/\b(?:kannst|könntest|würdest) du (?:dich )?(?:bitte )?(?:darum|drum) kümmern/i,
	/\b(?:kannst|könntest|würdest) du (?:das|dies) (?:bitte )?(?:übernehmen|erledigen|beantworten|klären)/i,
	/\bkümmer(?:e|st)? (?:du )?dich (?:bitte )?(?:darum|drum)\b/i,
	/\b(?:bitte (?:übernehmen|erledigen)|übernimmst du das)\b/i,
	/\b(?:peux|pourrais)[- ]tu (?:t'en|t’en) (?:occuper|charger)/i,
	/\b(?:pouvez|pourriez)[- ]vous vous en (?:occuper|charger)/i,
	/\bmerci de (?:t'en|t’en|vous en) (?:occuper|charger)\b/i,
];
/** A handover verb, whatever it points at. */
const HANDOVER_VERB =
	/\b(?:handle|take care|deal with|look into|take over|follow up|kümmern|übernehmen|erledigen|occuper|charger|traiter)\b/i;
const INFORMATIONAL =
	/\b(?:fyi|for your information|for info|no action (?:is )?(?:needed|required)|nothing (?:to do|needed)|just so you know|for reference|for your records|zur (?:info|kenntnis)|nur zur info|zu deiner info|kein handlungsbedarf|keine aktion (?:nötig|erforderlich)|pour info(?:rmation)?|à titre d'information|aucune action)\b/i;
const NEGATED =
	/\b(?:no need to|don't|do not|needn't|need not|nicht|kein(?:e|en)?|pas besoin de|ne pas)\b[^.,;?!\n]{0,30}\b(?:handle|take care|deal with|action|reply|respond|answer|kümmern|übernehmen|erledigen|beantworten|occuper|charger|répondre)/i;

function readFresh(text: string): {
	reading: DelegationReading;
	match?: { index: number; length: number };
} {
	if (NEGATED.test(text)) return { reading: 'none' };
	let match: RegExpExecArray | null = null;
	for (const pattern of HANDOVER) {
		match = pattern.exec(text);
		if (match) break;
	}
	const informational = INFORMATIONAL.test(text);
	if (match && !informational) {
		return { reading: 'delegated', match: { index: match.index, length: match[0].length } };
	}
	if (match || HANDOVER_VERB.test(text)) return { reading: 'ambiguous' };
	return { reading: 'none' };
}

/** The delegation reading of every forwarded segment, by segment id. */
export function forwardDelegation(
	segmented: Pick<SegmentedMessage, 'canonicalText' | 'segments'>
): Map<string, Delegation> {
	const readings = new Map<string, Delegation>();
	let fresh: { id: string; start: number; end: number }[] = [];
	let inherited: Delegation = { reading: 'none' };
	for (const segment of segmented.segments) {
		if (segment.kind === 'fresh') {
			fresh.push(segment);
			continue;
		}
		if (segment.kind !== 'forwarded') continue;
		if (fresh.length > 0) {
			inherited = { reading: 'none' };
			const texts = fresh.map((s) => segmented.canonicalText.slice(s.start, s.end));
			const whole = readFresh(texts.join('\n'));
			if (whole.reading !== 'delegated') {
				inherited = { reading: whole.reading };
			} else {
				// Locate the phrase in the segment that holds it, for the evidence.
				for (const [k, s] of fresh.entries()) {
					const own = readFresh(texts[k] as string);
					if (own.reading === 'delegated' && own.match) {
						const start = s.start + own.match.index;
						inherited = {
							reading: 'delegated',
							evidence: { segmentId: s.id, start, end: start + own.match.length },
						};
						break;
					}
				}
				// The phrase spans segments: delegated, without a single span to cite.
				if (inherited.reading !== 'delegated') inherited = { reading: 'delegated' };
			}
			fresh = [];
		}
		readings.set(segment.id, inherited);
	}
	return readings;
}

/** Whether the fresh text hands any forwarded segment to us. */
export function delegatesForward(
	segmented: Pick<SegmentedMessage, 'canonicalText' | 'segments'>
): boolean {
	return [...forwardDelegation(segmented).values()].some((d) => d.reading === 'delegated');
}
