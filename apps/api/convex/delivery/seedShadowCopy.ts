/**
 * Seed shadow copy — the SEND half of the seed-placement probe (D18).
 *
 * A shadow copy goes to an operator-owned seed mailbox through the IDENTICAL
 * composer and the IDENTICAL transport as the real send it mirrors: it is
 * CLONED from a real campaign envelope inside the very transaction that
 * enqueues that campaign's mail (`delivery/enqueue.ts`), so there is exactly
 * one construction site and no second, hand-rolled envelope to drift from it.
 * Same `sendSingleEmail` worker, same composer, same `from`, same
 * `providerType`/`ipPool`, same template bytes, same tracking pixel and
 * wrapped links, same RFC 8058 one-click pair.
 *
 * Only three things change, and each is forced by a rule in the plan:
 *
 *   1. `to` / `contactInfo` — the seed address instead of a subscriber.
 *   2. `contactId` and `emailSendId` are STRIPPED. `emailSendId` is what makes
 *      a Send countable: without it there is no `emailSends` row, no workpool
 *      `onComplete` -> no Send lifecycle -> no campaign stat-shard bump and no
 *      `sendingReputation` event. That is the D18 exclusion, enforced by
 *      construction rather than by a filter somewhere downstream. Dropping
 *      `contactId` additionally keeps a real subscriber's unsubscribe HMAC out
 *      of a mailbox that is not theirs — the probe carries a PROBE-SCOPED
 *      one-click target and PROBE-SCOPED tracking URLs instead, and neither
 *      resolves to anything countable (see `delivery/worker.ts`).
 *   3. `seedProbeId` + `seedProbeRef` are added — the `X-Owlat-Seed-Probe`
 *      header the IMAP poller looks for, and the probe's durable ledger row.
 *      The header value is opaque; no recipient or campaign PII.
 *
 * D2: zero seed mailboxes is a supported configuration. With an empty seed
 * list this enqueues nothing and reports `{ enqueued: 0 }`; it never throws
 * and never affects the real send.
 */

import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { campaignEmailPool } from './workpool';
import type { WorkerEnvelopeInput } from './workerEnvelope';
import { loadSeedAccounts } from '../analytics/seedPlacement';
import { SEED_PROBE_RETENTION_MS } from '../schema/seedPlacement';

export type CampaignEnvelopeInput = Extract<WorkerEnvelopeInput, { kind: 'campaign' }>;

type MailStream = 'campaign' | 'automation' | 'transactional';

/**
 * Build the shadow-copy envelope from the REAL send's envelope.
 *
 * Pure: same input, same output, no clock and no db. The real envelope is
 * never mutated.
 */
export function buildSeedShadowEnvelope(
	base: CampaignEnvelopeInput,
	seed: { address: string; probeId: string; probeRef: Id<'seedPlacementProbes'> }
): CampaignEnvelopeInput {
	// Explicitly rebuilt (not spread-and-delete) so a future field added to the
	// campaign envelope has to be considered here rather than silently leaking
	// a subscriber-scoped value into an operator mailbox.
	const shadow: CampaignEnvelopeInput = {
		kind: 'campaign',
		to: seed.address,
		from: base.from,
		template: base.template,
		contactInfo: { email: seed.address },
		seedProbeId: seed.probeId,
		seedProbeRef: seed.probeRef,
	};
	if (base.deliveryDomain !== undefined) shadow.deliveryDomain = base.deliveryDomain;
	if (base.replyTo !== undefined) shadow.replyTo = base.replyTo;
	if (base.providerType !== undefined) shadow.providerType = base.providerType;
	if (base.ipPool !== undefined) shadow.ipPool = base.ipPool;
	if (base.audienceType !== undefined) shadow.audienceType = base.audienceType;
	if (base.campaignId !== undefined) shadow.campaignId = base.campaignId;
	if (base.organizationId !== undefined) shadow.organizationId = base.organizationId;
	if (base.listId !== undefined) shadow.listId = base.listId;
	// Kept so the shadow carries the same wire features a subscriber's copy
	// does — the one-click header pair and the tracking pixel / wrapped links
	// are exactly what a filter weighs. Both are keyed by the opaque probe id,
	// so neither can reach a contact record or a campaign denominator.
	if (base.convexSiteUrl !== undefined) shadow.convexSiteUrl = base.convexSiteUrl;
	if (base.trackingBaseUrl !== undefined) shadow.trackingBaseUrl = base.trackingBaseUrl;
	// `siteUrl` (the in-body unsubscribe/preference footer) and
	// `viewInBrowserUrl` (a contact-scoped archive token) are deliberately
	// dropped: both are only meaningful with a `contactId`, which a shadow copy
	// does not have. This is the piece's one residual wire delta from a real
	// send, and it is documented on the card.
	return shadow;
}

