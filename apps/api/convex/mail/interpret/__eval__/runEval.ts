/**
 * The interpretation eval run (SPEC §9, plan §14): replays the corpus through
 * scope, segmentation and grounding, with a model when one is supplied and the
 * labels themselves (the oracle) otherwise, and scores the result:
 *   - recall: labelled obligations an accepted item covers (quote spans overlap);
 *   - precision: accepted items that cover a labelled obligation;
 *   - ownership: matched items whose responsibility (us / them / unclear)
 *     agrees with the label;
 *   - evidence validity: accepted evidence spans that map back to the body;
 *   - unsupported rate: proposed claims rejected for a missing or failed quote;
 *   - cost: what the model reported spending.
 * Plus per-slice recall, the worst slice, every missed obligation, traps that
 * grounded, expected screen flags that did not fire, and any internal note
 * that reached the model input.
 *
 * The live model is `./liveModel.ts` (the run's pure core around an injected
 * model call). The CLI is `apps/api/scripts/interpret-eval.ts`. Pure and
 * isolate-safe.
 */
import { verifyQuote, type GroundableOutput, type GroundedClaim } from '../ground';
import { EVAL_SLICES, type EvalSlice, type EvalThread } from './corpus';
import {
	evidenceMapsBack,
	locateQuote,
	replayThread,
	scopeEvalMessage,
	type EvalModelInput,
} from './replay';

export interface EvalModel {
	name: string;
	/** Interpret one message from its sanitized input (see `EvalModelInput`). */
	interpret(input: EvalModelInput): Promise<{ output: GroundableOutput; costUsd?: number }>;
}

export interface EvalReport {
	model: string;
	threads: number;
	messages: number;
	skippedIneligible: number;
	labelledItems: number;
	recall: number;
	precision: number;
	ownership: number;
	evidenceValidity: number;
	unsupportedRate: number;
	costUsd: number;
	incompleteMessages: number;
	perSlice: Partial<Record<EvalSlice, { items: number; recall: number }>>;
	worstSlice: { slice: EvalSlice; recall: number } | null;
	missed: { threadId: string; labelId: string }[];
	/** Accepted claims kept as proposals ("Check this"). */
	proposals: number;
	/** Traps that grounded as TRACKED obligations (a proposal is fine). */
	trapsAccepted: { threadId: string; labelId: string }[];
	flagsMissed: { threadId: string; labelId: string }[];
	notesLeaked: { threadId: string; noteId: string }[];
}

type Claim = GroundedClaim<{ labelId?: string; responsible?: { isUs?: boolean } }>;

const ratio = (hit: number, total: number) => (total === 0 ? 1 : hit / total);
const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) =>
	a.start < b.end && b.start < a.end;

function responsibilityOf(claim: Claim['claim']): 'us' | 'them' | 'unclear' {
	if (!claim.responsible) return 'unclear';
	return claim.responsible.isUs ? 'us' : 'them';
}

