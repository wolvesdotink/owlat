/**
 * Dev shortcut: Force-verify a domain without going through real DNS.
 *
 * Motivation: today `domains/dnsVerification.ts` makes live DNS lookups; a
 * developer working on automations or send flows that depend on
 * `domain.status === 'verified'` can't progress without owning the domain.
 * Force Verify flips the row to `verified` with synthesised verification
 * results, writes an audit-log row that mirrors the lifecycle's
 * `sending_domain.verified` action, and synthesises a per-provider identity
 * row if one isn't already present.
 *
 * Gating (all three apply):
 *   - `assertDevDeployment()` — refuses when `OWLAT_DEV_MODE` is not enabled
 *   - `hasPermission(role, 'organization:manage')` — must be org owner/admin
 *   - UI button is only rendered when `import.meta.env.DEV` is true AND the
 *     current user is owner/admin (see apps/web/.../delivery/domains.vue)
 *
 * `seedTag` semantics: the user's existing domain row is NEVER tagged — that
 * would silently opt a real domain into the `/dev/reset` cascade. Only rows
 * this mutation synthesises (the MTA identity, when absent) carry the
 * `dev-forced` tag so reset can clean them up.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { authedMutation } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { getOrThrow } from '../_utils/errors';
import { recordAuditLog } from '../lib/auditLog';
import { assertDevDeployment } from './_guard';

import type { Doc, Id } from '../_generated/dataModel';

interface ForceVerifyResult {
	domainId: Id<'domains'>;
	status: 'verified';
}

type DomainDoc = Doc<'domains'>;
type VerificationResults = NonNullable<DomainDoc['verificationResults']>;

/**
 * Synthesise an "all DNS records verified" result so downstream UI/queries
 * that read `domain.verificationResults` (and assume `verified` rows carry
 * one) don't trip over `undefined`.
 */
function synthesiseVerificationResults(domain: DomainDoc, at: number): VerificationResults {
	const dns = domain.dnsRecords;
	const ok = { verified: true, lastChecked: at };
	const results: VerificationResults = {};
	if (dns.spf) results.spf = { ...ok };
	if (dns.dkim?.length) {
		results.dkim = dns.dkim.map(() => ({ ...ok }));
	}
	if (dns.dmarc) results.dmarc = { ...ok };
	if (dns.mailFrom?.length) {
		results.mailFrom = dns.mailFrom.map(() => ({ ...ok }));
	}
	return results;
}

export const forceVerifyDomainInternal = internalMutation({
	args: {
		domainId: v.id('domains'),
		userId: v.string(),
	},
	handler: async (ctx, { domainId, userId }): Promise<ForceVerifyResult> => {
		const domain = await getOrThrow(ctx, domainId, 'Domain');

		const now = Date.now();
		const previousStatus = domain.status;

		await ctx.db.patch(domainId, {
			status: 'verified',
			verifiedAt: domain.verifiedAt ?? now,
			lastVerifiedAt: now,
			lastRegistrationError: undefined,
			verificationResults: synthesiseVerificationResults(domain, now),
			updatedAt: now,
			// Intentionally NOT setting seedTag — `/dev/reset` should not wipe
			// the user's existing domain row just because they clicked Force
			// Verify. Only rows we synthesise below carry the tag.
		});

		// Synthesise the per-provider identity only for the MTA provider — the
		// SES provider has its own sibling table and ADR-0018's per-provider
		// exclusivity invariant requires we don't write across both. SES
		// domains keep whatever identity row their own register flow created.
		if (domain.providerType === 'mta' || domain.providerType === undefined) {
			const existingIdentity = await ctx.db
				.query('sendingDomainMtaIdentities')
				.withIndex('by_domain', (q) => q.eq('domainId', domainId))
				.first();
			if (!existingIdentity) {
				await ctx.db.insert('sendingDomainMtaIdentities', {
					domainId,
					dkimSelector: `s1dev${now.toString(36)}`,
					seedTag: 'dev-forced',
					createdAt: now,
					updatedAt: now,
				});
			}
		}

		// Audit-log the transition under the same action name the lifecycle
		// would have used, so audit-log UIs don't show a verified-without-trail
		// hole.
		await recordAuditLog(ctx, {
			userId,
			action: 'sending_domain.verified',
			resource: 'sending_domain',
			resourceId: domainId,
			details: {
				previousStatus,
				newStatus: 'verified',
				applied: 'transitioned',
				forced: true,
			},
		});

		return { domainId, status: 'verified' };
	},
});

/**
 * Public mutation called from the UI's "Force Verify (dev)" button.
 *
 * Returns the patched domain id + status. UI re-queries on success.
 */
export const forceVerifyDomain = authedMutation({
	args: {
		domainId: v.id('domains'),
	},
	handler: async (ctx, { domainId }): Promise<ForceVerifyResult> => {
		assertDevDeployment();
		const session = await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can force-verify domains'
		);
		return await ctx.runMutation(
			internal.devShortcuts.forceVerifyDomain.forceVerifyDomainInternal,
			{ domainId, userId: session.userId }
		);
	},
});
