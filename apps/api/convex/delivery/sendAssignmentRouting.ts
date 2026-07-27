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
import type { MixRecipientIdentity } from '../lib/sendProviders/strategies';
import { engagementPercentile } from '../analytics/engagementScore';
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
 * Per-CELL engagement percentile over the batch (D8's stratification input).
 *
 * The cohort is the batch's own recipients IN THE SAME CELL: stratification
 * asks "is this recipient in the top `s` of this cell's traffic", and a page of
 * a campaign is the sample we have in hand for free. Ranking against the batch
 * costs no extra read — the scores are already on the envelope the producer
 * built — and reuses the shipped `engagementPercentile` rather than
 * re-implementing scoring.
 *
 * A recipient with no score gets NO rank, which the decision function reads as
 * "unknown" and falls back to the random bucket — never to the own arm.
 */
export function buildEngagementRanker(
	recipients: readonly SendAssignmentRecipient[],
	providers: ReadonlyMap<string, DestinationProviderKey>
): (
	recipient: SendAssignmentRecipient,
	destinationProvider: DestinationProviderKey
) => number | undefined {
	const cohorts = new Map<DestinationProviderKey, number[]>();
	for (const recipient of recipients) {
		const score = recipient.engagementScore;
		if (score === undefined || !Number.isFinite(score)) continue;
		const destinationProvider = providers.get(recipient.email);
		if (destinationProvider === undefined) continue;
		const cohort = cohorts.get(destinationProvider);
		if (cohort === undefined) cohorts.set(destinationProvider, [score]);
		else cohort.push(score);
	}
	for (const cohort of cohorts.values()) cohort.sort((a, b) => a - b);

	return (recipient, destinationProvider) => {
		if (recipient.engagementRank !== undefined) return recipient.engagementRank;
		const score = recipient.engagementScore;
		if (score === undefined || !Number.isFinite(score)) return undefined;
		const cohort = cohorts.get(destinationProvider);
		if (cohort === undefined || cohort.length < MIN_STRATIFICATION_COHORT) return undefined;
		return engagementPercentile(cohort, score);
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
