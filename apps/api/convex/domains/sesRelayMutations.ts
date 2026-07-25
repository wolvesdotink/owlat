import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { dnsRecordsValidator, verificationResultsValidator } from '../lib/convexValidators';
import { internal } from '../_generated/api';
import { SES_RELAY_PROOF_MAX_AGE_MS } from '@owlat/shared';

export const storeProvisioning = internalMutation({
	args: {
		domainId: v.id('domains'),
		dkimTokens: v.array(v.string()),
		verificationToken: v.string(),
		dnsRecords: dnsRecordsValidator,
		spfProofState: v.union(v.literal('dns_required'), v.literal('not_applicable_manual_primary')),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('sendingDomainSesIdentities')
			.withIndex('by_domain', (q) => q.eq('domainId', args.domainId))
			.first();
		const now = Date.now();
		const fields = {
			dkimTokens: args.dkimTokens,
			verificationToken: args.verificationToken,
			dnsRecords: args.dnsRecords,
			spfProofState: args.spfProofState,
			verificationResults: undefined,
			isProviderVerified: false,
			verifiedAt: undefined,
			updatedAt: now,
		};
		if (existing) await ctx.db.patch(existing._id, fields);
		else
			await ctx.db.insert('sendingDomainSesIdentities', {
				domainId: args.domainId,
				...fields,
				createdAt: now,
			});
	},
});

export const storeVerification = internalMutation({
	args: {
		domainId: v.id('domains'),
		dnsRecords: dnsRecordsValidator,
		verificationResults: verificationResultsValidator,
		isProviderVerified: v.boolean(),
		checkedAt: v.number(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('sendingDomainSesIdentities')
			.withIndex('by_domain', (q) => q.eq('domainId', args.domainId))
			.first();
		if (!existing) return { recorded: false };
		const spfProofState =
			existing.spfProofState ??
			(args.dnsRecords.spf ? 'dns_required' : 'not_applicable_manual_primary');
		const dnsVerified = Boolean(
			(spfProofState === 'not_applicable_manual_primary'
				? !args.dnsRecords.spf && !args.verificationResults.spf
				: Boolean(args.dnsRecords.spf && args.verificationResults.spf?.verified)) &&
			args.verificationResults.dkim?.length &&
			args.verificationResults.dkim.every((result) => result.verified) &&
			args.verificationResults.mailFrom?.length &&
			args.verificationResults.mailFrom.every((result) => result.verified)
		);
		const verified = dnsVerified && args.isProviderVerified;
		await ctx.db.patch(existing._id, {
			dnsRecords: args.dnsRecords,
			spfProofState,
			verificationResults: args.verificationResults,
			isProviderVerified: args.isProviderVerified,
			verifiedAt: verified ? args.checkedAt : undefined,
			updatedAt: args.checkedAt,
		});
		return { recorded: true, verified };
	},
});

/** Schedule a bounded renewal batch before the 30-day routing proof expires. */
export const scheduleVerificationRefresh = internalMutation({
	args: { cursor: v.optional(v.string()) },
	handler: async (ctx, args): Promise<number> => {
		const refreshBefore = Date.now() - (SES_RELAY_PROOF_MAX_AGE_MS - 24 * 60 * 60 * 1000);
		const retryPendingBefore = Date.now() - 24 * 60 * 60 * 1000;
		let scheduled = 0;
		const page = await ctx.db
			.query('sendingDomainSesIdentities')
			.paginate({ cursor: args.cursor ?? null, numItems: 100 });
		for (const identity of page.page) {
			if (
				(identity.verifiedAt !== undefined && identity.verifiedAt >= refreshBefore) ||
				(identity.verifiedAt === undefined && identity.updatedAt >= retryPendingBefore)
			) {
				continue;
			}
			await ctx.scheduler.runAfter(
				scheduled * 1_000,
				internal.domains.sesRelayVerification.refreshSesRelayIdentity,
				{ domainId: identity.domainId }
			);
			scheduled += 1;
		}
		if (!page.isDone) {
			// The scheduled-function argument is the durable continuation. Each
			// action reads at most one page, so large installations progress without
			// a collect, timeout, or repeatedly starving identities after page one.
			await ctx.scheduler.runAfter(
				Math.max(scheduled * 1_000, 1_000),
				internal.domains.sesRelayMutations.scheduleVerificationRefresh,
				{ cursor: page.continueCursor }
			);
		}
		return scheduled;
	},
});
