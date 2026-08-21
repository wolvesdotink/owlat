'use node';

/**
 * The drafting half of a window close (plan §7.3 → §7.5): everything a pass
 * adds to its draft list BESIDE the traffic summaries the accumulator emitted —
 * a spam batch travelling with the summary that carries its denominator, and a
 * key observation for each key the window verified with.
 *
 * Both are pure with respect to publication. They append drafts and describe
 * what a batch committed to; nothing here spends the report queue or the
 * accumulator's counters. `window.ts` explains why that ordering is load-bearing:
 * the drafts are signed before any of the state behind them is written down.
 */

import {
	buildReportedWindow,
	KeyObservationTracker,
	retainBatchCommitment,
	type AttestationDraft,
} from '@owlat/ostr-observer';
import type { TrafficSummaryBody } from '@owlat/ostr-core';
import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { logInfo } from '../lib/runtimeLog';
import {
	CollectedBatchCommitmentStore,
	extractDkimPublicKey,
	LoadedKeyObservationStore,
	windowOf,
} from './observerRuntime';

/** One published batch, as the store retains it (§7.2.4) plus the queue rows it
 *  committed. */
export interface PreparedBatch {
	subjectDomain: string;
	windowFrom: string;
	windowTo: string;
	commitmentHex: string;
	bundleHashes: string[];
	reportIds: Id<'ostrReportQueue'>[];
}

/** A queued spam report, reduced to what a batch needs from it. */
export interface PendingReport {
	id: Id<'ostrReportQueue'>;
	bundleHash: string;
	reporterToken: string;
}

/** Every held report, grouped by the subject it accuses. */
export async function pendingBySubject(ctx: ActionCtx): Promise<Map<string, PendingReport[]>> {
	const pending = await ctx.runQuery(internal.ostr.store.listPendingReports, {});
	const bySubject = new Map<string, PendingReport[]>();
	for (const report of pending) {
		const entry = {
			id: report.id,
			bundleHash: report.bundleHash,
			reporterToken: report.reporterToken,
		};
		const bucket = bySubject.get(report.subjectDomain);
		if (bucket === undefined) bySubject.set(report.subjectDomain, [entry]);
		else bucket.push(entry);
	}
	return bySubject;
}

/**
 * Pair each emitted summary with its queued reports.
 *
 * A refusal is never a reason to drop the summary: publishing volume without a
 * batch is legitimate and expected, and the two k-floor refusals
 * (`below-report-threshold`, `below-reporter-threshold`) are HOLDS — the rows
 * stay queued for a wider window, which is the whole §7.4 mechanism.
 *
 * Pure: it appends drafts and describes what each batch committed to. Nothing
 * is written until the drafts behind it have been signed.
 */
export function appendSpamBatches(
	summaries: readonly AttestationDraft<TrafficSummaryBody>[],
	bySubject: Map<string, PendingReport[]>,
	drafts: AttestationDraft[]
): PreparedBatch[] {
	if (bySubject.size === 0) return [];
	const prepared: PreparedBatch[] = [];
	for (const summary of summaries) {
		const domain = summary.subject.domain;
		if (domain === undefined || summary.window === undefined) continue;
		const reports = bySubject.get(domain);
		if (reports === undefined || reports.length === 0) continue;
		const result = buildReportedWindow({
			summary,
			batch: {
				subject: summary.subject,
				window: summary.window,
				bundles: reports.map((report) => ({
					bundleHash: report.bundleHash,
					signingDomain: domain,
					reporter: report.reporterToken,
				})),
			},
		});
		if (!result.ok) {
			logInfo('[OSTR] spam batch held for', domain, '-', result.reason);
			continue;
		}
		// The summary is already in `drafts`; only the batch is added, so the
		// pair travels together exactly once.
		const batchDraft = result.drafts[1];
		drafts.push(batchDraft);
		// §7.2.4: the ordered hash list is what an opening indexes into, and it
		// cannot be reconstructed once the batch is out. The package's own
		// retainer enforces that the draft carries the window the record is filed
		// under; the store below is the write-through buffer for the mutation.
		const store = new CollectedBatchCommitmentStore();
		const record = retainBatchCommitment(store, batchDraft, result.bundleHashes);
		prepared.push({
			subjectDomain: domain,
			windowFrom: record.window.from,
			windowTo: record.window.to,
			commitmentHex: record.commitmentHex,
			bundleHashes: record.bundleHashes,
			reportIds: reports.map((report) => report.id),
		});
	}
	return prepared;
}

/**
 * Emit `key-observation` attestations for the keys this window verified with.
 *
 * `dnssecValidated` is false throughout: the evidence wire contract carries no
 * DNSSEC result, and the field is a CLAIM about the chain at verification time.
 * Asserting one we never observed would be the single worst thing to get wrong
 * here — the whole point of §7.5 is that a challenge is adjudicated against
 * this record. It becomes true the day the MTA reports validation, and the
 * package's `public-key-upgraded` path already knows how to re-emit a record
 * that learned something.
 */
export async function appendKeyObservations(
	ctx: ActionCtx,
	drafts: AttestationDraft[],
	fromMs: number,
	toMs: number
): Promise<void> {
	const sightings = await ctx.runQuery(internal.ostr.store.listWindowKeySightings, {
		fromMs,
		toMs,
	});
	if (sightings.length === 0) return;
	const stored = await ctx.runQuery(internal.ostr.observerState.listKeyObservations, {});
	const store = new LoadedKeyObservationStore(stored);
	const tracker = new KeyObservationTracker(store);
	const window = windowOf(fromMs, toMs);
	for (const sighting of sightings) {
		const publicKey = extractDkimPublicKey(sighting.dnsKeyRecordTxt);
		if (publicKey === undefined) continue;
		const result = tracker.observe(
			{
				domain: sighting.signingDomain,
				selector: sighting.selector,
				publicKey,
				dnssecValidated: false,
				seenAt: sighting.verifiedAt,
			},
			window
		);
		if (result.ok && result.draft !== null) drafts.push(result.draft);
	}
	const touched = store.touched();
	if (touched.length > 0) {
		await ctx.runMutation(internal.ostr.observerState.putKeyObservations, { records: touched });
	}
}
