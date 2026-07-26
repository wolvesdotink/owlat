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
 *     is defensive: an unresolvable organization or an unknown transport
 *     degrades to "no row" (or `other`), never a throw.
 *   - Every read is org-leading. `sendAssignments` is cell-keyed, and a
 *     cell-keyed table readable across tenants would be a security defect.
 *   - O(N) narrow writes for N recipients, and no unbounded table read
 *     anywhere on this path (ADR-0042's post-mortem).
 *
 * What this piece does NOT do: choose the arm. Today the row records what the
 * SHIPPED router already decided (`mta` → `own`, anything else → `reference`).
 * The deterministic per-recipient hash, stratification and the calibration
 * slice arrive with the mix controller and will bump `mixVersion`.
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { extractDomainOrNull } from '@owlat/shared';
import {
	destinationProviderForDomain,
	type DestinationProviderKey,
} from '@owlat/shared/deliverabilityRouting';
import {
	formatCellKey,
	type DeliverabilityCellKey,
	type DeliverabilityStream,
} from '@owlat/shared/deliverabilityCell';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';

/** Assignment rows age out after 90 days (D16 — write amplification is bounded). */
export const SEND_ASSIGNMENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Rows deleted per retention tick; the sweep re-schedules itself while full. */
export const SEND_ASSIGNMENT_CLEANUP_BATCH_SIZE = 200;

/**
 * Mix version 0 = "no controller-driven mix in effect". The row records the
 * shipped router's own decision. The mix controller writes version >= 1.
 */
export const ROUTER_ONLY_MIX_VERSION = 0;

/** The own-MTA transport key. Every other catalog transport is a reference arm. */
const OWN_TRANSPORT_KEY = 'mta';

export type SendAssignmentArm = 'own' | 'reference';
export type SendAssignmentKind = 'campaign' | 'transactional';

/**
 * Pure: which arm a transport key belongs to. The own MTA is the `own` arm;
 * every other catalog transport (SES, Resend, SMTP relay, plugin transports)
 * is the `reference` arm we measure against.
 */
export function armForTransport(transport: string): SendAssignmentArm {
	return transport === OWN_TRANSPORT_KEY ? 'own' : 'reference';
}

/**
 * Resolve destination providers for a batch of recipient addresses, reusing
 * the SHIPPED MX-learned classifier: an unexpired `destinationProviderDomains`
 * observation wins, otherwise the conservative address-domain fallback. One
 * indexed point read per DISTINCT domain (memoized across the batch), never a
 * table scan and never a second domain map.
 *
 * Exported so the write-amplification regression can assert the read count
 * BEHAVIOURALLY (k distinct domains ⇒ exactly k `by_org_domain` reads),
 * rather than only inspecting the source for a memo map.
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
		const domain = extractDomainOrNull(email);
		if (domain === null) {
			byEmail.set(email, 'other');
			continue;
		}
		let provider = byDomain.get(domain);
		if (provider === undefined) {
			const learned = await ctx.db
				.query('destinationProviderDomains')
				.withIndex('by_org_domain', (q) =>
					q.eq('organizationId', organizationId).eq('domain', domain)
				)
				.first();
			provider =
				learned && learned.expiresAt >= now
					? learned.destinationProvider
					: destinationProviderForDomain(domain);
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

export interface RecordSendAssignmentsInput {
	/**
	 * `null` is accepted alongside `undefined`: an optional string returned by
	 * a Convex query arrives as `null` at the call site.
	 */
	readonly organizationId: string | null | undefined;
	readonly stream: DeliverabilityStream;
	readonly sendKind: SendAssignmentKind;
	/** The transport the router resolved for this enqueue (`null` = unresolved). */
	readonly transport: string | null | undefined;
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
	const transport = input.transport;
	if (transport == null || transport === '') return 0;
	const organizationId = await resolveAssignmentOrganizationId(ctx, input.organizationId);
	if (organizationId === null) return 0;

	const now = input.now ?? Date.now();
	const providers = await destinationProvidersForEmails(
		ctx,
		organizationId,
		input.recipients.map((recipient) => recipient.email),
		now
	);
	const arm = armForTransport(transport);
	const mixVersion = input.mixVersion ?? ROUTER_ONLY_MIX_VERSION;
	const isCalibration = input.isCalibration ?? false;

	let written = 0;
	for (const recipient of input.recipients) {
		const destinationProvider = providers.get(recipient.email) ?? 'other';
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
			arm,
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

/** Org-scoped, bounded cell/time window read — the shape every later consumer uses. */
export const listCellAssignments = internalQuery({
	args: {
		organizationId: v.string(),
		cell: v.string(),
		since: v.optional(v.number()),
		until: v.optional(v.number()),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
		return await ctx.db
			.query('sendAssignments')
			.withIndex('by_org_cell_time', (q) => {
				const scoped = q.eq('organizationId', args.organizationId).eq('cell', args.cell);
				if (args.since !== undefined && args.until !== undefined) {
					return scoped.gte('assignedAt', args.since).lt('assignedAt', args.until);
				}
				if (args.since !== undefined) return scoped.gte('assignedAt', args.since);
				if (args.until !== undefined) return scoped.lt('assignedAt', args.until);
				return scoped;
			})
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
		const cutoff = (args.now ?? Date.now()) - SEND_ASSIGNMENT_RETENTION_MS;
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
