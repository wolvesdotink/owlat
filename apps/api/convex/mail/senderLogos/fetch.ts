'use node';

/**
 * The sender logo lookup, scheduled by `cache.ts:requestSenderLogo` when a
 * message that may show a logo is delivered. Reads nothing, does the guarded
 * DNS and HTTP work in `discover.ts`, stores the image, and commits once.
 */

import { v } from 'convex/values';
import { internalAction } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { discoverSenderLogo } from './discover';

export const fetchSenderLogo = internalAction({
	args: { domain: v.string(), requestedAt: v.number() },
	handler: async (ctx, args): Promise<void> => {
		const found = await discoverSenderLogo(args.domain);
		const storageId = found
			? await ctx.storage.store(new Blob([found.bytes], { type: found.mimeType }))
			: null;
		let isKept = false;
		try {
			({ isKept } = await ctx.runMutation(internal.mail.senderLogos.cache.commitSenderLogo, {
				domain: args.domain,
				requestedAt: args.requestedAt,
				logo: found && storageId ? { source: found.source, storageId } : null,
			}));
		} finally {
			// Nothing references a blob the commit did not keep.
			if (storageId && !isKept) await ctx.storage.delete(storageId);
		}
	},
});
