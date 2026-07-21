"use node";

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { sesProvider } from "./providers/ses";

/** Provision a coexisting SES relay identity without changing the primary domain provider. */
export const provision = internalAction({
	args: { domainId: v.id("domains") },
	handler: async (ctx, args) => {
		const domain = await ctx.runQuery(internal.domains.queries.getDomainForRegistration, args);
		if (!domain || domain.providerType !== "mta") return { provisioned: false };
		const { dnsRecords, identity } = await sesProvider.registerDomain(domain.domain, {
			returnPathHost: domain.returnPathHost,
		});
		await ctx.runMutation(internal.domains.sesRelayMutations.storeProvisioning, {
			domainId: args.domainId,
			dkimTokens: identity.dkimTokens,
			verificationToken: identity.verificationToken,
			dnsRecords,
		});
		return { provisioned: true };
	},
});
