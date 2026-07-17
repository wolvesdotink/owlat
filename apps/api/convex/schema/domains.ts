import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { dmarcPolicyValidator } from '../domains/dmarc';
import { dnsRecordsValidator, verificationResultsValidator } from '../lib/convexValidators';

/**
 * Domain tables — sending domains + per-provider identities + tracking domains.
 * Per-domain reputation now lives in the unified `sendingReputation` table in
 * schema/delivery.ts (ADR-0042).
 *
 * Spread into `defineSchema()` from schema.ts via `...domainTables`.
 *
 * Per ADR-0018, provider-specific identity data (DKIM selectors, tokens) lives
 * in per-provider sibling tables owned by the corresponding **Sending domain
 * provider adapter (module)**, not on the `domains` row itself.
 */
export const domainTables = {
	// Domains - custom sending domains for improved email deliverability
	domains: defineTable({
		domain: v.string(), // The domain name (e.g., "mail.example.com")
		// Verification status — written exclusively by the
		// **Sending domain lifecycle (module)** at `convex/domains/lifecycle.ts`.
		status: v.union(
			v.literal('registering'),
			v.literal('pending'),
			v.literal('verified'),
			v.literal('failed')
		),
		// DNS records the customer must publish (SPF, DKIM, DMARC, MAIL-FROM).
		dnsRecords: dnsRecordsValidator,
		// Per-domain VERP return-path host (D1/D2). Absent ⇒ the domain uses the
		// deployment-global `MTA_RETURN_PATH_DOMAIN` env for its bounce envelope /
		// MAIL FROM — the historic behavior — so existing rows need no backfill.
		// When set, the MTA stamps `bounce+…@<returnPathHost>` for this domain's
		// outbound mail and the generated `mailFrom` SPF record is published on
		// this host instead of the global one. Written only by the **Sending
		// domain lifecycle (module)** (`setReturnPathHost`) and reflected to the
		// MTA at (re-)registration via the provider adapter. A validated DNS FQDN
		// (packages/shared `asDnsName`).
		returnPathHost: v.optional(v.string()),
		// DMARC enforcement policy reflected in the generated `_dmarc` record.
		// Absent (legacy rows) and `'none'` both mean monitor-only; the
		// customer raises it to `'quarantine'`/`'reject'` via the lifecycle's
		// `setDmarcPolicy`. Written only by the **Sending domain lifecycle
		// (module)** alongside `dnsRecords`.
		dmarcPolicy: v.optional(dmarcPolicyValidator),
		// Subdomain DMARC policy reflected in the `sp=` tag (RFC 7489 §6.3).
		// Absent ⇒ the record omits `sp=`, so subdomains inherit the apex `p=`
		// (DMARC's implicit default `sp=p`). Set to `'none'` to keep subdomains
		// in monitor-only while the apex enforces. Written only by the
		// lifecycle's `setDmarcPolicy` alongside `dmarcPolicy`/`dnsRecords`.
		dmarcSubdomainPolicy: v.optional(dmarcPolicyValidator),
		// Staged-rollout percentage reflected in the `pct=` tag (RFC 7489 §6.3),
		// an integer 0–100. Absent ⇒ the record omits `pct=` (full enforcement).
		// Written only by the lifecycle's `setDmarcPolicy`.
		dmarcPct: v.optional(v.number()),
		// Verification results with detailed status per record type
		verificationResults: v.optional(verificationResultsValidator),
		// Provider type that registered this domain ('mta' | 'ses').
		// The lifecycle dispatches per-provider work through
		// `providers/index.ts:providerFor(kind)` keyed by this field.
		providerType: v.optional(v.string()),
		// Last registration failure message (provider-agnostic). Cleared when
		// the next `registering → pending` succeeds. Replaces pre-ADR-0018
		// fields `registrationError` and `sesRegistrationError`.
		lastRegistrationError: v.optional(v.string()),
		// Last verification attempt timestamp (patched on every
		// `recordVerification` call, including same-state self-loops).
		lastVerifiedAt: v.optional(v.number()),
		// When the domain was *first* successfully verified. Preserved through
		// later DNS instability — never re-set on subsequent `→ verified`
		// edges.
		verifiedAt: v.optional(v.number()),
		// Marks rows inserted by /seed/demo or by dev shortcuts (e.g. force-verify)
		// so they can be wiped on reset. Values: 'demo' | 'dev-forced'.
		seedTag: v.optional(v.string()),
		// Timestamps
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_domain', ['domain'])
		.index('by_status', ['status']),

	// MTA sending domain identity — 1:0..1 with `domains` (one row per
	// MTA-provider-registered domain). Owned by the **Sending domain provider
	// adapter (module)** at `convex/domains/providers/mta/`. The adapter's
	// `writeIdentity` / `clearIdentity` are the only writers.
	sendingDomainMtaIdentities: defineTable({
		domainId: v.id('domains'),
		dkimSelector: v.string(), // e.g., "s1711234567"
		seedTag: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index('by_domain', ['domainId']),

	// SES sending domain identity — 1:0..1 with `domains`. Owned by the
	// **Sending domain provider adapter (module)** at
	// `convex/domains/providers/ses/`.
	sendingDomainSesIdentities: defineTable({
		domainId: v.id('domains'),
		dkimTokens: v.array(v.string()), // 3 DKIM tokens from SES
		verificationToken: v.string(),
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index('by_domain', ['domainId']),

	// Custom Tracking Domains - branded domains for click/open tracking
	trackingDomains: defineTable({
		domain: v.string(),
		cnameTarget: v.string(),
		isVerified: v.boolean(),
		verifiedAt: v.optional(v.number()),
		createdAt: v.number(),
	}).index('by_domain', ['domain']),

	// Per-domain reputation was folded into the unified, scope-discriminated
	// `sendingReputation` table in schema/delivery.ts (ADR-0042) — there is no
	// separate `domainReputation` table any more.

	// Inbound SMTP TLS Reports (TLS-RPT, RFC 8460) — aggregate reports OTHER
	// mail servers send us about TLS negotiation when delivering TO our MX,
	// ingested via the `_smtp._tls` `rua=` address the MTA registers as a
	// system inbound route. One row per received report, de-duplicated by the
	// reporting organization plus its `report-id` (RFC 8460 §4.1) so a
	// re-delivered report is idempotent without conflating different reporters.
	// Operator deliverability telemetry — instance infrastructure,
	// not org business data (see lib/tenantTables.ts NON_TENANT_TABLES).
	// Written only by `domains/tlsReports.ts:ingest`.
	tlsReports: defineTable({
		// RFC 8460 report-id — unique within the reporting organization.
		reportId: v.string(),
		// Reporting organization (the sender of the report, i.e. our partner).
		organizationName: v.string(),
		// The report's contact-info URI (mailto:/https:), verbatim.
		contactInfo: v.string(),
		// The receiving policy domain this report concerns (normally one of ours).
		policyDomain: v.string(),
		// Reporting window (epoch ms), parsed from the RFC 3339 date-range.
		rangeStartMs: v.number(),
		rangeEndMs: v.number(),
		// Session counts summed across every policy block in the report.
		successCount: v.number(),
		failureCount: v.number(),
		// Per-result-type failure tallies (RFC 8460 §4.4 failure-details).
		failureTypeCounts: v.array(v.object({ type: v.string(), count: v.number() })),
		// When we ingested it.
		receivedAt: v.number(),
	})
		.index('by_reporter_report_id', ['organizationName', 'reportId'])
		.index('by_policyDomain', ['policyDomain'])
		.index('by_range_start_ms', ['rangeStartMs']),
};
