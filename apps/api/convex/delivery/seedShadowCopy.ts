/**
 * Seed shadow copy — the SEND half of the seed-placement probe (D18).
 *
 * A shadow copy goes to an operator-owned seed mailbox through the IDENTICAL
 * composer and the IDENTICAL transport as the real send it mirrors: same
 * `sendSingleEmail` worker, same campaign composer, same `from`, same
 * `providerType`/`ipPool`, same template bytes. Only three things change, and
 * each is forced by a rule in the plan:
 *
 *   1. `to` / `contactInfo.email` — the seed address instead of a subscriber.
 *   2. `contactId` and `emailSendId` are STRIPPED. `emailSendId` is what makes
 *      a Send countable: without it there is no `emailSends` row, no
 *      `sendRef`, hence no workpool `onComplete` → no Send lifecycle → no
 *      campaign stat-shard bump and no `sendingReputation` event. That is the
 *      D18 exclusion, enforced by construction rather than by a filter
 *      somewhere downstream. Dropping `contactId` additionally keeps a real
 *      subscriber's unsubscribe/preference HMAC URLs out of a mailbox that is
 *      not theirs. As a consequence the probe carries no tracking pixel and no
 *      wrapped links — a probe open must never land in a campaign's open rate.
 *   3. `seedProbeId` is added — the `X-Owlat-Seed-Probe` header the IMAP
 *      poller looks for. Opaque; no recipient or campaign PII.
 *
 * Everything else is copied verbatim, so the shadow copy is authenticated,
 * signed, and routed exactly like the mail it is measuring — which is the only
 * reason its placement means anything.
 *
 * D2: zero seed mailboxes is a supported configuration. `enqueueSeedShadowCopies`
 * with an empty seed list enqueues nothing and reports `{ enqueued: 0 }`; it
 * never throws and never affects the real send.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { campaignEmailPool } from './workpool';
import { envelopeInputValidator, type WorkerEnvelopeInput } from './workerEnvelope';
import { loadSeedAccounts } from '../analytics/seedPlacement';

export type CampaignEnvelopeInput = Extract<WorkerEnvelopeInput, { kind: 'campaign' }>;

/** Retention bound for the probe ledger (D16 — write amplification is a design constraint). */
export const SEED_PROBE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Build the shadow-copy envelope from the REAL send's envelope.
 *
 * Pure: same input, same output, no clock and no db. The real envelope is
 * never mutated.
 */
export function buildSeedShadowEnvelope(
	base: CampaignEnvelopeInput,
	seed: { address: string; probeId: string }
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
	};
	if (base.deliveryDomain !== undefined) shadow.deliveryDomain = base.deliveryDomain;
	if (base.replyTo !== undefined) shadow.replyTo = base.replyTo;
	if (base.providerType !== undefined) shadow.providerType = base.providerType;
	if (base.ipPool !== undefined) shadow.ipPool = base.ipPool;
	if (base.audienceType !== undefined) shadow.audienceType = base.audienceType;
	if (base.campaignId !== undefined) shadow.campaignId = base.campaignId;
	if (base.organizationId !== undefined) shadow.organizationId = base.organizationId;
	if (base.listId !== undefined) shadow.listId = base.listId;
	// `siteUrl` / `convexSiteUrl` / `trackingBaseUrl` / `viewInBrowserUrl` are
	// deliberately dropped: every one of them is only consumed together with a
	// `contactId` or an `emailSendId`, both of which a shadow copy does not have.
	return shadow;
}

/**
 * True when this envelope is a seed shadow copy. A shadow copy must never be
 * countable, and a countable Send must never carry the probe header — this is
 * the invariant both sides are checked against.
 */
export function isSeedShadowEnvelope(envelope: WorkerEnvelopeInput): boolean {
	return envelope.kind === 'campaign' && envelope.seedProbeId !== undefined;
}

/**
 * Enqueue one shadow copy per seed mailbox and write its ledger row, inside
 * the caller's transaction. Deliberately enqueued WITHOUT the `onComplete` /
 * `sendRef` wiring every real Send carries: there is no Send to complete, so
 * the lifecycle (and with it every analytics and reputation denominator) is
 * never entered.
 */
