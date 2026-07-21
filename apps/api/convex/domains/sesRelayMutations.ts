import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { dnsRecordsValidator, verificationResultsValidator } from '../lib/convexValidators';

export const storeProvisioning = internalMutation({
	args: {
		domainId: v.id('domains'),
		dkimTokens: v.array(v.string()),
		verificationToken: v.string(),
		dnsRecords: dnsRecordsValidator,
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
		const dnsVerified = Boolean(
			args.verificationResults.spf?.verified &&
			args.verificationResults.dkim?.length &&
			args.verificationResults.dkim.every((result) => result.verified) &&
			args.verificationResults.mailFrom?.length &&
			args.verificationResults.mailFrom.every((result) => result.verified)
		);
		const verified = dnsVerified && args.isProviderVerified;
		await ctx.db.patch(existing._id, {
			dnsRecords: args.dnsRecords,
			verificationResults: args.verificationResults,
			isProviderVerified: args.isProviderVerified,
			verifiedAt: verified ? args.checkedAt : undefined,
			updatedAt: args.checkedAt,
		});
		return { recorded: true, verified };
	},
});
