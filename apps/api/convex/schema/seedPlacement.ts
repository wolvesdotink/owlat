import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { destinationProviderValidator } from '../delivery/deliverabilityValidators';

/**
 * Seed mailbox placement probe tables — the standalone (no-third-party)
 * placement signal, gate 5 of the deliverability controller.
 *
 * A seed mailbox is an ORDINARY connected external account
 * (`externalMailAccounts`, schema/mail.ts) tagged `purpose: 'seed'` — there is
 * no second credential model and no second IMAP client. This file adds only
 * the probe LEDGER: one row per shadow copy, carrying where it was found.
 *
 * D17 — read as a tripwire, not a gauge. Rows are raw observations; every
 * verdict derived from them is a STATUS (see `@owlat/shared/seedPlacement`).
 * D18 — a shadow copy is NOT a send: these rows are the only record of it, and
 * no `emailSends` / `transactionalSends` row, campaign stat shard, or
 * `sendingReputation` event is ever written for one.
 *
 * Spread into `defineSchema()` from schema.ts via `...seedPlacementTables`.
 */
export const seedPlacementTables = {
	seedPlacementProbes: defineTable({
		organizationId: v.string(),
		/**
		 * Opaque probe id carried in the `X-Owlat-Seed-Probe` header of the
		 * shadow copy — the join key between the send and the IMAP observation.
		 * Never contains a recipient address, contact id, or campaign name.
		 */
		probeId: v.string(),
		/** The seed mailbox this copy was addressed to. */
		accountId: v.id('externalMailAccounts'),
		/** Mailbox provider of the seed account (the cell's destination axis). */
		provider: destinationProviderValidator,
		/** The cell's stream axis — which mail stream this probe measures. */
		stream: v.union(v.literal('campaign'), v.literal('automation'), v.literal('transactional')),
		/** Which arm carried the shadow copy, so placement is attributable. */
		transportArm: v.union(v.literal('own'), v.literal('reference')),
		/** Present when the probe shadowed a campaign send. */
		campaignId: v.optional(v.id('campaigns')),
		sentAt: v.number(),

		/**
		 * Set by the poller. Absent ⇒ not yet looked for. `missing` ⇒ the poller
		 * walked every folder and did not find it (the most alarming outcome, and
		 * the one no other signal surfaces at all).
		 */
		placement: v.optional(
			v.union(v.literal('inbox'), v.literal('category'), v.literal('spam'), v.literal('missing'))
		),
		/** Remote folder / label NAME the probe was found in. Never its contents. */
		folderName: v.optional(v.string()),
		/** Gmail tab (Promotions, Updates, …) when `placement === 'category'`. */
		categoryLabel: v.optional(v.string()),
		classifiedAt: v.optional(v.number()),

		// ── Probe hygiene (a seed that never opens anything trains the provider
		// to distrust us). Timestamps only; no mailbox content is recorded.
		markedReadAt: v.optional(v.number()),
		clickedAt: v.optional(v.number()),

		/** Retention bound — the cleanup cron drops rows past this (D16). */
		expiresAt: v.number(),
	})
		.index('by_probe_id', ['probeId'])
		.index('by_campaign', ['campaignId'])
		.index('by_org_and_sent_at', ['organizationId', 'sentAt'])
		.index('by_org_provider_and_sent_at', ['organizationId', 'provider', 'sentAt'])
		.index('by_account_and_sent_at', ['accountId', 'sentAt'])
		.index('by_expires_at', ['expiresAt']),
};
