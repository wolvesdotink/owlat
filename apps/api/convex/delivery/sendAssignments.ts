/**
 * Send assignments — the experiment record (ADR-0054 §8, plan D7 / D16).
 *
 * Send rows record `providerType` POST-HOC, from the dispatch result. That is
 * enough to know what happened to one message and not enough to compare two
 * arms: there is no stable record of which transport a recipient was
 * ASSIGNED to, in which cell, under which mix version. This module owns that
 * record.
 *
 * Invariants this module exists to hold:
 *   - The row is written BEFORE dispatch and INSIDE the existing enqueue
 *     transaction (never a scheduled follow-up). If the enqueue transaction
 *     rolls back, no assignment row survives — the record and the send agree.
 *   - Writing an assignment must NEVER be able to fail a send. Everything here
 *     is defensive: an unresolvable organization, an unparseable address or
 *     an unknown transport degrades to "no row", never a throw.
 *   - Every read is org-leading. `sendAssignments` is cell-keyed, and a
 *     cell-keyed table readable across tenants would be a security defect.
 *   - O(N) narrow writes for N recipients, and no unbounded table read
 *     anywhere on this path (ADR-0042's post-mortem). In particular the
 *     recorded route comes from the health-free cell seam: the full
 *     per-message resolver reads `providerHealth`, which is patched once per
 *     dispatch, and a campaign enqueue transaction that took a read
 *     dependency on it would OCC-retry against its own campaign's dispatches.
 *     Health-driven failover is re-resolved authoritatively at dispatch, so
 *     what this table records is the DELIVERABILITY decision for the cell.
 *
 * The arm itself is chosen by the ROUTER, never here: under the shipped
 * strategies the row records what the router decided (`mta` → `own`, anything
 * else → `reference`); under `adaptive_mix` the router's decision IS the
 * deterministic per-recipient split, and the mix decision it hands back
 * (`isCalibration`, `mixVersion`, `engagementRank`) is recorded verbatim. There
 * is exactly one decision, taken in one place.
 */

