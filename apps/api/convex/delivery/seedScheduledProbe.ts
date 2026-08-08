/**
 * The SCHEDULED seed probe — placement evidence for the streams that have no
 * campaign to shadow (plan P4-7, issue #500).
 *
 * `delivery/seedShadowCopy.ts` measures the `campaign` cells by cloning a real
 * campaign envelope inside the transaction that enqueues it. The other two
 * governed streams have no equivalent moment: a transactional send is one
 * recipient's receipt and an automation step is one contact's drip, so there is
 * no bulk transaction to clone from and nothing to shadow. The plan's answer is
 * the second half of its own sentence — "on each campaign send (or ON A
 * SCHEDULE for transactional streams)" — and this module is that schedule: a
 * cron that mails one probe per connected seed per non-campaign stream, through
 * the SAME producer, pool, router and worker the stream's real mail uses.
 *
 * WHAT IT MEASURES, AND WHAT IT CANNOT. It measures the CELL: the stream axis
 * of the route (`messageType`), the arm the router resolved, the sending
 * identity, the authentication, and where the message landed. It does NOT
 * measure a real message's CONTENT, because there is no real message here to
 * clone — the body is a fixed, neutral service notification declared below.
 * That is the one honest gap between this probe and the campaign shadow copy,
 * and it is stated here rather than left for a reader to infer: a deployment
 * whose transactional templates are themselves filter-bait will still see a
 * clean probe. Placement is a TRIPWIRE for collapse (D17), and stream-wide
 * collapse — a route, a reputation, an authentication failure — is exactly what
 * this shape does catch.
 *
 * NOT COUNTABLE, BY CONSTRUCTION (D18). A probe carries NO `sendId`, so there
 * is no `transactionalSends` row; it is enqueued with NO `onComplete` and no
 * `sendRef` context, so the Send lifecycle — and with it every daily stat, every
 * `sendingReputation` event, every customer webhook and every contact activity
 * row — is never entered; and it writes NO `sendAssignments` row, so
 * `analytics/transportOutcomes.ts` records nothing against the cell's
 * denominators. Its only durable record is its probe-ledger row. The mutual
 * exclusion is asserted on the composition path by
 * `delivery/worker.ts#assertSeedShadowExclusion`, which now covers both envelope
 * kinds precisely because this module exists.
 *
 * D2 — ADDITIVE-ONLY. Zero seed mailboxes, no default sender, an unverified
 * sending domain or no configured route each make this a permanent no-op. It
 * never throws, never blocks a send, never nags, and gate 5 simply keeps
 * holding on the cells it has no evidence for, which costs the ramp nothing.
 *
 * SECURITY. The probe is addressed to an operator-owned seed mailbox and
 * carries no contact, no recipient PII and no campaign name — the only
 * identifier on the wire is the opaque probe id in `X-Owlat-Seed-Probe`, and
 * the RFC 8058 one-click target on the automation probe is minted in the
 * probe's own token namespace (`getSeedProbeListUnsubscribeHeader`), so it can
 * no more reach a contact record than the campaign shadow copy's can.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import type { DatabaseReader, MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { DeliverabilityStream } from '@owlat/shared/deliverabilityRouting';
import { loadSeedAccounts } from '../analytics/seedAccounts';
import { checkEmailDomainVerification } from '../domains/domains';
import { getOptional } from '../lib/env';
import { formatFromAddress } from '../lib/emailProviders/domainVerification';
import { toPaginationCursor } from '../lib/paginationCursor';
import { resolveSendRouteFromDb } from '../lib/sendProviders/route';
import { SEED_PROBE_RETENTION_MS } from '../schema/seedPlacement';
import { newSeedProbeId } from './seedShadowCopy';
import { transactionalEmailPool } from './workpool';

/**
 * The streams this schedule covers: every GOVERNED stream except the one that
 * already has a producer. `campaign` is deliberately absent — its probes come
 * from a shadow of a real send, which is strictly better evidence than a
 * synthetic body, and a second producer for that cell would double its volume
 * while making the sweep harder to read.
 *
 * Both members ride the SAME envelope kind (`transactional`) and differ exactly
 * where the real streams differ: `messageType` picks the route's stream axis,
 * and `emailPurpose` makes the automation probe marketing-shaped — which is
 * what obliges it to carry the RFC 8058 one-click pair, the single largest
 * filter-visible difference between the two streams.
 */
export const SCHEDULED_SEED_PROBE_STREAMS = ['transactional', 'automation'] as const;

