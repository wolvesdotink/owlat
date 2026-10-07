/**
 * The pure core of an interpretation run (SPEC §4): everything between the
 * load and the reducer that needs no Convex context and no model, so the run
 * (`run.ts`), the verifier (`verify.ts`) and the eval (`__eval__/runEval.ts`)
 * share it.
 *
 *   buildInterpretInput   load + segmentation → the prompt input
 *   clampOutput           bound every model string (INTERPRET_TEXT_LIMITS)
 *   verifyClaimsOf        which grounded claims the verifier must check
 *   toReduceResult        grounded + verified proposals → the reducer input
 *   runStatusOf           complete / partial, and why
 *
 * Isolate-safe.
 */

import type { SegmentedMessage } from '@owlat/shared/mailSegments';
import { normalizeEmail } from '@owlat/shared';
import type { AppLocale } from '@owlat/shared/appLocales';
import { factKeyString, type InterpretMode } from '@owlat/shared/threadBrief';
import { isConsequential } from '@owlat/shared/threadBriefRules';
import type { ParticipantRef } from '../../lib/validators/threadBrief';
import type { GroundedClaim, GroundingResult } from './ground';
import { quoteOccurrence } from './quoteMatch';
import {
	INTERPRET_TEXT_LIMITS,
	type InterpretFactProposal,
	type InterpretInput,
	type InterpretInputFact,
	type InterpretInputItem,
	type InterpretInputParticipant,
	type InterpretItemProposal,
	type InterpretOutput,
	type InterpretParticipantProposal,
	type InterpretTransitionProposal,
} from './schema';
import type { ReduceEvidence, ReduceFact, ReduceItem, ReduceResult } from './reduceInput';
import { resolveDue } from './dueDate';

// ── Input ──────────────────────────────────────────────────────────────────

export function buildInterpretInput(args: {
	mode: InterpretMode;
	segmented: Pick<SegmentedMessage, 'canonicalText' | 'segments'>;
	sentAt: number;
	timezone: string;
	contentRevision: string;
	participants: InterpretInputParticipant[];
	openItems: InterpretInputItem[];
	isItemsOverflow: boolean;
	currentFacts: InterpretInputFact[];
	isFactsOverflow: boolean;
	locales: AppLocale[];
}): InterpretInput {
	return {
		mode: args.mode,
		message: {
			segments: args.segmented.segments.map((s) => ({
				id: s.id,
				kind: s.kind,
				...(s.author ? { author: s.author } : {}),
				text: args.segmented.canonicalText.slice(s.start, s.end),
			})),
			sentAt: args.sentAt,
			timezone: args.timezone,
			sourceRevision: args.contentRevision,
		},
		participants: args.participants,
		openItems: args.openItems,
		itemsOverflow: args.isItemsOverflow,
		currentFacts: args.mode === 'brief' ? args.currentFacts : [],
		factsOverflow: args.mode === 'brief' && args.isFactsOverflow,
		locales: args.locales,
	};
}

// ── Clamping ───────────────────────────────────────────────────────────────