export const enqueueSeedShadowCopies = internalMutation({
	args: {
		organizationId: v.string(),
		stream: v.union(v.literal('campaign'), v.literal('automation'), v.literal('transactional')),
		transportArm: v.union(v.literal('own'), v.literal('reference')),
		envelopeInput: envelopeInputValidator,
		seeds: v.array(
			v.object({
				accountId: v.id('externalMailAccounts'),
				address: v.string(),
				provider: v.union(
					v.literal('gmail'),
					v.literal('microsoft'),
					v.literal('yahoo'),
					v.literal('apple'),
					v.literal('other')
				),
				probeId: v.string(),
			})
		),
		now: v.number(),
	},
	handler: async (ctx, args) => {
		const base = args.envelopeInput;
		// Only campaign-shaped envelopes are shadowed; a transactional stream is
		// probed on a schedule with its own campaign-shaped probe envelope.
		if (base.kind !== 'campaign' || args.seeds.length === 0) {
			return { enqueued: 0 };
		}

		for (const seed of args.seeds) {
			const shadow = buildSeedShadowEnvelope(base, seed);
			await ctx.db.insert('seedPlacementProbes', {
				organizationId: args.organizationId,
				probeId: seed.probeId,
				accountId: seed.accountId,
				provider: seed.provider,
				stream: args.stream,
				transportArm: args.transportArm,
				...(base.campaignId ? { campaignId: base.campaignId } : {}),
				sentAt: args.now,
				expiresAt: args.now + SEED_PROBE_RETENTION_MS,
			});
			await campaignEmailPool.enqueueAction(ctx, internal.delivery.worker.sendSingleEmail, {
				envelopeInput: shadow,
			});
		}

		return { enqueued: args.seeds.length };
	},
});

/**
 * Generate an opaque probe id. Randomness lives here, at the edge — the pure
 * core never draws one.
 */
function newProbeId(): string {
	return `sp_${crypto.randomUUID().replace(/-/g, '').slice(0, 22)}`;
}

/**
 * Drop one shadow copy per seed mailbox for a campaign that is going out.
 *
 * Scheduled (never inline) by the campaign send walker, and IDEMPOTENT per
 * campaign: the walker fans out over pages and time zones, so this checks the
 * ledger for an existing probe before doing anything. With no seed mailboxes —
 * the default — it is a no-op that reports `{ enqueued: 0 }`; it cannot fail
 * the campaign it is measuring.
 */
export const probeCampaignSend = internalMutation({
	args: {
		campaignId: v.id('campaigns'),
		organizationId: v.string(),
		from: v.string(),
		replyTo: v.optional(v.string()),
		subject: v.string(),
		htmlContent: v.string(),
		providerType: v.optional(v.string()),
		ipPool: v.optional(v.string()),
		audienceType: v.optional(v.union(v.literal('topic'), v.literal('segment'))),
		listId: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('seedPlacementProbes')
			.withIndex('by_campaign', (q) => q.eq('campaignId', args.campaignId))
			.first();
		if (existing) return { enqueued: 0 };

		const now = Date.now();
		const seeds = await loadSeedAccounts(ctx.db, args.organizationId, now);
		if (seeds.length === 0) return { enqueued: 0 };

		const base: CampaignEnvelopeInput = {
			kind: 'campaign',
			deliveryDomain: 'production',
			to: '',
			from: args.from,
			template: { subject: args.subject, htmlContent: args.htmlContent },
			contactInfo: { email: '' },
			campaignId: args.campaignId,
			organizationId: args.organizationId,
			...(args.replyTo !== undefined ? { replyTo: args.replyTo } : {}),
			...(args.providerType !== undefined ? { providerType: args.providerType } : {}),
			...(args.ipPool !== undefined ? { ipPool: args.ipPool } : {}),
			...(args.audienceType !== undefined ? { audienceType: args.audienceType } : {}),
			...(args.listId !== undefined ? { listId: args.listId } : {}),
		};

		for (const seed of seeds) {
			const probeId = newProbeId();
			const shadow = buildSeedShadowEnvelope(base, { address: seed.address, probeId });
			await ctx.db.insert('seedPlacementProbes', {
				organizationId: args.organizationId,
				probeId,
				accountId: seed.accountId,
				provider: seed.provider,
				stream: 'campaign',
				transportArm: args.providerType === 'mta' ? 'own' : 'reference',
				campaignId: args.campaignId,
				sentAt: now,
				expiresAt: now + SEED_PROBE_RETENTION_MS,
			});
			await campaignEmailPool.enqueueAction(ctx, internal.delivery.worker.sendSingleEmail, {
				envelopeInput: shadow,
			});
		}

		return { enqueued: seeds.length };
	},
});
