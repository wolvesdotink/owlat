/**
 * Whether the sender's fresh text hands a forwarded message to us (plan §11:
 * "can you handle the below?"). Context only: grounding (`./ground.ts`) keeps
 * every item that rests only on forwarded text as a proposal ("Check this")
 * whatever this says, and uses a `delegated` reading to say why it is shown
 * ("Mara asked you to handle this"). It never authorizes tracking.
 *
 * Each forwarded segment is read against the fresh text that introduces it:
 * the fresh segments since the previous forward. A forward nested in another
 * one (no fresh text of its own) inherits the outer forward's reading.
 *
 * Only positive evidence reads `delegated`. The fresh text delegates when one of its
 * clauses is a request to the recipient (`can you`, `please`, `kannst du`,
 * `bitte`, `peux-tu`, an imperative) whose handover points at the forward
 * ("handle the below", "take care of this one", "kümmer dich darum", "t'en
 * occuper"), with no negation in that clause, no other clause handing the same
 * object over in a way that is not such a request ("I will handle this",
 * "Jonas will handle this", "don't handle this"), and no information marker
 * ("FYI", "no action needed", "zur Info", "pour info"). Anything else that
 * talks about handling (a handover verb aimed elsewhere, someone else handling
 * it, a negated or contradicted handover) is `ambiguous`. Only text with no handover language
 * at all reads `none`. Negation binds to its own clause, so "Can you handle
 * the below? Do not reply to the other thread." still delegates.
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

/** English handover verbs in every form ("handles", "took care of", "dealing with"). */
const EN_VERB =
	'(?:handl(?:e|es|ed|ing)|(?:tak(?:e|es|ing)|took) care of|deal(?:s|t|ing)? with|look(?:s|ed|ing)? (?:at|into)|(?:tak(?:e|es|ing)|took) over|sort(?:s|ed|ing)? out|follow(?:s|ed|ing)? up on|repl(?:y|ies|ied|ying) to|respond(?:s|ed|ing)? to|answer(?:s|ed|ing)?|own(?:s|ed|ing)?|action(?:s|ed|ing)?)';
const DEICTIC =
	'(?:this(?: one)?|it|that|these|them|the (?:below|following|(?:e-?mail|message|mail|thread) below|forwarded (?:e-?mail|message|mail))|below)';