/** Strip control characters, collapse whitespace, cut at a word. */
export function clampText(value: string, max: number): string {
	const flat = value
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (flat.length <= max) return flat;
	const cut = flat.slice(0, max - 1);
	return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 1))}…`;
}

const L = INTERPRET_TEXT_LIMITS;

function clampDisplay(display: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(display).map(([k, val]) => [k, clampText(val, L.display)])
	);
}

function clampParticipant(p: InterpretParticipantProposal): InterpretParticipantProposal {
	return {
		ref: p.ref,
		name: p.name === null ? null : clampText(p.name, L.participantName),
		email: p.email === null ? null : p.email.trim().slice(0, 254),
	};
}

/** Bound every derived string of the model output. Quotes stay verbatim (grounding needs them). */
export function clampOutput<O extends InterpretOutput>(output: O): O {
	const items = output.items.map((item) => ({
		...item,
		assertion: clampText(item.assertion, L.assertion),
		display: clampDisplay(item.display) as InterpretItemProposal['display'],
		requester: clampParticipant(item.requester),
		responsible: clampParticipant(item.responsible),
		beneficiary: item.beneficiary ? clampParticipant(item.beneficiary) : null,
		due: item.due
			? {
					...item.due,
					phrase: clampText(item.due.phrase, L.duePhrase),
					condition: item.due.condition ? clampText(item.due.condition, L.duePhrase) : null,
				}
			: null,
		options: item.options ? item.options.map((o) => clampText(o, L.option)) : null,
	}));
	if (output.mode === 'actions') return { ...output, items };
	return {
		...output,
		items,
		latest: Object.fromEntries(
			Object.entries(output.latest).map(([locale, lines]) => [
				locale,
				lines.map((line) => ({ ...line, text: clampText(line.text, L.latestLine) })),
			])
		) as typeof output.latest,
		facts: output.facts.map((fact) => ({
			...fact,
			key: {
				entity: clampText(fact.key.entity, L.factKeyPart),
				attribute: clampText(fact.key.attribute, L.factKeyPart),
				context: fact.key.context ? clampText(fact.key.context, L.factKeyPart) : null,
			},
			assertion: clampText(fact.assertion, L.assertion),
			display: clampDisplay(fact.display) as InterpretFactProposal['display'],
			value:
				fact.value && 'text' in fact.value
					? { ...fact.value, text: clampText(fact.value.text, L.factValueText) }
					: fact.value,
			reportedBy: clampParticipant(fact.reportedBy),
		})),
	} as O;
}

// ── Participants and dates ─────────────────────────────────────────────────

/** A model participant proposal as a stored reference. Pure. */
export function resolveParticipant(
	proposal: InterpretParticipantProposal | null | undefined,
	participants: readonly InterpretInputParticipant[],
	ownAddresses: ReadonlySet<string>
): ParticipantRef {
	if (!proposal) return { isUs: false };
	const listed = proposal.ref ? participants.find((p) => p.ref === proposal.ref) : undefined;
	if (listed) {
		return {
			...(listed.email ? { email: listed.email } : {}),
			...(listed.name ? { name: listed.name } : {}),
			isUs: listed.isUs,
		};
	}
	const email =
		proposal.email && proposal.email.includes('@') ? normalizeEmail(proposal.email) : undefined;
	return {
		...(email ? { email } : {}),
		...(proposal.name ? { name: proposal.name } : {}),
		isUs: !!email && ownAddresses.has(email),
	};
}

/** Epoch ms of an ISO 8601 date or date-time, or undefined. Pure. */
export function parseIsoMs(iso: string | null | undefined): number | undefined {
	if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso.trim())) return undefined;
	const ms = Date.parse(iso.trim());
	return Number.isFinite(ms) ? ms : undefined;
}

// ── Verification ───────────────────────────────────────────────────────────

/** One claim the verifier checks against its quotes. */
export interface VerifyClaim {
	/** `item:<i>`, `transition:<i>` or `fact:<i>` (index into the grounded lists). */
	id: string;
	statement: string;
	quotes: string[];
}

export type VerifyVerdict = 'supported' | 'unsupported' | 'unclear';

function quotesOf(claim: GroundedClaim<unknown>, canonicalText: string): string[] {
	return claim.evidence.map((e) => canonicalText.slice(e.start, e.end));
}

function partyLabel(party: { email?: string; name?: string; isUs: boolean }): string {
	if (party.isUs) return 'the reader';
	return party.name ?? party.email ?? 'an unclear person';
}

/**
 * The claims SPEC §4 sends to the verifier: consequential items and items the
 * reader owns (ownership, deadlines), closing transitions, and fact
 * supersessions. Pure.
 */
export function verifyClaimsOf(
	grounding: Pick<GroundingResult<InterpretOutput>, 'items' | 'transitions' | 'facts'>,
	canonicalText: string,
	context: {
		participants: readonly InterpretInputParticipant[];
		/** The mailbox's (or inbox's) own addresses: the same "us" the reducer stores. */
		ownAddresses: ReadonlySet<string>;
		itemText: (itemId: string) => string | undefined;
		factText: (factId: string) => string | undefined;
	}
): VerifyClaim[] {
	const claims: VerifyClaim[] = [];
	for (const [i, g] of grounding.items.entries()) {
		const item = g.claim as InterpretItemProposal;
		// One resolver for ownership here and in storage (toReduceResult).
		const responsible = resolveParticipant(item.responsible, context.participants, context.ownAddresses);
		if (!isConsequential(item) && !responsible.isUs) continue;
		const due = item.due ? ` by ${item.due.phrase}` : '';
		const amount = item.amount ? ` (${item.amount.value} ${item.amount.currency})` : '';
		claims.push({
			id: `item:${i}`,
			statement:
				`${partyLabel(responsible)} is asked or committed to: ` +
				`${item.assertion}${amount}${due}`,
			quotes: quotesOf(g, canonicalText),
		});
	}
	for (const [i, g] of grounding.transitions.entries()) {
		const t = g.claim as InterpretTransitionProposal;
		if (!t.to || !['done', 'declined', 'superseded'].includes(t.to)) continue;
		const text = context.itemText(t.itemId);
		if (!text) continue;
		const verb =
			t.to === 'done'
				? 'has been done'
				: t.to === 'declined'
					? 'has been declined'
					: 'has been replaced by something else';
		claims.push({
			id: `transition:${i}`,
			statement: `"${text}" ${verb}.`,
			quotes: quotesOf(g, canonicalText),
		});
	}
	for (const [i, g] of (grounding.facts ?? []).entries()) {
		const f = g.claim as InterpretFactProposal;
		if (!f.supersedes) continue;
		const old = context.factText(f.supersedes);
		if (!old) continue;
		claims.push({
			id: `fact:${i}`,
			statement: `"${f.assertion}" replaces the earlier "${old}".`,
			quotes: quotesOf(g, canonicalText),
		});
	}
	return claims;
}

// ── Reducer input ──────────────────────────────────────────────────────────

function evidenceOf(claim: GroundedClaim<unknown>, canonicalText: string): ReduceEvidence[] {
	return claim.evidence.map((e) => ({
		segmentId: e.segmentId,
		start: e.start,
		end: e.end,
		quote: canonicalText.slice(e.start, e.end),
		occurrence: quoteOccurrence(canonicalText, e.start, e.end),
	}));
}

export interface ToReduceOptions {
	mode: InterpretMode;
	canonicalText: string;
	participants: readonly InterpretInputParticipant[];
	ownAddresses: ReadonlySet<string>;
	timezone: string;
	/** The message date: deadlines resolve relative to it (dueDate.ts). */
	sentAt: number;
	/** Verifier verdicts by claim id; a claim absent here was not checked. */
	verdicts: ReadonlyMap<string, VerifyVerdict>;
	/** Claim ids that were sent to the verifier. */
	checked: ReadonlySet<string>;
	latestSuppressed?: 'short' | 'security';
}

/** Grounded + verified proposals → the reducer input. Pure. */
export function toReduceResult(
	output: InterpretOutput,
	grounding: GroundingResult<InterpretOutput>,
	opts: ToReduceOptions
): ReduceResult {
	let verifyDropped = 0;
	const party = (p: InterpretParticipantProposal | null | undefined) =>
		resolveParticipant(p, opts.participants, opts.ownAddresses);

	const items: ReduceItem[] = [];
	for (const [i, g] of grounding.items.entries()) {
		const p = g.claim as InterpretItemProposal;
		const id = `item:${i}`;
		const verdict = opts.verdicts.get(id);
		if (verdict === 'unsupported') {
			verifyDropped++;
			continue;
		}
		// The deadline is read from its phrase, never taken from the model's timestamp.
		const due = p.due ? resolveDue(p.due.phrase, opts.sentAt, opts.timezone) : undefined;
		items.push({
			...(p.matchItemId ? { matchItemId: p.matchItemId } : {}),
			intent: p.intent,
			facets: [...new Set(p.facets)],
			...(p.consequences ? { consequences: [...new Set(p.consequences)] } : {}),
			assertion: p.assertion,
			display: { en: p.display.en, de: p.display.de },
			requester: party(p.requester),
			responsible: party(p.responsible),
			...(p.beneficiary ? { beneficiary: party(p.beneficiary) } : {}),
			...(p.due
				? {
						due: {
							phrase: p.due.phrase,
							...(due?.at !== undefined ? { at: due.at, tz: opts.timezone } : {}),
							isAmbiguous: due?.isAmbiguous ?? true,
							...(p.due.condition ? { condition: p.due.condition } : {}),
						},
					}
				: {}),
			...(p.amount && Number.isFinite(p.amount.value)
				? {
						amount: {
							value: p.amount.value,
							currency: p.amount.currency.toUpperCase().slice(0, 3),
						},
					}
				: {}),
			...(p.options && p.options.length > 0 ? { options: p.options } : {}),
			evidence: evidenceOf(g, opts.canonicalText),
			// Grounding keeps forwarded-only and signature/disclaimer-only items as
			// proposals: no verdict upgrades them (ground.ts).
			verify: g.proposal
				? 'proposal'
				: !opts.checked.has(id)
					? 'na'
					: verdict === 'supported'
						? 'passed'
						: 'proposal',
			isReviewNeeded: g.needsReview,
		});
	}

	const transitions = grounding.transitions.map((g, i) => {
		const t = g.claim as InterpretTransitionProposal;
		const id = `transition:${i}`;
		if (opts.checked.has(id) && opts.verdicts.get(id) !== 'supported') verifyDropped++;
		return {
			itemId: t.itemId,
			...(t.to ? { to: t.to } : {}),
			...(t.disposition ? { disposition: t.disposition } : {}),
			evidence: evidenceOf(g, opts.canonicalText),
			// A transition resting only on forwarded text never counts as verified,
			// so it cannot close an item (ground.ts).
			isVerified: !g.proposal && opts.verdicts.get(id) === 'supported',
			isReviewNeeded: g.needsReview,
		};
	});

	const result: ReduceResult = {
		items,
		transitions,
		replyIntent: output.replyIntent,
		urgency: output.urgency,
		...(output.meetingIntent
			? {
					meetingIntent: {
						isScheduling: output.meetingIntent.isScheduling,
						proposedTimes: output.meetingIntent.proposedTimes,
						...(output.meetingIntent.topic ? { topic: output.meetingIntent.topic } : {}),
					},
				}
			: {}),
		dropped: { grounding: grounding.rejected.length, verify: 0 },
	};

	if (opts.mode === 'brief' && output.mode === 'brief') {
		if (output.exactWording?.isRequired) {
			const reason = output.exactWording.reason;
			result.exactWording = reason ? { reason } : {};
		}
		if (opts.latestSuppressed) {
			result.latestSuppressed = opts.latestSuppressed;
		} else {
			const lines = (locale: 'en' | 'de') =>
				(grounding.latest?.[locale] ?? []).map((g) => ({
					text: (g.claim as { text: string }).text,
					evidence: evidenceOf(g, opts.canonicalText),
					isReviewNeeded: g.needsReview,
				}));
			result.latest = { en: lines('en'), de: lines('de') };
		}
		const facts: ReduceFact[] = [];
		for (const [i, g] of (grounding.facts ?? []).entries()) {
			const f = g.claim as InterpretFactProposal;
			const id = `fact:${i}`;
			const value = factValueOf(f.value);
			facts.push({
				...(f.matchFactId ? { matchFactId: f.matchFactId } : {}),
				key: factKeyString({
					entity: f.key.entity,
					attribute: f.key.attribute,
					context: f.key.context,
				}),
				assertion: f.assertion,
				display: { en: f.display.en, de: f.display.de },
				...(value ? { value } : {}),
				evidence: evidenceOf(g, opts.canonicalText),
				...(f.supersedes ? { supersedes: f.supersedes } : {}),
				...(f.conflictsWith ? { conflictsWith: f.conflictsWith } : {}),
				isVerified: opts.verdicts.get(id) === 'supported',
				isReviewNeeded: g.needsReview,
			});
		}
		result.facts = facts;
	}
	result.dropped.verify = verifyDropped;
	return result;
}

function factValueOf(value: InterpretFactProposal['value']): ReduceFact['value'] {
	if (!value) return undefined;
	if (value.kind === 'date') {
		const at = parseIsoMs(value.at);
		return at === undefined ? undefined : { kind: 'date', at };
	}
	if (value.kind === 'money') {
		return Number.isFinite(value.value)
			? { kind: 'money', value: value.value, currency: value.currency.toUpperCase().slice(0, 3) }
			: undefined;
	}
	return value.text.trim() ? { kind: value.kind, text: value.text } : undefined;
}

// ── Status ─────────────────────────────────────────────────────────────────

/**
 * Whether the run read everything it should have: `partial` when grounding
 * found a gap, the model or the prompt overflowed, a segment was cut, a
 * verification call failed, or only part of the body could be read. Pure.
 */
export function runStatusOf(input: {
	grounding: Pick<GroundingResult<InterpretOutput>, 'coverage'>;
	output: Pick<InterpretOutput, 'coverage'>;
	isItemsOverflow: boolean;
	isFactsOverflow: boolean;
	truncatedSegmentIds: readonly string[];
	isVerifyIncomplete: boolean;
	/** Scoping could not load the whole body (an excerpt stood in). */
	isBodyIncomplete?: boolean;
}): { status: 'complete' | 'partial'; errorCode?: string } {
	if (input.isBodyIncomplete) return { status: 'partial', errorCode: 'body_unavailable' };
	if (
		input.output.coverage.overflow ||
		input.isItemsOverflow ||
		input.isFactsOverflow ||
		input.truncatedSegmentIds.length > 0 ||
		input.grounding.coverage.gaps.includes('overflow')
	) {
		return { status: 'partial', errorCode: 'overflow' };
	}
	if (!input.grounding.coverage.complete) return { status: 'partial', errorCode: 'grounding' };
	if (input.isVerifyIncomplete) return { status: 'partial', errorCode: 'verify' };
	return { status: 'complete' };
}