/**
 * True when this envelope is a seed shadow copy. A shadow copy must never be
 * countable, and a countable Send must never carry the probe header — the
 * invariant is ASSERTED on the composition path by
 * `delivery/worker.ts#assertSeedShadowExclusion`.
 */
export function isSeedShadowEnvelope(envelope: WorkerEnvelopeInput): boolean {
	return envelope.kind === 'campaign' && envelope.seedProbeId !== undefined;
}

/**
 * Generate an opaque probe id. Randomness lives here, at the edge — the pure
 * core never draws one.
 */
function newProbeId(): string {
	return `sp_${crypto.randomUUID().replace(/-/g, '').slice(0, 22)}`;
}

/**
 * Enqueue one shadow copy per seed mailbox and write its ledger row, INSIDE
 * the caller's transaction (the campaign enqueue mutation).
 *
 * Deliberately enqueued WITHOUT the `onComplete` / `sendRef` wiring every real
 * Send carries: there is no Send to complete, so the lifecycle — and with it
 * every analytics and reputation denominator — is never entered.
 *
 * IDEMPOTENT per (organization, campaign, A/B variant): the campaign walker
 * fans out over pages and time zones and calls this once per page, so the
 * ledger is checked first. The variant is part of the key because the two arms
 * of an A/B campaign are DIFFERENT MESSAGES and each deserves its own reading.
 */
export async function enqueueSeedShadowCopies(
	ctx: MutationCtx,
	args: {
		organizationId: string;
		campaignId: Id<'campaigns'>;
		abVariant?: 'A' | 'B';
		stream: MailStream;
		base: CampaignEnvelopeInput;
		now: number;
	}
): Promise<{ enqueued: number }> {
	const existing = await ctx.db
		.query('seedPlacementProbes')
		.withIndex('by_org_and_campaign', (q) =>
			q.eq('organizationId', args.organizationId).eq('campaignId', args.campaignId)
		)
		.take(200);
	if (existing.some((row) => row.abVariant === args.abVariant)) return { enqueued: 0 };

	const seeds = await loadSeedAccounts(ctx.db, args.organizationId, args.now);
	if (seeds.length === 0) return { enqueued: 0 };

	for (const seed of seeds) {
		const probeId = newProbeId();
		const probeRef = await ctx.db.insert('seedPlacementProbes', {
			organizationId: args.organizationId,
			probeId,
			accountId: seed.accountId,
			provider: seed.provider,
			stream: args.stream,
			campaignId: args.campaignId,
			...(args.abVariant !== undefined ? { abVariant: args.abVariant } : {}),
			sentAt: args.now,
			expiresAt: args.now + SEED_PROBE_RETENTION_MS,
		});
		const shadow = buildSeedShadowEnvelope(args.base, {
			address: seed.address,
			probeId,
			probeRef,
		});
		await campaignEmailPool.enqueueAction(ctx, internal.delivery.worker.sendSingleEmail, {
			envelopeInput: shadow,
		});
	}

	return { enqueued: seeds.length };
}