/** Run the eval. Without a model the labels stand in for one (deterministic replay). */
export async function runEval(
	corpus: readonly EvalThread[],
	model?: EvalModel
): Promise<EvalReport> {
	const trapIds = new Set(
		corpus.flatMap((t) => (t.labels.traps ?? []).map((l) => `${t.id}/${l.id}`))
	);
	const sliceHits = new Map<EvalSlice, { items: number; hit: number }>();
	const report: EvalReport = {
		model: model?.name ?? 'oracle',
		threads: corpus.length,
		messages: 0,
		skippedIneligible: 0,
		labelledItems: 0,
		recall: 0,
		precision: 0,
		ownership: 0,
		evidenceValidity: 0,
		unsupportedRate: 0,
		costUsd: 0,
		incompleteMessages: 0,
		perSlice: {},
		worstSlice: null,
		missed: [],
		proposals: 0,
		trapsAccepted: [],
		flagsMissed: [],
		notesLeaked: [],
	};
	let found = 0;
	let accepted = 0;
	let acceptedMatched = 0;
	let owned = 0;
	let evidenceTotal = 0;
	let evidenceValid = 0;
	let proposed = 0;
	let unsupported = 0;

	for (const thread of corpus) {
		if (thread.expectIneligible) {
			report.skippedIneligible++;
			continue;
		}
		const replayed = await replayThread(
			thread,
			model
				? async (input) => {
						const result = await model.interpret(input);
						report.costUsd += result.costUsd ?? 0;
						return result.output;
					}
				: undefined
		);
		// The leak check reads exactly what an adapter received (or would have).
		const leaked = new Set<string>();
		for (const { input } of replayed) {
			const seen = JSON.stringify(input);
			for (const note of thread.internalNotes ?? []) {
				if (seen.includes(note.text)) leaked.add(note.id);
			}
		}
		for (const noteId of leaked) report.notesLeaked.push({ threadId: thread.id, noteId });
		for (const { message, segmented, output, grounding } of replayed) {
			report.messages++;
			if (!grounding.coverage.complete) report.incompleteMessages++;
			const trapKey = (labelId?: string) => `${thread.id}/${labelId ?? ''}`;
			const isTrap = (c: Claim) => trapIds.has(trapKey(c.claim.labelId));
			const proposals = output.items as readonly { labelId?: string }[];
			const trapProposal = (kind: string, index: number) =>
				kind === 'item' && trapIds.has(trapKey(proposals[index]?.labelId));
			proposed +=
				grounding.counts.proposed - proposals.filter((_, k) => trapProposal('item', k)).length;
			unsupported += grounding.rejected.filter(
				(r) =>
					(r.reason === 'quote_failed' || r.reason === 'no_quote') && !trapProposal(r.kind, r.index)
			).length;

			const items = grounding.items as Claim[];
			const scoped = scopeEvalMessage(message);
			const allClaims: Claim[] = [
				...items,
				...(grounding.transitions as Claim[]),
				...((grounding.facts ?? []) as Claim[]),
				...(Object.values(grounding.latest ?? {}).flat() as Claim[]),
			];
			for (const claim of allClaims) {
				for (const e of claim.evidence) {
					evidenceTotal++;
					if (evidenceMapsBack(segmented, scoped, e.start, e.end)) evidenceValid++;
				}
			}

			const labels = thread.labels.items.filter((l) => l.messageId === message.id);
			const used = new Set<Claim>();
			for (const label of labels) {
				report.labelledItems++;
				const segmentId = locateQuote(segmented, label.quote, label.segmentKind);
				const verdict = segmentId
					? verifyQuote(segmented.segments, segmented.canonicalText, {
							segmentId,
							text: label.quote,
						})
					: null;
				const match =
					verdict?.ok &&
					items.find(
						(c) => !used.has(c) && !isTrap(c) && c.evidence.some((e) => overlaps(e, verdict))
					);
				for (const slice of thread.slices) {
					const entry = sliceHits.get(slice) ?? { items: 0, hit: 0 };
					entry.items++;
					if (match) entry.hit++;
					sliceHits.set(slice, entry);
				}
				if (!match) {
					report.missed.push({ threadId: thread.id, labelId: label.id });
					continue;
				}
				used.add(match);
				found++;
				if (responsibilityOf(match.claim) === label.responsibility) owned++;
				if (label.expect === 'flagged' && !match.needsReview) {
					report.flagsMissed.push({ threadId: thread.id, labelId: label.id });
				}
			}
			for (const claim of items) {
				if (claim.proposal) report.proposals++;
				if (isTrap(claim)) {
					// A trap kept as a proposal is shown, never tracked: that is fine.
					if (!claim.proposal) {
						report.trapsAccepted.push({ threadId: thread.id, labelId: claim.claim.labelId ?? '' });
					}
					continue;
				}
				// Precision is about TRACKED obligations; proposals ask the user first.
				if (claim.proposal) continue;
				accepted++;
				if (used.has(claim)) acceptedMatched++;
			}
		}
	}

	report.recall = ratio(found, report.labelledItems);
	report.precision = ratio(acceptedMatched, accepted);
	report.ownership = ratio(owned, found);
	report.evidenceValidity = ratio(evidenceValid, evidenceTotal);
	report.unsupportedRate = proposed === 0 ? 0 : unsupported / proposed;
	for (const slice of EVAL_SLICES) {
		const entry = sliceHits.get(slice);
		if (!entry) continue;
		const recall = ratio(entry.hit, entry.items);
		report.perSlice[slice] = { items: entry.items, recall };
		if (!report.worstSlice || recall < report.worstSlice.recall)
			report.worstSlice = { slice, recall };
	}
	return report;
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

/** The report as the CLI prints it. */
export function formatEvalReport(report: EvalReport): string {
	const lines = [
		`Interpretation eval (${report.model})`,
		`threads ${report.threads}  messages ${report.messages}  skipped (ineligible) ${report.skippedIneligible}  labelled items ${report.labelledItems}`,
		`recall            ${pct(report.recall)}`,
		`precision         ${pct(report.precision)}`,
		`ownership         ${pct(report.ownership)}`,
		`evidence validity ${pct(report.evidenceValidity)}`,
		`unsupported rate  ${pct(report.unsupportedRate)}`,
		`cost              $${report.costUsd.toFixed(4)}`,
		`incomplete messages ${report.incompleteMessages}`,
		`proposals         ${report.proposals}`,
		`worst slice       ${report.worstSlice ? `${report.worstSlice.slice} ${pct(report.worstSlice.recall)}` : 'n/a'}`,
		'per slice:',
		...Object.entries(report.perSlice).map(
			([slice, entry]) =>
				`  ${slice.padEnd(22)} ${String(entry.items).padStart(4)} items  ${pct(entry.recall)}`
		),
	];
	const list = (
		title: string,
		entries: { threadId: string; labelId?: string; noteId?: string }[]
	) => {
		if (entries.length === 0) return;
		lines.push(`${title}:`);
		for (const e of entries) lines.push(`  ${e.threadId} ${e.labelId ?? e.noteId ?? ''}`);
	};
	list('missed obligations', report.missed);
	list('traps that grounded', report.trapsAccepted);
	list('expected flags that did not fire', report.flagsMissed);
	list('internal notes in model input', report.notesLeaked);
	return lines.join('\n');
}
