/**
 * Send assignments — the ROUTING half (plan D7 / D8 / D16).
 *
 * `delivery/sendAssignments.ts` owns the record: what a row means, when it is
 * written, how it is read back and when it ages out. This module owns the
 * question that record has to answer first — for THIS recipient, which cell,
 * which transport, and where in the cell's engagement distribution do they sit.
 * Splitting them keeps each under the ~500 LOC guideline CONVENTIONS.md sets
 * and puts every route/classification read behind one seam.
 *
 * Nothing here may throw at its caller: recording the experiment must never be
 * able to fail a send. An unparseable address, an unresolvable route and an
 * unavailable seam all degrade to "no row".
 */

import type { MutationCtx } from '../_generated/server';
import { extractDomainOrNull } from '@owlat/shared';
import type {
	DeliverabilityStream,
	DestinationProviderKey,
} from '@owlat/shared/deliverabilityRouting';
import {
	normalizeDestinationDomain,
	resolveDestinationProvider,
} from '../lib/sendProviders/destinationProvider';
import {
	prepareCellMixResolver,
	type CellMixResolver,
	type CellRouteOutcome,
} from '../lib/sendProviders/cellRoute';
import { rankTieBreakUnit, type MixRecipientIdentity } from '../lib/sendProviders/strategies';
import { engagementPercentileRange } from '../analytics/engagementPercentile';
import { logWarn } from '../lib/runtimeLog';
// Type-only, so the pair of modules has no runtime import cycle.
import type { SendAssignmentRecipient, SendAssignmentRouting } from './sendAssignments';

/**
 * Minimum cohort size before a batch's engagement scores are turned into
 * percentiles for stratified assignment (D10's rule applied to ranking: thin
 * data holds). A cohort of one always ranks its single member in the top
 * percentile, which would send every low-volume batch to the own arm on
 * evidence that does not exist. Below this the recipient carries NO rank and
 * the split falls back to the unbiased random bucket.
 *
 * Counted PER CELL, because the cohort is per cell (see
 * `buildEngagementRanker`). A cell below the minimum yields no rank at all and
 * every one of its recipients falls back to the hash bucket, which realises the
 * cell's configured share EXACTLY — so the thin-cell fallback is strictly
 * harmless, while a mis-realised stratified cut is not.
 */
export const MIN_STRATIFICATION_COHORT = 20;

/**
 * Memoizing batch wrapper around the SHIPPED MX-learned classifier
 * (`lib/sendProviders/destinationProvider.ts` — the same read the route
 * resolver does). One indexed point read per DISTINCT, case-normalized domain
 * across the batch; never a table scan, never a second domain map.
 *
 * Exported so the write-amplification regression can assert the read count
 * BEHAVIOURALLY (k distinct domains ⇒ exactly k `by_org_domain` reads),
 * rather than only inspecting the source for a memo map.
 *
 * An address whose domain does not parse is OMITTED from the map rather than
 * classified as `other`: we cannot say which cell it belongs to, and a
 * guessed cell is worse than a missing row. The caller skips it.
 */
export async function destinationProvidersForEmails(
	ctx: Pick<MutationCtx, 'db'>,
	organizationId: string,
	emails: readonly string[],
	now: number
): Promise<Map<string, DestinationProviderKey>> {
	const byDomain = new Map<string, DestinationProviderKey>();
	const byEmail = new Map<string, DestinationProviderKey>();
	for (const email of emails) {
		const rawDomain = extractDomainOrNull(email);
		if (rawDomain === null) continue;
		// Defence in depth, not a correction: `extractDomainOrNull` goes through
		// `parseAddress`, which already lowercases, so this is a no-op for every
		// address that arrives here today. It is applied anyway because the memo
		// key must agree with the key `resolveDestinationProvider` normalizes to
		// internally — otherwise a future non-address caller (that helper takes a
		// bare `domain: string`) would split one domain across two memo slots.
		const domain = normalizeDestinationDomain(rawDomain);
		let provider = byDomain.get(domain);
		if (provider === undefined) {
			provider = await resolveDestinationProvider(ctx, organizationId, domain, now);
			byDomain.set(domain, provider);
		}
		byEmail.set(email, provider);
	}
	return byEmail;
}

