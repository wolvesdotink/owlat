import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * DMARC aggregate (RUA) reports receivers mail to Owlat's report address
 * (`@owlat/shared/dmarcReportAddress`), parsed by `domains/dmarcReportsNode.ts`
 * and written only by `domains/dmarcReports.ts:ingest`. Org data: they describe
 * who sends as this organization's domains, so the workspace wipe deletes them
 * (lib/tenantTables.ts). Rows age out after the retention window
 * (`sweepExpiredReports`), and both tables are keyed by the policy DOMAIN NAME
 * rather than a `domains` id, so removing and re-adding a domain keeps its
 * history until it expires.
 */

const policyValidator = v.union(v.literal('none'), v.literal('quarantine'), v.literal('reject'));

const authResultValidator = v.object({
	domain: v.string(),
	result: v.string(),
	// DKIM selector or SPF scope, when the reporter gave one.
	detail: v.optional(v.string()),
});

/** One received report: who sent it, which period and domain it covers. */
export const dmarcReportFields = {
	// The reporting organization (`report_metadata/org_name`), e.g. `google.com`.
	reporterOrgName: v.string(),
	reporterEmail: v.optional(v.string()),
	// Unique within the reporter; with `reporterOrgName` the dedupe key.
	reportId: v.string(),
	// The policy domain the report covers (lowercase), one of our sending domains.
	policyDomain: v.string(),
	// Reporting period (epoch ms).
	rangeBeginMs: v.number(),
	rangeEndMs: v.number(),
	// The policy the receiver saw published (`policy_published`).
	publishedPolicy: v.optional(policyValidator),
	publishedSubdomainPolicy: v.optional(policyValidator),
	publishedPct: v.optional(v.number()),
	// Totals over the report's rows: messages, and messages that passed DMARC.
	messageCount: v.number(),
	alignedCount: v.number(),
	recordCount: v.number(),
	receivedAt: v.number(),
};

/** One report row: a sending IP and what happened to its mail. */
export const dmarcReportRecordFields = {
	reportDocId: v.id('dmarcReports'),
	// Denormalized from the report so the dashboard reads rows by domain + period.
	policyDomain: v.string(),
	rangeBeginMs: v.number(),
	sourceIp: v.string(),
	// Reverse DNS name of `sourceIp`, filled in after ingest when one resolves.
	sourceHost: v.optional(v.string()),
	count: v.number(),
	disposition: policyValidator,
	isDkimAligned: v.boolean(),
	isSpfAligned: v.boolean(),
	headerFrom: v.string(),
	envelopeFrom: v.optional(v.string()),
	dkimResults: v.array(authResultValidator),
	spfResults: v.array(authResultValidator),
	// `policy_evaluated/reason/type`: forwarded, mailing_list, local_policy, ...
	overrideReasons: v.array(v.string()),
};

export const dmarcReportTables = {
	dmarcReports: defineTable(dmarcReportFields)
		.index('by_reporter_report_id', ['reporterOrgName', 'reportId'])
		.index('by_policy_domain_range', ['policyDomain', 'rangeBeginMs'])
		.index('by_received_at', ['receivedAt']),
	dmarcReportRecords: defineTable(dmarcReportRecordFields)
		.index('by_report', ['reportDocId'])
		.index('by_policy_domain_range', ['policyDomain', 'rangeBeginMs']),
};
