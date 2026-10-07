/**
 * Deterministic replay of the eval corpus (SPEC §9): the pure parts of
 * interpretation (signed scope, segmentation, grounding) run over every
 * labelled thread, with the labels themselves standing in for a perfect model
 * (the "oracle"). A label that fails to ground here is a segmentation or
 * grounding defect, not a model error. `runEval.ts` reuses the same pieces
 * with a live model.
 *
 * Pure and isolate-safe.
 */
import { mapToSource, segmentMessage, type SegmentedMessage } from '@owlat/shared/mailSegments';
import { resolveSignedBodyView } from '@owlat/shared/signedScope';
import {
	groundProposals,
	normalizeForQuote,
	verifyQuote,
	type GroundableOutput,
	type GroundingResult,
} from '../ground';
import type { EvalMessage, EvalParty, EvalThread } from './corpus';

/** One message as the model may read it: its segments, never the team's notes. */
export interface EvalModelMessage {
	messageId: string;
	direction: EvalMessage['direction'];
	from: EvalParty;
	sentAt: string;
	segments: {
		id: string;
		kind: string;
		author?: { name?: string; email?: string };
		text: string;
	}[];
}

/**
 * What a message reads as for interpretation: the clearsigned block alone when
 * the verdict is scoped to it (the reader's rule, `@owlat/shared/signedScope`;
 * a verdict with nothing signed to show leaves no text), the body otherwise.
 */
export function scopeEvalMessage(message: EvalMessage): { text?: string; html?: string } {
	if (message.signatureScope !== 'clearsigned') return { text: message.text, html: message.html };
	const view = resolveSignedBodyView({
		secureClass: 'pgp-clearsigned',
		scope: 'clearsigned',
		text: { state: 'loaded', text: message.text ?? null },
		hasOtherParts: !!message.html,
	});
	return { text: view.kind === 'signed' ? view.text : '' };
}

export function segmentEvalMessage(message: EvalMessage): SegmentedMessage {
	return segmentMessage({ ...scopeEvalMessage(message), subject: message.subject });
}

/** Messages in the order they arrived (out-of-order slice), then by send time. */
export function arrivalOrder(thread: EvalThread): EvalMessage[] {
	return [...thread.messages].sort(
		(a, b) =>
			(a.arrivalOrder ?? Number.MAX_SAFE_INTEGER) - (b.arrivalOrder ?? Number.MAX_SAFE_INTEGER) ||
			a.sentAt.localeCompare(b.sentAt)
	);
}

/** The model's view of a thread: message segments only. Internal notes never enter it. */
export function modelInputFor(thread: EvalThread): EvalModelMessage[] {
	return arrivalOrder(thread).map((message) => {
		const segmented = segmentEvalMessage(message);
		return {
			messageId: message.id,
			direction: message.direction,
			from: message.from,
			sentAt: message.sentAt,
			segments: segmented.segments.map((s) => ({
				id: s.id,
				kind: s.kind,
				...(s.author ? { author: s.author } : {}),
				text: segmented.canonicalText.slice(s.start, s.end),
			})),
		};
	});
}

/** The first segment of `kind` that holds `quote` verbatim, else the first of that kind. */
export function locateQuote(
	segmented: SegmentedMessage,
	quote: string,
	kind: string
): string | undefined {
	const candidates = segmented.segments.filter((s) => s.kind === kind);
	const hit = candidates.find(
		(s) =>
			verifyQuote(segmented.segments, segmented.canonicalText, { segmentId: s.id, text: quote }).ok
	);
	return (hit ?? candidates[0])?.id;
}

const isUs = (thread: EvalThread, party?: EvalParty) =>
	!!party && thread.us.some((u) => u.email.toLowerCase() === party.email.toLowerCase());

/** The labels of one message, written as the output a perfect model would give. */
export function oracleOutput(
	thread: EvalThread,
	message: EvalMessage,
	segmented: SegmentedMessage
): GroundableOutput {
	const quoteIn = (quote: string, kind: string) => [
		{ segmentId: locateQuote(segmented, quote, kind) ?? 'missing', text: quote },
	];
	const ref = (party?: EvalParty) => (party ? { ...party, isUs: isUs(thread, party) } : undefined);
	const ofMessage = <T extends { messageId: string }>(labels: readonly T[] = []) =>
		labels.filter((l) => l.messageId === message.id);
	const items = [
		...ofMessage(thread.labels.items).map((label) => ({
			labelId: label.id,
			intent: label.intent,
			facets: label.facets,
			assertion: label.assertion,
			display: { en: label.assertion, de: label.assertion },
			requester: ref(label.requester),
			responsible: ref(label.responsible),
			...(label.due ? { due: label.due } : {}),
			...(label.amount ? { amount: label.amount } : {}),
			quotes: quoteIn(label.quote, label.segmentKind),
		})),
		...ofMessage(thread.labels.traps).map((trap) => ({
			labelId: trap.id,
			intent: 'request',
			facets: [],
			assertion: trap.assertion,
			display: { en: trap.assertion, de: trap.assertion },
			quotes: quoteIn(trap.quote, trap.segmentKind),
		})),
	];
	const base = { items, transitions: [], coverage: { uncertain: false, overflow: false } };
	if (thread.mode === 'actions') return { mode: 'actions', ...base };
	return {
		mode: 'brief',
		...base,
		latest: { en: [], de: [] },
		facts: ofMessage(thread.labels.facts).map((fact) => ({
			labelId: fact.id,
			key: fact.key,
			assertion: fact.assertion,
			quotes: quoteIn(fact.quote, fact.segmentKind),
		})),
	};
}

export interface ReplayedMessage {
	message: EvalMessage;
	segmented: SegmentedMessage;
	output: GroundableOutput;
	grounding: GroundingResult<GroundableOutput>;
}

/** Ground one model output (or the oracle's) for every message, in arrival order. */
export async function replayThread(
	thread: EvalThread,
	produce: (
		message: EvalMessage,
		segmented: SegmentedMessage
	) => Promise<GroundableOutput> | GroundableOutput = (message, segmented) =>
		oracleOutput(thread, message, segmented)
): Promise<ReplayedMessage[]> {
	const replayed: ReplayedMessage[] = [];
	for (const message of arrivalOrder(thread)) {
		const segmented = segmentEvalMessage(message);
		const output = await produce(message, segmented);
		replayed.push({ message, segmented, output, grounding: groundProposals(output, segmented) });
	}
	return replayed;
}

/**
 * Whether an accepted evidence span maps back to the scoped body it was read
 * from: the source range exists and, for a text body, reads as the same words.
 * (An HTML range spans markup, so it is checked for existence only.)
 */
export function evidenceMapsBack(
	segmented: SegmentedMessage,
	scoped: { text?: string; html?: string },
	start: number,
	end: number
): boolean {
	const range = mapToSource(segmented.sourceMap, start, end);
	if (!range) return false;
	if (segmented.sourceMap.source === 'html') return range.end > range.start;
	const strip = (s: string) => normalizeForQuote(s.replace(/^[ \t]*(?:>[ \t]?)+/gm, ''));
	const source = scoped.text ?? '';
	return (
		strip(source.slice(range.start, range.end)) === strip(segmented.canonicalText.slice(start, end))
	);
}