/**
 * Engagement percentile WITHIN THE RECIPIENT'S CELL (D8's stratification
 * input; the piece card's "the recipient's engagement percentile in this
 * cell").
 *
 * The cohort is the batch's own scored recipients, PARTITIONED BY DESTINATION
 * PROVIDER: stratification asks "is this recipient in the top `s` of this
 * cell's traffic", and a page of a campaign is the sample we have in hand for
 * free. Ranking costs no extra read — the scores are already on the envelope
 * the producer built, and the provider classification is already resolved for
 * the cell key — and reuses the shipped percentile helper rather than
 * re-implementing scoring.
 *
 * THE PARTITION IS LOAD-BEARING, not tidiness. The stratified cut
 * (`rank >= 1 - s`) is taken against the CELL's share, so a rank measured
 * against the whole batch only realises `s` if every cell's rank distribution
 * is uniform over `[0,1)`. It is not, the moment engagement correlates with
 * who runs the mailbox — an entirely ordinary correlation (consumer gmail vs
 * corporate microsoft vs a legacy `other` tail). With disjoint score bands a
 * batch-wide cohort at `s = 0.5` sends ~83% of the gmail cell own and 0% of
 * every other cell: the own MTA carries far more than the controller's set
 * point in one cell and nothing in the rest, so every rate the controller
 * derives sits over denominators describing a split nobody configured, and the
 * AIMD loop chases a number that does not mean what it says.
 *
 * TIES ARE DISPERSED, and that is the load-bearing part. `engagementPercentile`
 * gives every member of a tied group the group's UPPER percentile, so a cohort
 * where everyone shares one score — a cold or freshly-imported list, i.e. the
 * common warming case, and `0` is a perfectly valid shared score — would rank
 * every member at 1.0, and the stratified cut (`rank >= 1 - s`) would then send
 * 100% of the cell to the own arm for ANY `s > 0`. A cohort 60% tied at the
 * bottom would send that whole 60% own at `s = 0.5`. Both push realised own
 * volume far above the controller's set point, and in the worst direction: the
 * LEAST engaged recipients are the ones promoted. So each recipient is placed
 * inside the percentile INTERVAL its tied group occupies, at an offset drawn
 * from its own stable hash. Distinct scores keep their exact ordering; a fully
 * tied cohort spreads uniformly over [0,1) and the realised own share tracks
 * `s` again.
 *
 * The tie-break hash lives in its own partition and is salted with neither the
 * campaign nor the mix version, so it is INDEPENDENT of the arm bucket — a
 * tie-break correlated with the arm would re-introduce exactly the bias it
 * exists to remove.
 *
 * A recipient with no score gets NO rank, which the decision function reads as
 * "unknown" and falls back to the random bucket — never to the own arm.
 */
export function buildEngagementRanker(
	recipients: readonly SendAssignmentRecipient[],
	providers: ReadonlyMap<string, DestinationProviderKey>
): (recipient: SendAssignmentRecipient) => number | undefined {
	const cohorts = new Map<DestinationProviderKey, number[]>();
	for (const recipient of recipients) {
		const score = recipient.engagementScore;
		if (score === undefined || !Number.isFinite(score)) continue;
		// An address whose domain did not parse has no cell, so it has no cohort
		// to belong to — the caller skips it for the same reason.
		const provider = providers.get(recipient.email);
		if (provider === undefined) continue;
		const cohort = cohorts.get(provider);
		if (cohort === undefined) cohorts.set(provider, [score]);
		else cohort.push(score);
	}
	// Sorted once per cell, and cells too thin to rank (D10 — thin data holds)
	// are dropped here rather than re-tested per recipient. A dropped cell ranks
	// nobody, so all of it falls back to the random bucket.
	const rankable = new Map<DestinationProviderKey, readonly number[]>();
	for (const [provider, cohort] of cohorts) {
		if (cohort.length < MIN_STRATIFICATION_COHORT) continue;
		cohort.sort((a, b) => a - b);
		rankable.set(provider, cohort);
	}
	if (rankable.size === 0) return () => undefined;

	return (recipient) => {
		const score = recipient.engagementScore;
		if (score === undefined || !Number.isFinite(score)) return undefined;
		const provider = providers.get(recipient.email);
		if (provider === undefined) return undefined;
		const cohort = rankable.get(provider);
		if (cohort === undefined) return undefined;
		const { lower, upper } = engagementPercentileRange(cohort, score);
		// Every DISTINCT score occupies its own interval, and those intervals are
		// disjoint, so dispersing inside one can never reorder two distinct
		// scores. A distinct score's interval is one cohort slot wide (not zero),
		// so untied ranks move too — harmlessly. A tie is the only case where the
		// interval is wider than 1/n, and dispersing it is the whole point.
		return lower + (upper - lower) * rankTieBreakUnit(recipient.sendId);
	};
}

