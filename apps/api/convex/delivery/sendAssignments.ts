/**
 * Send assignments — the experiment record (plan D7 / D16).
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
 * What this piece does NOT do: choose the arm. Today the row records what the
 * SHIPPED router already decided (`mta` → `own`, anything else → `reference`).
 * The deterministic per-recipient hash, stratification and the calibration
 * slice arrive with the mix controller and will bump `mixVersion`.
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { extractDomainOrNull } from '@owlat/shared';
import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
import {
	formatCellKey,
	isDeliverabilityCellKey,
	type DeliverabilityCellKey,
	type DeliverabilityStream,
} from '@owlat/shared/deliverabilityCell';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import {
	normalizeDestinationDomain,
	resolveDestinationProvider,
} from '../lib/sendProviders/destinationProvider';
import { resolveCellRouteFromDb, type MessageType } from '../lib/sendProviders/route';
import type { SendProviderKind } from '../lib/sendProviders/types';
import { logWarn } from '../lib/runtimeLog';

/** Assignment rows age out after 90 days (D16 — write amplification is bounded). */
export const SEND_ASSIGNMENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Rows deleted per retention tick; the sweep re-schedules itself while full. */
export const SEND_ASSIGNMENT_CLEANUP_BATCH_SIZE = 200;

/** Page size for the cell/window read when the caller does not ask for one. */
export const DEFAULT_CELL_PAGE_SIZE = 100;

/** Hard ceiling on the cell/window read — a per-recipient table (D16). */
export const MAX_CELL_PAGE_SIZE = 500;

/**
 * Mix version 0 = "no controller-driven mix in effect". The row records the
 * shipped router's own decision. The mix controller writes version >= 1.
 */
export const ROUTER_ONLY_MIX_VERSION = 0;

/** The own-MTA transport key. Every other catalog transport is a reference arm. */
const OWN_TRANSPORT_KEY = 'mta';

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
	return transport === OWN_TRANSPORT_KEY ? 'own' : 'reference';
}

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
		// `extractDomainOrNull` does no case folding, and learned observations
		// are stored lowercase: normalize once so `@Gmail.com` hits the same
		// memo slot AND the same stored row as `@gmail.com`.
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
 * Best-effort organization resolution for the assignment write. The campaign
 * producer usually supplies one; otherwise fall back to the singleton org.
 * An unresolvable org yields `null` and the caller skips the row — recording
 * the experiment must never be able to block a send.
 *
 * `explicit` is deliberately `string | null | undefined`: an optional value
 * returned by a Convex query crosses the function boundary as `null`, not
 * `undefined` (`enqueueNonCampaignSend` resolves its org through
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
	/** Optional engagement percentile rank, when the producer already knows it. */
	readonly engagementRank?: number;
}

/**
 * How the transport for each recipient is obtained.
 *
 * There is exactly ONE way, deliberately: the writer always re-resolves
 * in-transaction through the health-free cell seam
 * (`lib/sendProviders/route.ts resolveCellRouteFromDb`), once per DISTINCT
 * destination provider (at most `DESTINATION_PROVIDER_KEYS.length`
 * resolutions, never one per recipient).
 *
 * No producer may hand in a transport it resolved itself. Two reasons, both
 * learned the hard way:
 *
 *   - The deliverability fallback is keyed PER DESTINATION PROVIDER
 *     (`deliverabilityRouteStates.by_org_provider`), so a producer-supplied
 *     `providerType` — which campaign sending resolves ONCE per page from the
 *     first recipient and explicitly labels an advisory snapshot — stamps the
 *     first recipient's route onto every other cell.
 *   - The determinism verdict and the health-free semantics live INSIDE
 *     `resolveCellRouteFromDb`. A producer that resolved through
 *     `resolveSendRouteFromDb` (the transactional Template API does, for the
 *     envelope) holds a HEALTH-INFLUENCED answer drawn with `Math.random()`
 *     under `workload_split` — and the worker draws again independently at
 *     dispatch. Recording it would put a coin flip and a different resolution
 *     semantics into the same `transactional:*` cell as the seam's answers.
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
	const transportFor = await buildTransportLookup(ctx, {
		routing: input.routing,
		organizationId,
		destinationProviders: new Set(providers.values()),
		now,
	});
	const mixVersion = input.mixVersion ?? ROUTER_ONLY_MIX_VERSION;
	const isCalibration = input.isCalibration ?? false;

	let written = 0;
	for (const recipient of input.recipients) {
		const destinationProvider = providers.get(recipient.email);
		// An address whose domain does not parse has no cell we can name.
		if (destinationProvider === undefined) continue;
		const transport = transportFor(destinationProvider);
		// An unresolvable route means we do not know what the worker will do,
		// and a guessed arm is worse than a missing row.
		if (transport === null) continue;
		const cell: DeliverabilityCellKey = formatCellKey({
			stream: input.stream,
			destinationProvider,
		});
		await ctx.db.insert('sendAssignments', {
			organizationId,
			sendId: recipient.sendId,
			sendKind: input.sendKind,
			cell,
			transport,
			arm: armForTransport(transport),
			isCalibration,
			mixVersion,
			...(recipient.engagementRank !== undefined
				? { engagementRank: recipient.engagementRank }
				: {}),
			assignedAt: now,
		});
		written += 1;
	}
	return written;
}

interface TransportLookupInput {
	readonly routing: SendAssignmentRouting;
	readonly organizationId: string;
	/** The DISTINCT destination providers present in the batch. */
	readonly destinationProviders: ReadonlySet<DestinationProviderKey>;
	readonly now: number;
}