type ScheduledSeedProbeStream = (typeof SCHEDULED_SEED_PROBE_STREAMS)[number];

/**
 * How often one (organization, stream) is probed.
 *
 * The CADENCE lives here, not in the cron interval: the cron ticks more often
 * than this so a deployment that was mid-page, unconfigured or without seeds at
 * the last due moment recovers within hours instead of waiting a whole period,
 * and this guard is what keeps the extra ticks free. It also makes the sweep
 * idempotent under the two ways a page can be re-run — a retried tick and an
 * organization split across two pages.
 */
export const SCHEDULED_SEED_PROBE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Seed accounts examined per tick, matching `analytics/seedRotationSweep.ts`. */
const SEED_ACCOUNT_PAGE_SIZE = 50;

/**
 * The probe's body: a neutral, plainly-labelled service notification.
 *
 * It goes to a mailbox the OPERATOR owns and nobody else, so the honest thing
 * is to say what it is rather than to imitate mail the deployment does not
 * actually send. The date makes each day's message distinct — a byte-identical
 * message repeated daily to the same handful of addresses is itself a pattern a
 * filter learns, which would make the instrument change what it measures.
 *
 * Pure: `now` is a parameter, and the same input gives the same message.
 */
export function buildScheduledSeedProbeMessage(
	stream: ScheduledSeedProbeStream,
	now: number
): { subject: string; htmlContent: string } {
	const day = new Date(now).toISOString().slice(0, 10);
	return {
		subject: `Delivery check for the ${stream} stream — ${day}`,
		htmlContent: [
			'<p>This is an automated delivery check.</p>',
			`<p>It was sent to a mailbox connected to this deployment as a placement seed, so that the ${stream} sending stream can be measured. No account, order or subscription is affected, and there is nothing to do.</p>`,
		].join(''),
	};
}

/**
 * When this (organization, stream) was last probed, or `null` for never.
 *
 * ONE INDEXED READ, not a page: the whole cadence key is in the index, so the
 * answer cannot start drifting once an organization accumulates probe rows —
 * the failure mode a bounded page plus a linear scan would have, and the same
 * reasoning that put the campaign probe set's idempotency key in an index.
 */
async function lastProbedAt(
	db: DatabaseReader,
	organizationId: string,
	stream: DeliverabilityStream
): Promise<number | null> {
	const newest = await db
		.query('seedPlacementProbes')
		.withIndex('by_org_stream_and_sent_at', (q) =>
			q.eq('organizationId', organizationId).eq('stream', stream)
		)
		.order('desc')
		.first();
	return newest?.sentAt ?? null;
}

/** The deployment's default sending identity, or `null` when none is set (D2). */
async function resolveProbeSender(ctx: MutationCtx): Promise<string | null> {
	const settings = await ctx.db.query('instanceSettings').first();
	const fromEmail = settings?.defaultFromEmail ?? getOptional('DEFAULT_FROM_EMAIL');
	if (!fromEmail) return null;
	// A probe from an UNVERIFIED domain measures the deployment's setup, not its
	// placement: it would be filtered on authentication alone and would teach
	// gate 5 that every cell had collapsed. Silence is the honest answer.
	const domainStatus = await checkEmailDomainVerification(ctx, fromEmail);
	if (!domainStatus.verified) return null;
	return formatFromAddress(fromEmail, settings?.defaultFromName ?? undefined);
}

/**
 * Mail one probe per connectable seed for one (organization, stream), inside
 * the caller's transaction.
 *
 * Returns the number enqueued; `0` covers every supported absence — not due
 * yet, no sender, no route, no seeds — and is never an error.
 */