interface TransportLookupInput {
	readonly routing: SendAssignmentRouting;
	readonly stream: DeliverabilityStream;
	readonly organizationId: string;
	readonly now: number;
}

/**
 * Per-recipient cell resolution for one batch.
 *
 * Every input the cell seam READS is per-batch, org-wide, or keyed by the
 * recipient's destination-provider classification alone
 * (`deliverabilityRouteStates.by_org_provider_stream`, with the stream fixed
 * for the batch). The prepared seam memoizes those rows per DISTINCT provider,
 * so this function still cannot issue more than
 * `DESTINATION_PROVIDER_KEYS.length` route-state reads no matter how large the
 * batch is — what became per-recipient is the pure DECISION, not the I/O.
 *
 * That distinction is the piece: under `adaptive_mix` the arm is a function of
 * the recipient (D7), so a per-provider answer would stamp one recipient's arm
 * onto the whole cell. Under every shipped strategy the answer does not depend
 * on the recipient at all and the result is identical to the per-provider
 * lookup this replaced.
 *
 * The resolution goes through the cell seam, NOT the full per-message
 * resolver: the full one reads `providerHealth`, a document patched once per
 * dispatch, and pulling that hotspot into a campaign enqueue transaction would
 * make concurrent dispatches force OCC retries of a transaction that must not
 * fail. Health-driven failover is re-resolved authoritatively by the worker at
 * dispatch time.
 *
 * Route resolution can THROW (`DeliverabilityRouteError`,
 * `GlobalDeliveryCircuitOpenError`). Recording the experiment must never be
 * able to fail a send, so a throw degrades that provider to "unresolved" for
 * the REST OF THE BATCH — no rows, one log line — and the enqueue proceeds
 * untouched. The prologue is wrapped for the same reason: if preparing the seam
 * throws, the whole batch degrades to "no rows", never to a failed enqueue.
 */
export async function buildTransportLookup(
	ctx: MutationCtx,
	input: TransportLookupInput
): Promise<
	(
		destinationProvider: DestinationProviderKey,
		recipient: MixRecipientIdentity
	) => Promise<CellRouteOutcome | null>
> {
	const { routing } = input;
	let resolveCell: CellMixResolver;
	try {
		resolveCell = await prepareCellMixResolver(ctx, routing.messageType, {
			...(routing.from !== undefined ? { from: routing.from } : {}),
			now: input.now,
			organizationId: input.organizationId,
			stream: input.stream,
		});
	} catch (error) {
		logWarn(
			'[sendAssignments] cell route seam unavailable; recording no assignments:',
			error instanceof Error ? error.name : 'UnknownError'
		);
		return async () => null;
	}
	// A provider whose resolution threw is not retried per recipient: the
	// failure is a property of the cell, and one log line per cell keeps a
	// systematically-throwing resolver visible without a line per recipient.
	const failedProviders = new Set<DestinationProviderKey>();
	return async (destinationProvider, recipient) => {
		if (failedProviders.has(destinationProvider)) return null;
		try {
			return await resolveCell(destinationProvider, recipient);
		} catch (error) {
			// Never the recipient address and never `from`: an assignment log
			// line must not become a PII sink. Provider + error name is enough
			// to tell "this cell is unroutable today" from "the resolver is
			// systematically throwing and the experiment record is empty".
			logWarn(
				`[sendAssignments] route resolution failed for cell provider ${destinationProvider}:`,
				error instanceof Error ? error.name : 'UnknownError'
			);
			failedProviders.add(destinationProvider);
			return null;
		}
	};
}