import { v } from 'convex/values';
import { internalMutation, type DatabaseReader, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import {
	deliverabilityCellKey,
	type DeliverabilityCellKey,
	type DeliverabilityStream,
} from '@owlat/shared/deliverabilityRouting';
import { resolveNow } from '../lib/clock';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import type { MixAssignment, MixRecipientIdentity } from '../lib/sendProviders/strategies';
import { DEFAULT_MIX_VERSION, OWN_ARM_TRANSPORT_KIND } from '../lib/sendProviders/strategies';
import type { MessageType } from '../lib/sendProviders/routeInputs';
import { isSendProviderKind, type SendProviderKind } from '../lib/sendProviders/types';
import {
	buildEngagementRanker,
	buildTransportLookup,
	destinationProvidersForEmails,
} from './sendAssignmentRouting';

// The classification seam lives next door but is part of THIS module's public
// surface: it is what the write-amplification regression asserts against.
export { destinationProvidersForEmails } from './sendAssignmentRouting';

/** Assignment rows age out after 90 days (D16 — write amplification is bounded). */
export const SEND_ASSIGNMENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Rows deleted per retention tick; the sweep re-schedules itself while full. */
export const SEND_ASSIGNMENT_CLEANUP_BATCH_SIZE = 200;

/**
 * Derived from the schema rather than re-declared, so the literal sets cannot
 * drift from the table they are written into.
 */
export type SendAssignmentArm = Doc<'sendAssignments'>['arm'];
export type SendAssignmentKind = Doc<'sendAssignments'>['sendKind'];

/**
 * Pure: which arm a transport belongs to. The own MTA is the `own` arm; every
 * other catalog transport (SES, Resend, SMTP relay, plugin transports) is the
 * `reference` arm we measure against.
 *
 * `transport` here is the provider KIND, not a `SendTransportId`
 * (`lib/sendProviders/transports.ts`): the routing layer's verdict
 * (`ResolvedRoute.providerType`) is a kind, and the arm question is a property
 * of the kind — two configured `ses` instances are both `reference`. The
 * `sendAssignments.transport` column stores the same kind for the same reason.
 */
export function armForTransport(transport: SendProviderKind): SendAssignmentArm {
	return transport === OWN_ARM_TRANSPORT_KIND ? 'own' : 'reference';
}

/**
 * The same question, asked of a transport LABEL that has crossed a wire.
 *
 * A provider kind that travels through a Convex value (the worker → completion
 * seam's `providerType`) arrives as a plain string: `SendProviderKind` includes
 * the namespaced kinds bundled plugins contribute, which no validator can
 * express, so the wire carries `v.string()`. This narrows it back through the
 * catalog's own membership test rather than re-deriving the arm from a second
 * comparison — {@link armForTransport} stays the only place D3's own-arm
 * declaration is read.
 *
 * A label naming no transport this build can dispatch to is not the own arm by
 * construction, so it measures as `reference`.
 */
export function armForTransportLabel(transport: string): SendAssignmentArm {
	return isSendProviderKind(transport) ? armForTransport(transport) : 'reference';
}

/**
 * Best-effort organization resolution for the assignment write. The campaign
 * producer usually supplies one; otherwise fall back to the singleton org.
 * An unresolvable org yields `null` and the caller skips the row — recording
 * the experiment must never be able to block a send.
 *
 * `explicit` is deliberately `string | null | undefined`: an optional value
 * returned by a Convex query crosses the function boundary as `null`, not
 * `undefined` (the non-campaign intake resolves its org through
 * `campaigns.sendQueries.getSingletonOrganizationId`). Treating only
 * `undefined` as absent let that `null` through as an organization id, which
 * silently dropped every non-campaign assignment row and made the singleton
 * fallback below dead code on that path.
 */
async function resolveAssignmentOrganizationId(
	ctx: MutationCtx,
	explicit: string | null | undefined
): Promise<string | null> {
	if (explicit != null && explicit !== '') return explicit;
	try {
		return await getSingletonOrganizationId(ctx);
	} catch {
		return null;
	}
}

export interface SendAssignmentRecipient {
	/** `emailSends` / `transactionalSends` id, as a string. */
	readonly sendId: string;
	readonly email: string;
	/**
	 * THE per-recipient salt for the deterministic mix split (D7). Absent for a
	 * send with no contact row (a preview, an agent reply to an unknown
	 * address); the split then salts with `sendId`, which is stable, unique and
	 * uncorrelated with anything — see `MixRecipientIdentity.fallbackKey`.
	 */
	readonly contactId?: string;
	/**
	 * `contacts.engagementScore` (0-100) as the producer already carries it.
	 * Converted to a percentile WITHIN this batch's cohort through the shipped
	 * percentile helper — this module never re-implements scoring.
	 *
	 * A producer may NOT hand in a ready-made percentile. A supplied rank would
	 * bypass the minimum-cohort rule ("thin data holds", D10) and the band
	 * treatment the cohort path applies, and there is no caller that knows a
	 * percentile the batch does not: the ranking cohort IS the batch.
	 *
	 * The RAW stored value is what a producer passes: `buildEngagementRanker`
	 * applies the envelope's band rule itself, so a producer cannot ship a score
	 * to ranking that the same send's envelope refuses.
	 */
	readonly engagementScore?: number;
}

/**
 * How the transport for each recipient is obtained.
 *
 * There is exactly ONE way, deliberately: the writer always re-resolves
 * in-transaction through the health-free cell seam
 * (`lib/sendProviders/cellRoute.ts prepareCellMixResolver`). The seam reads the
 * cell's route state once per DISTINCT destination provider (at most
 * `DESTINATION_PROVIDER_KEYS.length` reads, never one per recipient) and then
 * decides per RECIPIENT — under `adaptive_mix` the arm is a function of the
 * recipient, so a per-provider answer would be wrong for most of the batch.
 *
 * No producer may hand in a transport it resolved itself. Two reasons, both
 * learned the hard way:
 *
 *   - The deliverability fallback is keyed PER DESTINATION PROVIDER
 *     (`deliverabilityRouteStates.by_org_provider_stream`), so a producer-supplied
 *     `providerType` — which campaign sending resolves ONCE per page from the
 *     first recipient and explicitly labels an advisory snapshot — stamps the
 *     first recipient's route onto every other cell.
 *   - The determinism verdict and the health-free semantics live INSIDE
 *     the prepared cell seam. A producer that resolved through the
 *     AUTHORITATIVE per-message resolver (the transactional Template API does,
 *     for the envelope) holds a HEALTH-INFLUENCED answer drawn with
 *     `Math.random()` under `workload_split` — and the worker draws again
 *     independently at dispatch. Recording it would put a coin flip, under a
 *     second resolution semantics, into the same `transactional:*` cells the
 *     other producers fill from the seam.
 *
 * The extra reads on the Template API's latency-sensitive path are the price
 * of one decision made in one place; the seam reads only indexed,
 * admin-written documents.
 */
export interface SendAssignmentRouting {
	/** Route table to resolve against — the shipped `providerRoutes.messageType`. */
	readonly messageType: MessageType;
	/** Envelope From; feeds the shipped relay-domain verification input. */
	readonly from?: string;
}

export interface RecordSendAssignmentsInput {
	/**
	 * `null` is accepted alongside `undefined`: an optional string returned by
	 * a Convex query arrives as `null` at the call site.
	 */
	readonly organizationId: string | null | undefined;
	readonly stream: DeliverabilityStream;
	readonly sendKind: SendAssignmentKind;
	readonly routing: SendAssignmentRouting;
	readonly recipients: readonly SendAssignmentRecipient[];
	/**
	 * THE anti-cohort salt (D7). Salting the split with `contactId` alone would
	 * pin a contact to one arm forever and turn the two arms into two fixed
	 * cohorts, so every ratio the controller reads would compare cohort quality
	 * instead of transport quality. A campaign passes its campaign id; a
	 * transactional send has no campaign and passes nothing, and each such send
	 * is its own single-recipient experiment.
	 */
	readonly campaignId?: string;
	/**
	 * Fallback values for the mix fields, used only when the route did NOT come
	 * from a per-recipient split (every shipped strategy).
	 */
	readonly mixVersion?: number;
	readonly isCalibration?: boolean;
	readonly now?: number;
}

/**
 * Write one assignment row per recipient, inside the caller's transaction.
 * Returns the number of rows written (0 when the org or transport could not
 * be resolved — a missing record degrades measurement, never delivery).
 */
export async function recordSendAssignments(
	ctx: MutationCtx,
	input: RecordSendAssignmentsInput
): Promise<number> {
	if (input.recipients.length === 0) return 0;
	const organizationId = await resolveAssignmentOrganizationId(ctx, input.organizationId);
	if (organizationId === null) return 0;

	const now = input.now ?? Date.now();
	const providers = await destinationProvidersForEmails(
		ctx,
		organizationId,
		input.recipients.map((recipient) => recipient.email),
		now
	);
	const resolveFor = await buildTransportLookup(ctx, {
		routing: input.routing,
		stream: input.stream,
		organizationId,
		now,
	});
	const fallbackMixVersion = input.mixVersion ?? DEFAULT_MIX_VERSION;
	const fallbackIsCalibration = input.isCalibration ?? false;
	// The ranker is partitioned by the SAME classification the cell key is built
	// from, so a recipient's percentile and the share it is cut against describe
	// the same population.
	const rankFor = buildEngagementRanker(input.recipients, providers);

	let written = 0;
	for (const recipient of input.recipients) {
		const destinationProvider = providers.get(recipient.email);
		// An address whose domain does not parse has no cell we can name.
		if (destinationProvider === undefined) continue;
		const engagementRank = rankFor(recipient);
		const identity: MixRecipientIdentity = {
			...(recipient.contactId !== undefined ? { contactId: recipient.contactId } : {}),
			...(input.campaignId !== undefined ? { campaignId: input.campaignId } : {}),
			...(engagementRank !== undefined ? { engagementRank } : {}),
			fallbackKey: recipient.sendId,
		};
		const outcome = await resolveFor(destinationProvider, identity);
		// An unresolvable route means we do not know what the worker will do,
		// and a guessed arm is worse than a missing row.
		if (outcome === null) continue;
		const transport = outcome.route.providerType;
		const mix: MixAssignment | null = outcome.mix;
		const cell: DeliverabilityCellKey = deliverabilityCellKey({
			stream: input.stream,
			destinationProvider,
		});
		// The rank RECORDED is the one the decision actually used, so an audit of
		// a stratified row can reproduce it. When the router did not split, the
		// producer's rank (if any) is recorded as the observation it is.
		const recordedRank = mix?.engagementRank ?? engagementRank;
		const arm = armForTransport(transport);
		// What makes a row calibration is decided in ONE place — the strategy,
		// which is the only module that can see whether the route has two arms to
		// compare. Here we copy the flag through.
		const isCalibration = mix !== null ? mix.isCalibration : fallbackIsCalibration;
		await ctx.db.insert('sendAssignments', {
			organizationId,
			sendId: recipient.sendId,
			sendKind: input.sendKind,
			cell,
			transport,
			arm,
			isCalibration,
			mixVersion: mix?.mixVersion ?? fallbackMixVersion,
			...(recordedRank !== undefined ? { engagementRank: recordedRank } : {}),
			assignedAt: now,
		});
		written += 1;
	}
	return written;
}

/**
 * THE assignment join. Reader-typed, so the transport outcome writer and any
 * later consumer resolve a send's (cell, arm, calibration) through ONE
 * tenant-scoped lookup — a second copy of this index expression is a copy that
 * will be missed when the index or the `.first()` choice changes. A consumer
 * that needs it over the wire wraps THIS; do not add a second query shell for
 * it before something calls one (D20).
 *
 * Org-leading: a caller holding another tenant's send id still gets nothing.
 */
export async function readAssignmentForSend(
	db: DatabaseReader,
	organizationId: string,
	sendId: string
): Promise<Doc<'sendAssignments'> | null> {
	return await db
		.query('sendAssignments')
		.withIndex('by_org_send', (q) => q.eq('organizationId', organizationId).eq('sendId', sendId))
		.first();
}

/**
 * Retention sweep (D16). Indexed, bounded, and self-resuming: deletes the
 * oldest expired rows through `by_assigned_at` and reschedules itself while a
 * tick comes back full, so a large backlog drains across ticks instead of
 * blowing one transaction.
 */
export const cleanupExpiredAssignments = internalMutation({
	args: { now: v.optional(v.number()) },
	handler: async (ctx, args) => {
		// A non-finite `now` would make `cutoff` NaN and the sweep a silent
		// no-op forever: `resolveNow` falls back to the real clock instead.
		const now = resolveNow(args.now);
		const cutoff = now - SEND_ASSIGNMENT_RETENTION_MS;
		const expired = await ctx.db
			.query('sendAssignments')
			.withIndex('by_assigned_at', (q) => q.lt('assignedAt', cutoff))
			.take(SEND_ASSIGNMENT_CLEANUP_BATCH_SIZE);
		await Promise.all(expired.map((row) => ctx.db.delete(row._id)));
		if (expired.length === SEND_ASSIGNMENT_CLEANUP_BATCH_SIZE) {
			await ctx.scheduler.runAfter(
				0,
				internal.delivery.sendAssignments.cleanupExpiredAssignments,
				args
			);
		}
		return { deleted: expired.length };
	},
});