/** A handover whose object is the forward, whoever is asked. */
const HANDOVER = [
	new RegExp(`\\b${EN_VERB}\\s+${DEICTIC}\\b`, 'i'),
	/\b(?:handl(?:e|es|ed|ing)|(?:tak(?:e|es|ing)|took) over|action|sort)\s*[?.!]*\s*$/i,
	/\b(?:over to you|for you to (?:handle|action|answer))\b/i,
	/\b(?:darum|drum) kümmern\b/i,
	/\bkümmer(?:e|st)? (?:du )?dich (?:bitte )?(?:darum|drum)\b/i,
	/\b(?:das|dies) (?:bitte )?(?:übernehmen|erledigen|beantworten|klären)\b/i,
	/\b(?:bitte (?:übernehmen|erledigen)|übernimm(?:st du)? das|erledige das)\b/i,
	/(?:\bt'en|\bt’en|\bvous en|\bs'en|\bs’en) (?:occuper|charger)\b/i,
	/\b(?:occupe|occupez)[- ](?:toi|vous)[- ]en\b|\boccupe-t[’']en\b/i,
];
/** English handover verbs in the base form a request uses. */
const EN_BASE =
	'(?:handle|take care of|deal with|look (?:at|into)|take over|action|sort out|follow up on|reply to|respond to|answer|own)';
/**
 * A request to the recipient whose verb IS the handover: "can you handle the
 * below", "please take care of this one", "Handle this please", "kannst du
 * dich darum kümmern", "peux-tu t'en occuper". The verb must follow the
 * request opener directly, so "Please note that I will handle this" or "Can you
 * confirm that Jonas will handle this?" or "Could you avoid handling this?" are
 * not requests to hand anything over.
 */
const DIRECTED_HANDOVER = [
	new RegExp(`^(?:(?:please|kindly)\\s+)?${EN_BASE}\\s+${DEICTIC}\\b`, 'i'),
	new RegExp(
		`\\b(?:can|could|would|will) you(?: please| kindly)?\\s+${EN_BASE}\\s+${DEICTIC}\\b`,
		'i'
	),
	new RegExp(`\\b(?:please|kindly)\\s+${EN_BASE}\\s+${DEICTIC}\\b`, 'i'),
	/\b(?:can|could|would|will) you(?: please)?\s+(?:handle|take over|action|sort)\s*[?.!]*\s*$/i,
	/^(?:please\s+)?(?:handle|take over)(?:,?\s+please)?\s*[?.!]*\s*$/i,
	/\b(?:over to you|for you to (?:handle|action|answer))\b/i,
	/\b(?:kannst|könntest|würdest) du (?:dich )?(?:bitte )?(?:darum|drum) kümmern\b/i,
	/\b(?:kannst|könntest|würdest) du (?:das|dies) (?:bitte )?(?:übernehmen|erledigen|beantworten|klären)\b/i,
	/\b(?:können|könnten|würden) Sie sich (?:bitte )?(?:darum|drum) kümmern\b/,
	/^(?:bitte\s+)?kümmer(?:e)? dich (?:bitte )?(?:darum|drum)\b/i,
	/^bitte (?:übernehmen|erledigen)\b/i,
	/^(?:bitte\s+)?(?:übernimm|erledige) (?:das|dies)\b/i,
	/\b(?:übernimmst du das|kümmerst du dich (?:darum|drum))\b/i,
	/\b(?:peux|pourrais)[- ]tu t['’]en (?:occuper|charger)\b/i,
	/\b(?:pouvez|pourriez)[- ]vous vous en (?:occuper|charger)\b/i,
	/\bmerci de (?:t['’]en|vous en) (?:occuper|charger)\b/i,
	/^(?:occupe-t['’]en|occupe-toi en|occupez-vous en|charge-t['’]en)\b/i,
];
const NEGATION =
	/(?:\bnot\b|n['’]t\b|\bnever\b|\bno need\b|\bnicht\b|\bkein\w*|\bnie\b|\bpas\b|\bjamais\b|\bne\s|\bn['’](?=\p{L}))/iu;
/** A handover verb, whatever it points at and whoever does it. */
// Not `answer`, `own` or `action`: as nouns they say nothing about handing over.
const HANDOVER_VERB = new RegExp(
	`\\b(?:handl(?:e|es|ed|ing)|(?:tak(?:e|es|ing)|took) (?:care of|over)|deal(?:s|t|ing)? with|look(?:s|ed|ing)? into|sort(?:s|ed|ing)? out|follow(?:s|ed|ing)? up|repl(?:y|ies|ied|ying) to|respond(?:s|ed|ing)? to|kümmer(?:n|e|t|st)?|übernehmen|übernimm(?:st|t)?|erledig(?:en|e|st|t)?|occuper|occupe|occupez|charger|chargez|traiter|traitez)\\b`,
	'i'
);
const INFORMATIONAL =
	/\b(?:fyi|for your information|for info|no action (?:is )?(?:needed|required)|nothing (?:to do|needed)|just so you know|for reference|for your records|zur (?:info|kenntnis)|nur zur info|zu deiner info|kein handlungsbedarf|keine aktion (?:nötig|erforderlich)|pour info(?:rmation)?|à titre d'information|aucune action)\b/i;
/** A clause: up to its own punctuation. */
const CLAUSE = /[^.?!;,\n]+[.?!]*/g;

function readFresh(text: string): {
	reading: DelegationReading;
	match?: { index: number; length: number };
} {
	let positive: { index: number; length: number } | undefined;
	let contradicted = false;
	for (const clause of text.matchAll(CLAUSE)) {
		const body = clause[0];
		let handover: RegExpExecArray | null = null;
		for (const pattern of HANDOVER) {
			handover = pattern.exec(body);
			if (handover) break;
		}
		if (!handover) continue;
		const trimmed = body.trimStart();
		const directed = DIRECTED_HANDOVER.some((pattern) => pattern.test(trimmed));
		if (directed && !NEGATION.test(body)) {
			positive ??= { index: clause.index + handover.index, length: handover[0].length };
		} else {
			// Someone else handles it, it is negated, or the handover is not what
			// the recipient is asked to do: the forward's status is unclear.
			contradicted = true;
		}
	}
	if (positive && !contradicted && !INFORMATIONAL.test(text)) {
		return { reading: 'delegated', match: positive };
	}
	if (positive || contradicted || HANDOVER_VERB.test(text)) return { reading: 'ambiguous' };
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
