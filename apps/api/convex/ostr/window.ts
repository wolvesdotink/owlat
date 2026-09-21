'use node';

/**
 * Closing an observation window (plan §7.2 → §7.4 → §9.1), once an hour.
 *
 * One pass, in the order the plan puts them:
 *
 * 1. Retention first — held traffic older than the evidence window is dropped,
 *    because held counters carry salted recipient tokens and §7.2 caps how long
 *    those may exist.
 * 2. Every DKIM-verified message delivered since the last watermark is folded
 *    into the `TrafficAccumulator`.
 * 3. The window is closed. Subjects that clear the k-floor emit a
 *    `traffic-summary`; the rest are HELD and folded into a wider window next
 *    time. Publishing "1 message from example.com, 1 recipient" is the
 *    single-user exposure the floor exists to prevent, so there is no path here
 *    that publishes a held subject.
 * 4. Each emitted summary is offered its queued spam reports. A batch travels
 *    with its denominator or not at all (§7.3), and clears BOTH halves of the
 *    k-floor — enough reports and enough DISTINCT reporters — or stays queued.
 * 5. Key observations (§7.5) for the keys seen this window, rate-limited by the
 *    package to at most one attestation per key per window.
 * 6. Everything is SIGNED, and only then is the consumed state written down:
 *    signing is pure, offline and deterministic, so a bad key or an unfoldable
 *    observer domain must fail before the accumulator's counters and the report
 *    queue have been spent on drafts nobody can publish. Submission failure is
 *    the opposite case — expected traffic, not an error: the ledger keeps what
 *    has not been accepted and the next window re-posts it.
 *
 * WHAT IS NOT HERE. Trap hits (§5, §6.3) are skipped in v1 — this deployment
 * operates no never-subscribed trap addresses, and `buildTrapHitBatch` with
 * nothing to count would publish a claim we cannot back. Wire it when trap
 * addresses exist, not before. IP subjects are absent for a structural reason:
 * the connecting address is on the MTA's connection record, not on a delivered
 * message, so a Convex-side observer attests domain traffic and says nothing
 * about IPs — which is the honest reading of what it actually witnessed.
 *
 * SERVING a challenge (§7.2.4) is also not here: no endpoint yet answers a
 * monitor's sampled indices with openings. What IS here is the retention that
 * makes answering possible later — every published batch's commitment and its
 * ORDERED bundle-hash list are written to `ostrBatchCommitments`, because a root
 * cannot be re-derived from a set and the order is unrecoverable after the fact.
 * `answerChallenge` in `@owlat/ostr-observer` takes exactly that record.
 *
 * A KNOWN v1 SIMPLIFICATION. A batch is published against the summary of the
 * window it is published IN, so reports held across several windows are
 * attested beside a denominator that does not span their whole capture period.
 * The package refuses a batch claiming more reports than that summary attests
 * messages, so this can never manufacture a rate above 100% — it can only
 * understate the window a complaint arose in. Correcting it needs the
 * accumulator to hold a subject on the batch's behalf, which its API does not
 * offer today; `ostrReportQueue.capturedAt` keeps the real capture instant so
 * the correction stays possible.
 *
 * The two halves either side of the signing step live in siblings: what a pass
 * DRAFTS beside its summaries in `windowDrafts.ts` (§7.3 spam batches, §7.5 key
 * observations), and what it does with the signed result in
 * `windowSubmission.ts` (§9.1 submission and the retry ledger).
 */

