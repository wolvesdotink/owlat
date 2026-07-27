import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	destinationProviderValidator,
	mailStreamValidator,
	seedPlacementValidator,
} from '../delivery/deliverabilityValidators';

/**
 * Retention bound for the probe ledger (D16 — write amplification is a design
 * constraint). Lives next to the `expiresAt` column and the cleanup cron it
 * bounds, so the three can never drift apart.
 */
export const SEED_PROBE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

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
		stream: mailStreamValidator,
		/**
		 * Which arm actually carried the shadow copy, so placement is
		 * attributable. Written by the worker AFTER dispatch resolves the route —
		 * absent means the probe has not been dispatched yet (or never was), which
		 * is why it is optional rather than guessed at enqueue time.
		 */
		transportArm: v.optional(v.union(v.literal('own'), v.literal('reference'))),
		/** Set when the worker handed the shadow copy to a provider. */
		dispatchedAt: v.optional(v.number()),
		/** Present when the probe shadowed a campaign send. */
		campaignId: v.optional(v.id('campaigns')),
		/**
		 * A/B arm the probe shadowed. The two arms of an A/B campaign are
		 * DIFFERENT MESSAGES, so each gets its own probe set and its own reading;
		 * this is part of the per-campaign idempotency key.
		 */
		abVariant: v.optional(v.union(v.literal('A'), v.literal('B'))),
		sentAt: v.number(),

		/**
		 * Set by the poller. Absent ⇒ not yet looked for. `missing` ⇒ the poller
		 * walked every folder and did not find it (the most alarming outcome, and
		 * the one no other signal surfaces at all).
		 */
		placement: v.optional(seedPlacementValidator),
		/** Remote folder / label NAME the probe was found in. Never its contents. */
		folderName: v.optional(v.string()),
		/** Gmail tab (Promotions, Updates, …) when `placement === 'category'`. */
		categoryLabel: v.optional(v.string()),
		classifiedAt: v.optional(v.number()),

		// ── Probe hygiene (a seed that never opens anything trains the provider
		// to distrust us). Timestamps only; no mailbox content is recorded.
		markedReadAt: v.optional(v.number()),
		clickedAt: v.optional(v.number()),
		/** Set when the probe's RFC 8058 one-click target was exercised. */
		unsubscribedAt: v.optional(v.number()),

		/** Retention bound — the cleanup cron drops rows past this (D16). */
		expiresAt: v.number(),
	})
		.index('by_probe_id', ['probeId'])
		// Org-scoped idempotency for the per-campaign probe set (defense in depth
		// at the poller/scheduler boundary — a probe row is only ever reachable
		// through the org that owns it).
		.index('by_org_and_campaign', ['organizationId', 'campaignId'])
		.index('by_org_and_sent_at', ['organizationId', 'sentAt'])
		.index('by_org_provider_and_sent_at', ['organizationId', 'provider', 'sentAt'])
		.index('by_account_and_sent_at', ['accountId', 'sentAt'])
		.index('by_expires_at', ['expiresAt']),
};