/**
 * Build the destination-provider → transport lookup for one batch.
 *
 * The route decision this record needs depends on the recipient ONLY through
 * its destination-provider classification: `deliverabilityRouteStates` is
 * keyed `by_org_provider`, and every other input the cell seam reads
 * (`providerRoutes`, the relay-domain verification, the org-wide state) is
 * per-batch or org-wide. Taking the DISTINCT provider set — rather than the
 * recipients — makes the "one resolution per cell" bound structural: this
 * function cannot issue more than `DESTINATION_PROVIDER_KEYS.length`
 * resolutions no matter how large the batch is.
 *
 * The resolution goes through `resolveCellRouteFromDb`, NOT the full
 * per-message resolver: the full one reads `providerHealth`, a document
 * patched once per dispatch, and pulling that hotspot into a campaign enqueue
 * transaction would make concurrent dispatches force OCC retries of a
 * transaction that must not fail. Health-driven failover is re-resolved
 * authoritatively by the worker at dispatch time.
 *
 * Route resolution can THROW (`DeliverabilityRouteError`,
 * `GlobalDeliveryCircuitOpenError`). Recording the experiment must never be
 * able to fail a send, so a throw degrades that provider to "unresolved" —
 * no row — and the enqueue proceeds untouched.
 */
async function buildTransportLookup(
	ctx: MutationCtx,
	input: TransportLookupInput
): Promise<(destinationProvider: DestinationProviderKey) => SendProviderKind | null> {
	const { routing } = input;
	const byProvider = new Map<DestinationProviderKey, SendProviderKind | null>();
	for (const destinationProvider of input.destinationProviders) {
		let resolvedTransport: SendProviderKind | null = null;
		try {
			const resolved = await resolveCellRouteFromDb(ctx, routing.messageType, {
				destinationProvider,
				...(routing.from !== undefined ? { from: routing.from } : {}),
				now: input.now,
				organizationId: input.organizationId,
			});
			resolvedTransport = resolved?.providerType ?? null;
		} catch (error) {
			// Never the recipient address and never `from`: an assignment log
			// line must not become a PII sink. Provider + error name is enough
			// to tell "this cell is unroutable today" from "the resolver is
			// systematically throwing and the experiment record is empty".
			logWarn(
				`[sendAssignments] route resolution failed for cell provider ${destinationProvider}:`,
				error instanceof Error ? error.name : 'UnknownError'
			);
			resolvedTransport = null;
		}
		byProvider.set(destinationProvider, resolvedTransport);
	}
	return (destinationProvider) => byProvider.get(destinationProvider) ?? null;
}

/**
 * Org-scoped lookup of the assignment recorded for one send. Org-leading
 * index: a caller holding another tenant's send id still gets nothing.
 */
export const getAssignmentForSend = internalQuery({
	args: { organizationId: v.string(), sendId: v.string() },
	handler: async (ctx, args) =>
		await ctx.db
			.query('sendAssignments')
			.withIndex('by_org_send', (q) =>
				q.eq('organizationId', args.organizationId).eq('sendId', args.sendId)
			)
			.first(),
});

/**
 * Org-scoped, bounded cell/window read — the shape every later consumer uses.
 *
 * The window is a REQUIRED half-open `[since, until)`: every consumer of this
 * table (outcome buckets, the ramp controller's gates, the dashboard) reads a
 * bounded evaluation window, and an open-ended read of a per-recipient table
 * is the write-amplification hazard D16 exists to prevent.
 *
 * A malformed `cell` returns `[]` rather than scanning an empty index
 * partition: `cell` is a plain string in the schema, so the parse is the only
 * thing standing between a typo and a silently empty result set.
 */
export const listCellAssignments = internalQuery({
	args: {
		organizationId: v.string(),
		cell: v.string(),
		since: v.number(),
		until: v.number(),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		if (!isDeliverabilityCellKey(args.cell)) return [];
		// Convex `v.number()` is a float64: `NaN`/`Infinity` are valid arguments.
		// An unguarded NaN reaches `.take(NaN)` and makes the range bound
		// meaningless, so every numeric argument is checked before it is used.
		if (!Number.isFinite(args.since) || !Number.isFinite(args.until)) return [];
		const requested = args.limit;
		const limit =
			requested === undefined || !Number.isFinite(requested)
				? DEFAULT_CELL_PAGE_SIZE
				: Math.min(Math.max(Math.floor(requested), 1), MAX_CELL_PAGE_SIZE);
		return await ctx.db
			.query('sendAssignments')
			.withIndex('by_org_cell_time', (q) =>
				q
					.eq('organizationId', args.organizationId)
					.eq('cell', args.cell)
					.gte('assignedAt', args.since)
					.lt('assignedAt', args.until)
			)
			.take(limit);
	},
});

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
		// no-op forever: fall back to the real clock instead.
		const now = args.now !== undefined && Number.isFinite(args.now) ? args.now : Date.now();
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