async function probeStream(
	ctx: MutationCtx,
	args: {
		organizationId: string;
		stream: ScheduledSeedProbeStream;
		from: string;
		convexSiteUrl: string | undefined;
		now: number;
	}
): Promise<number> {
	const lastAt = await lastProbedAt(ctx.db, args.organizationId, args.stream);
	if (lastAt !== null && lastAt > args.now - SCHEDULED_SEED_PROBE_INTERVAL_MS) return 0;

	// An automation probe is MARKETING mail and must carry the RFC 8058 one-click
	// pair; the worker mints the probe-scoped one against this origin. Without it
	// the message would be materially different from the stream's real mail — so
	// the stream is skipped rather than measured with a message nobody sends.
	if (args.stream === 'automation' && args.convexSiteUrl === undefined) return 0;

	// CONNECTABLE seeds only — the exact set `analytics/seedProbePoller.ts` will
	// walk, for the same reason the shadow copy uses it: mailing a seed whose
	// credentials expired spends real volume on a message nothing can observe.
	const seeds = await loadSeedAccounts(ctx.db, args.organizationId, args.now, 'connectable');
	const [firstSeed] = seeds;
	if (firstSeed === undefined) return 0;

	// The stream's OWN route, resolved through the shipped seam every producer on
	// this path uses. Resolving it once per stream rather than per seed is safe:
	// the address context only steers the per-recipient mix, and a probe set is
	// one measurement of one cell, not a per-seed experiment.
	const route = await resolveSendRouteFromDb(ctx, args.stream, {
		to: firstSeed.address,
		from: args.from,
	});
	// No configured provider is a supported configuration, not an error: the real
	// stream cannot send either, so there is nothing to measure.
	if (!route) return 0;

	const message = buildScheduledSeedProbeMessage(args.stream, args.now);
	for (const seed of seeds) {
		const probeId = newSeedProbeId();
		const probeRef = await ctx.db.insert('seedPlacementProbes', {
			organizationId: args.organizationId,
			probeId,
			accountId: seed.accountId,
			provider: seed.provider,
			stream: args.stream,
			// No `campaignId` and no `abVariant`: a scheduled probe shadows no
			// campaign, and its cadence key is `by_org_stream_and_sent_at` instead.
			sentAt: args.now,
			expiresAt: args.now + SEED_PROBE_RETENTION_MS,
		});
		await transactionalEmailPool.enqueueAction(ctx, internal.delivery.worker.sendSingleEmail, {
			envelopeInput: {
				kind: 'transactional' as const,
				deliveryDomain: 'production' as const,
				// The cell's stream axis, stated rather than inferred: this is what
				// makes the governed router treat the probe as this stream's mail.
				messageType: args.stream,
				emailPurpose:
					args.stream === 'automation' ? ('marketing' as const) : ('transactional' as const),
				to: seed.address,
				from: args.from,
				providerType: route.providerType,
				...(route.ipPool !== undefined ? { ipPool: route.ipPool } : {}),
				template: message,
				organizationId: args.organizationId,
				...(args.convexSiteUrl !== undefined ? { convexSiteUrl: args.convexSiteUrl } : {}),
				...(args.stream === 'automation' ? { listUnsubscribe: true } : {}),
				seedProbeId: probeId,
				seedProbeRef: probeRef,
			},
		});
	}
	return seeds.length;
}

/**
 * One bounded page of the scheduled probe sweep.
 *
 * Pages the SEED ACCOUNTS rather than organizations, because there is no
 * organizations table to page and the seed set is the only place a deployment
 * declares that it wants to be measured at all — the same discovery
 * `analytics/seedRotationSweep.ts` and `analytics/seedProbePoller.ts` make. An
 * organization split across two pages is harmless: the cadence guard in
 * {@link probeStream} sees the rows the first page wrote.
 *
 * D16: cursor-paged and self-rescheduling, so no organization can be starved by
 * sorting last.
 */
export const sweepScheduledSeedProbes = internalMutation({
	args: { cursor: v.optional(v.string()) },
	handler: async (ctx, args) => {
		const now = Date.now();
		const page = await ctx.db
			.query('externalMailAccounts')
			.withIndex('by_purpose', (q) => q.eq('purpose', 'seed'))
			.paginate({
				cursor: toPaginationCursor(args.cursor),
				numItems: SEED_ACCOUNT_PAGE_SIZE,
			});

		// The organizations to probe are DISCOVERED from the seed accounts: there is
		// no organizations table to page, and a deployment with no seeds has
		// nothing to measure. `resolveProbeSender` reads the deployment-wide
		// settings singleton, so it is resolved once per page rather than per
		// organization.
		const organizationIds = [...new Set(page.page.map((account) => account.organizationId))];
		const from = organizationIds.length > 0 ? await resolveProbeSender(ctx) : null;
		let enqueued = 0;
		if (from !== null) {
			const convexSiteUrl = getOptional('CONVEX_SITE_URL') || undefined;
			for (const organizationId of organizationIds) {
				for (const stream of SCHEDULED_SEED_PROBE_STREAMS) {
					enqueued += await probeStream(ctx, {
						organizationId,
						stream,
						from,
						convexSiteUrl,
						now,
					});
				}
			}
		}

		if (!page.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.delivery.seedScheduledProbe.sweepScheduledSeedProbes,
				{ cursor: page.continueCursor }
			);
		}

		return { enqueued, examined: page.page.length, done: page.isDone };
	},
});
