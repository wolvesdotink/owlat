import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	destinationProviderValidator,
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
		/**
		 * The cell's stream axis. This piece only ever drops a probe on a CAMPAIGN
		 * send, so the column is narrowed to what is actually produced (D20 — no
		 * speculative seams). Widening it to the full `automation` /
		 * `transactional` union is a purely additive schema change for whichever
		 * piece ships a scheduled transactional probe.
		 */
		stream: v.literal('campaign'),
		/**
		 * Which arm actually carried the shadow copy, so placement is
		 * attributable. Written by the worker AFTER dispatch resolves the route —
		 * absent means the probe has not been dispatched yet (or never was), which
		 * is why it is optional rather than guessed at enqueue time.
		 */
		transportArm: v.optional(v.union(v.literal('own'), v.literal('reference'))),
		/**
		 * Set when the worker actually handed the shadow copy to a provider.
		 * Everything downstream keys off THIS, never off `sentAt`: a probe that is
		 * still sitting in the rate-limited workpool, was deferred by the governed
		 * router, or was suppressed has not been mailed, and "not mailed" is not a
		 * filter verdict.
		 */
		dispatchedAt: v.optional(v.number()),
		/**
		 * The NEVER-DISPATCHED disposition — deliberately not a `placement`.
		 *
		 * Set by the abandonment sweep on a probe that was enqueued but never
		 * handed to a transport within the dispatch horizon (warming caps, a
		 * deferral, a suppressed recipient). Such a probe is NON-EVIDENCE: it is
		 * never classified, never rolled up, and can never become the `missing`
		 * reading that feeds the collapse tripwire. Recording it explicitly is
		 * what keeps our own queue from manufacturing gate 5's alarm.
		 */
		notDispatchedAt: v.optional(v.number()),
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
		// Org-scoped idempotency key for the per-campaign, per-A/B-arm probe set.
		// The variant is part of the INDEX, not of a linear scan over a bounded
		// page, so the answer cannot change with the number of probes a campaign
		// has accumulated (defense in depth at the scheduler boundary too — a
		// probe row is only ever reachable through the org that owns it).
		.index('by_org_campaign_and_variant', ['organizationId', 'campaignId', 'abVariant'])
		.index('by_org_and_sent_at', ['organizationId', 'sentAt'])
		// Poller work selection: UNCLASSIFIED, DISPATCHED probes only, oldest
		// dispatch first. `placement` leads the range fields on purpose. Keyed on
		// `(accountId, dispatchedAt)` alone, a bounded page of one account's probes
		// fills up with rows the poller already classified — they stay in the range
		// for the whole 90-day retention — and the account goes permanently dark
		// after roughly one page. `eq('placement', undefined)` retires a row from
		// the range the moment it is classified, so the page is always outstanding
		// work.
		.index('by_account_placement_and_dispatched_at', ['accountId', 'placement', 'dispatchedAt'])
		// The abandonment sweep: probes not yet written off AND never dispatched.
		// `undefined` is an ordinary index value in Convex, so both are exact
		// matches; a row leaves the range the moment it is written off, which is
		// what keeps the batched sweep making progress.
		.index('by_undispatched_watch', ['notDispatchedAt', 'dispatchedAt', 'sentAt'])
		.index('by_expires_at', ['expiresAt']),
};