import {
	assertObserverEligible,
	signDrafts,
	TrafficAccumulator,
	type AttestationDraft,
	type TrafficAccumulatorState,
} from '@owlat/ostr-observer';
import { compareRfc3339 } from '@owlat/ostr-core';
import { internalAction, type ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { logError } from '../lib/runtimeLog';
import {
	canPublish,
	OSTR_EVIDENCE_RETENTION_MS,
	OSTR_MAX_MAILBOX_PAGES,
	OSTR_WINDOW_MS,
	readObserverConfig,
} from './config';
import {
	clampError,
	mailboxToken,
	observerIdentity,
	readTokenSalt,
	toRfc3339,
	windowOf,
} from './observerRuntime';
import { appendKeyObservations, appendSpamBatches, pendingBySubject } from './windowDrafts';
import { retryUnsettled, submitSigned } from './windowSubmission';

/** Most windows one pass will fold in after an outage. A deployment that was
 *  down for a week closes a day at a time rather than scanning the week in one
 *  transaction; the watermark advances, so the next tick continues. */
const MAX_WINDOWS_PER_PASS = 24;

export interface WindowCloseResult {
	skipped?: string;
	windowFrom?: string;
	windowTo?: string;
	emitted?: number;
	held?: number;
	published?: number;
}

export const closeWindow = internalAction({
	args: {},
	handler: async (ctx): Promise<WindowCloseResult> => {
		const config = readObserverConfig();
		// The opt-in first, and on its own. Observer mode ships OFF, this cron
		// fires hourly on every deployment, and the roster walk below is up to
		// `OSTR_MAX_MAILBOX_PAGES` paginated queries — work no default instance
		// should ever do to reach a verdict its environment already determines.
		// The count still gates the enabled path; it just no longer has to be
		// gathered to say "disabled".
		if (!config.isEnabled) return { skipped: 'disabled' };
		const roster = await collectMailboxes(ctx);
		if (roster === null) return { skipped: 'roster-too-large' };
		const eligibility = assertObserverEligible({
			enabled: config.isEnabled,
			mailboxCount: roster.length,
			minMailboxes: config.minMailboxes,
		});
		if (!eligibility.eligible) return { skipped: eligibility.reason };
		const salt = readTokenSalt();
		if (salt === undefined) return { skipped: 'missing-token-salt' };

		const state = await ctx.runQuery(internal.ostr.observerState.getRunState, {});
		const nowMs = Date.now();
		// Only whole windows are closed: a partial one would publish half its
		// traffic and then attest the other half in a window that overlaps it.
		const windowToMs = Math.floor(nowMs / OSTR_WINDOW_MS) * OSTR_WINDOW_MS;
		const lastMs = state.lastWindowTo === null ? Number.NaN : Date.parse(state.lastWindowTo);
		const earliestMs = windowToMs - MAX_WINDOWS_PER_PASS * OSTR_WINDOW_MS;
		const windowFromMs = Number.isFinite(lastMs)
			? Math.max(lastMs, earliestMs)
			: windowToMs - OSTR_WINDOW_MS;
		if (windowFromMs >= windowToMs) return { skipped: 'window-not-closed' };
		const window = windowOf(windowFromMs, windowToMs);
		const retentionFrom = toRfc3339(nowMs - OSTR_EVIDENCE_RETENTION_MS);

		const accumulator = restoreAccumulator(state.accumulatorState);
		// §7.2 retention, applied to the counters rather than to a table: held
		// traffic carries salted recipient tokens, so it ages out with the
		// evidence bundles it was accumulated alongside.
		accumulator.dropHeldBefore(retentionFrom);

		for (const mailboxId of roster) {
			const observations = await ctx.runQuery(internal.ostr.store.listWindowObservations, {
				mailboxId,
				fromMs: windowFromMs,
				toMs: windowToMs,
			});
			// One salted token per mailbox, computed once: the accumulator counts
			// DISTINCT recipients through these, which is what turns the k-floor
			// from a volume floor back into "enough distinct people".
			const recipient = mailboxToken(salt, 'recipient', mailboxId);
			for (const observation of observations) {
				accumulator.observe({
					signingDomain: observation.signingDomain,
					// The row only carries a `d=` when its signature verified, so
					// this is not the caller's optimism — it is the delivery path's
					// recorded verdict.
					signingDomainVerified: true,
					ip: '',
					spfPass: observation.isSpfPass,
					dkimPass: true,
					dmarcPass: observation.isDmarcPass,
					// Inbound TLS is not recorded on a delivered message; claiming it
					// would attest something we did not witness, and the counter is a
					// subset of `messages`, so 0 is the honest value.
					tls: false,
					recipientCount: 1,
					bounced: false,
					recipients: [recipient],
				});
			}
		}

		// Nothing is EMITTED before we know we can sign. `emitTrafficSummaries`
		// consumes the subjects it emits — they leave the accumulator — so calling
		// it on a deployment with no signing identity would destroy exactly the
		// counters that cleared the floor, unpublished. The window still closes and
		// its traffic still accumulates; `unpublishedFrom` remembers how far back
		// that unoffered traffic reaches, so the first summary after the key is
		// configured claims the window it really covers.
		if (!canPublish(config)) {
			const unpublishedFrom = widenFrom(state.unpublishedFrom, window.from, retentionFrom);
			await persist(ctx, accumulator, window.to, unpublishedFrom);
			return { skipped: 'not-configured', windowFrom: window.from, windowTo: window.to };
		}

		const emission = accumulator.emitTrafficSummaries({
			windowFrom: widenFrom(state.unpublishedFrom, window.from, retentionFrom),
			windowTo: window.to,
		});

		const drafts: AttestationDraft[] = [...emission.emitted];
		const batches = appendSpamBatches(emission.emitted, await pendingBySubject(ctx), drafts);
		await appendKeyObservations(ctx, drafts, windowFromMs, windowToMs);

		// SIGN BEFORE ANYTHING IS SPENT. Signing is offline and deterministic, and
		// it throws on an observer domain the package will not fold or a key it
		// cannot read — an operator typo, in other words. Persisting first would
		// mean every hour consuming a window's counters and stamping its reports
		// emitted for drafts that were never signed, with no ledger row to retry
		// from and a dedupe key that blocks the message from ever being reported
		// again. So a signing failure costs one pass and leaves the queue intact.
		let attestations;
		try {
			attestations = signDrafts(observerIdentity(config), drafts);
		} catch (error) {
			logError('[OSTR] refusing to publish an invalid draft:', clampError(error));
			return { skipped: 'signing-failed', windowFrom: window.from, windowTo: window.to };
		}

		// Now the consumed state is durable: the accumulator has given up the
		// counters behind these drafts, so a crash before this write would
		// re-attest the same traffic next hour.
		await persist(ctx, accumulator, window.to, undefined);
		// And the batches are recorded before the network, for the same reason in
		// the other direction: a duplicate commitment to one evidence bundle is a
		// finding against this observer at challenge time (§7.2.4), while a batch
		// lost to a crash is only a batch nobody published.
		if (batches.length > 0) {
			await ctx.runMutation(internal.ostr.store.commitBatches, { batches });
		}

		await retryUnsettled(ctx);
		const published = await submitSigned(ctx, config, attestations);
		return {
			windowFrom: window.from,
			windowTo: window.to,
			emitted: emission.emitted.length,
			held: emission.held.length,
			published,
		};
	},
});

/**
 * The whole observed roster, or `null` when it is longer than one pass may walk.
 *
 * `null` REFUSES the pass rather than publishing against a truncated
 * denominator: a summary covering some of the instance's mailboxes while the
 * report path accepts complaints from all of them is §7.3's under-attestation
 * pattern, which monitors are specified to flag against the observer.
 */
async function collectMailboxes(ctx: ActionCtx): Promise<Id<'mailboxes'>[] | null> {
	const mailboxIds: Id<'mailboxes'>[] = [];
	let cursor: string | null = null;
	for (let page = 0; page < OSTR_MAX_MAILBOX_PAGES; page++) {
		// Annotated because `internal` closes over this module: without it the
		// inferred type of the call refers back to `closeWindow`'s own signature.
		const result: { mailboxIds: Id<'mailboxes'>[]; cursor: string; isDone: boolean } =
			await ctx.runQuery(internal.ostr.store.listObservedMailboxPage, { cursor });
		mailboxIds.push(...result.mailboxIds);
		if (result.isDone) return mailboxIds;
		cursor = result.cursor;
	}
	logError('[OSTR] mailbox roster exceeds what one window pass may enumerate; publishing nothing');
	return null;
}

/** The earliest RFC 3339 instant a published window may claim: whatever traffic
 *  is still unoffered reaches back to, clamped forward to the retention cutoff
 *  (nothing older than that survives to be attested anyway). */
function widenFrom(
	unpublishedFrom: string | null,
	windowFrom: string,
	retentionFrom: string
): string {
	if (unpublishedFrom === null) return windowFrom;
	const earliest =
		compareRfc3339(unpublishedFrom, retentionFrom) < 0 ? retentionFrom : unpublishedFrom;
	return compareRfc3339(earliest, windowFrom) < 0 ? earliest : windowFrom;
}

/** Rehydrate the persisted accumulator, or start clean when the blob is from a
 *  version this build does not know — the package throws rather than guessing,
 *  and starting empty loses held traffic but never publishes something wrong. */
function restoreAccumulator(blob: string | null): TrafficAccumulator {
	if (blob === null) return new TrafficAccumulator();
	try {
		return TrafficAccumulator.restore(JSON.parse(blob) as TrafficAccumulatorState);
	} catch (error) {
		logError('[OSTR] traffic accumulator state unreadable, starting empty:', clampError(error));
		return new TrafficAccumulator();
	}
}

async function persist(
	ctx: ActionCtx,
	accumulator: TrafficAccumulator,
	lastWindowTo: string,
	unpublishedFrom: string | undefined
): Promise<void> {
	await ctx.runMutation(internal.ostr.observerState.putRunState, {
		accumulatorState: JSON.stringify(accumulator.serialize()),
		lastWindowTo,
		unpublishedFrom,
	});
}
