/**
 * Generic per-provider sending-domain identity (D7).
 *
 * Its own schema sibling rather than another entry in `schema/domains.ts` or
 * `schema/delivery.ts`: both of those sit at the ~500 LOC split threshold
 * CONVENTIONS.md sets, and this is the sanctioned escape hatch for that.
 *
 * Spread into `defineSchema()` from schema.ts via `...relayIdentitiesTables`,
 * and registered in `lib/tenantTables.ts` (org-scoped business data, so a
 * tenant wipe must take it with the org).
 */

import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const relayIdentitiesTables = {
	// D7: the sibling-table pattern (`sendingDomainMtaIdentities` /
	// `sendingDomainSesIdentities`) stops at two. A third per-provider sibling
	// does not scale — every provider after SES shares this one table,
	// discriminated by `providerKind`. The two existing siblings stay FROZEN
	// (post-launch immutability): no data moves, and their adapters keep
	// reading and writing them unchanged.
	//
	// Written by the sending-domain provider adapters registered in
	// `domains/providers/` (see `SENDING_DOMAIN_PROVIDERS`); read by the
	// relay-verification seam (`lib/sendProviders/relayDomainVerification.ts`)
	// through the provider that owns the row.
	sendingDomainRelayIdentities: defineTable({
		// BetterAuth org id. Org-LEADING on both caller-reachable indexes below,
		// so a provider/domain lookup can never cross tenants.
		organizationId: v.string(),
		// Lowercased sending domain. Deliberately the domain STRING rather than
		// an `Id<'domains'>`: a relay identity can exist for a domain whose
		// primary provider row is owned by another provider entirely, and the
		// verification seam looks up by name.
		domain: v.string(),
		// A plain string, not a closed union: new relay kinds are then purely
		// ADDITIVE (D7), the same choice every other hot-path column already
		// makes (`sendAssignments.transport`, `emailSends.providerType`,
		// `providerHealth.providerType`).
		providerKind: v.string(),
		// The named transport instance this identity was registered with
		// (`<kind>#<instanceKey>`); absent = the deployment-default instance.
		transportInstanceKey: v.optional(v.string()),
		// Provider-side verification lifecycle. A status string, not a boolean,
		// so it is exempt from the `is*` naming rule.
		status: v.union(
			v.literal('unverified'),
			v.literal('pending_dns'),
			v.literal('verified'),
			v.literal('failed')
		),
		spf: v.optional(v.object({ isValid: v.boolean(), error: v.optional(v.string()) })),
		dkim: v.optional(v.object({ isValid: v.boolean(), error: v.optional(v.string()) })),
		// Feeds the D5 return-path probe short-circuit: a provider that already
		// told us the custom return-path domain is verified saves the probe.
		isCustomReturnPathVerified: v.optional(v.boolean()),
		// JSON-blob version sibling for `providerDetails`, per CONVENTIONS.md
		// "Schema evolution". Bump `CURRENT_RELAY_IDENTITY_PROVIDER_DETAILS_VERSION`
		// in `lib/constants.ts` when the blob shape changes; readers branch on
		// the stored value.
		providerDetailsVersion: v.optional(v.number()),
		// Provider-specific extras (DNS record sets, provider identity ids, …)
		// as versioned JSON. Deliberately opaque: a column per provider quirk is
		// the sibling-table problem again, one level down.
		providerDetails: v.optional(v.string()),
		lastCheckedAt: v.number(),
		nextCheckDueAt: v.optional(v.number()),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		// The identity lookup: one row per (org, domain, provider).
		.index('by_org_domain_provider', ['organizationId', 'domain', 'providerKind'])
		// Operator/dashboard reads: "which of this org's domains are verified at
		// this relay?"
		.index('by_org_provider_status', ['organizationId', 'providerKind', 'status'])
		// The re-check scheduler. Deliberately NOT org-leading: it is a
		// deployment-wide due-work sweep, exactly like `sendAssignments`'
		// `by_assigned_at` retention index, and it exposes no tenant data to a
		// caller-reachable read.
		.index('by_next_check_due', ['nextCheckDueAt']),
};
