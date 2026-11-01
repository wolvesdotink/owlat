/**
 * Previous-release paths of `channels/messages.ts`, `channels/config.ts`,
 * `channels/outboundTargets.ts` and `channels/health.ts`. The Team Inbox thread
 * timeline, the contact timeline tab, the channel composer, the delivery
 * activity page, the dashboard channel card and the channels settings page in a
 * tab opened before the deploy call `unifiedMessages:*` by path; the previous
 * release's channel dispatches, credential saves, delivery polls and health
 * probes still running call its internal functions by path; and a health check
 * the previous cron queued runs as `unifiedMessages:runChannelHealthChecks`.
 * Each keeps its old path, builder, auth floor, arguments and result shape, and
 * runs the same body as its replacement. Remove after release 0.6.17.
 */
import { v } from 'convex/values';
import { internalAction, internalQuery } from './_generated/server';
import { internalMutation } from './lib/writeFence';
import { authedMutation, authedQuery } from './lib/authedFunctions';
import {
	contactTimeline,
	getContactTimelineArgs,
	getThreadTimelineArgs,
	insertChatMessage,
	insertOutboundMessage,
	listPendingDeliveryStatusArgs,
	listRecentArgs,
	outboundMessageArgs,
	pendingDeliveryStatus,
	pendingDeliveryValidator,
	recentMessages,
	sendChatMessageArgs,
	threadTimeline,
} from './channels/messages';
import {
	channelConfigByChannel,
	channelConfigsForCaller,
	getChannelConfigInternalArgs,
	saveChannelConfig,
	setChannelConfigSecretArgs,
	updateChannelConfigArgs,
	writeChannelConfigSecret,
} from './channels/config';
import {
	contactChannelIdentifier,
	getContactChannelIdentifierArgs,
	resolveOutboundThreadArgs,
	resolveThreadForOutbound,
} from './channels/outboundTargets';
import {
	checkEnabledChannels,
	enabledChannelConfigs,
	recordChannelHealth,
	updateChannelHealthArgs,
} from './channels/health';

/** Remove after release 0.6.17; this release calls `channels/messages:getThreadTimeline`. */
// authz: threadTimeline requires a shared-inbox reader before it reads.
export const getThreadTimeline = authedQuery({
	args: getThreadTimelineArgs,
	handler: async (ctx, args, session) => await threadTimeline(ctx, args, session),
});

/** Remove after release 0.6.17; this release calls `channels/messages:getContactTimeline`. */
// authz: contactTimeline requires a shared-inbox reader before it reads.
export const getContactTimeline = authedQuery({
	args: getContactTimelineArgs,
	handler: async (ctx, args, session) => await contactTimeline(ctx, args, session),
});

/** Remove after release 0.6.17; this release calls `channels/messages:listRecent`. */
// authz: recentMessages requires a shared-inbox reader before it reads.
export const listRecent = authedQuery({
	args: listRecentArgs,
	handler: async (ctx, args, session) => await recentMessages(ctx, args, session),
});

/** Remove after release 0.6.17; this release calls `channels/config:getChannelConfigs`. */
// all-members: health/display fields feed the dashboard channel card;
// channelConfigsForCaller never returns the credential envelope and gives the
// configuredFields presence map to admins only.
export const getChannelConfigs = authedQuery({
	args: {},
	handler: async (ctx, _args, session) => await channelConfigsForCaller(ctx, session),
});

/**
 * Record an outbound message from any channel. No caller in this release: the
 * channel dispatch commits through `channels/outboundCommit.ts`, which shares
 * {@link insertOutboundMessage}. Remove after release N+1.
 */
export const recordOutbound = internalMutation({
	args: outboundMessageArgs,
	handler: async (ctx, args) => await insertOutboundMessage(ctx, args),
});

/**
 * Update delivery status of an outbound message. No caller in this release:
 * the delivery-status poller (`channels.outbound.pollDeliveryStatus`) commits
 * its batch through `channels/outboundCommit.ts`. Remove after release N+1.
 */
export const updateDeliveryStatus = internalMutation({
	args: {
		messageId: v.id('unifiedMessages'),
		status: v.union(
			v.literal('sent'),
			v.literal('delivered'),
			v.literal('read'),
			v.literal('failed')
		),
	},
	handler: async (ctx, args) => {
		// This release's poll may have moved the row past `sent` already; an old
		// poll's earlier answer must not move it back.
		const row = await ctx.db.get(args.messageId);
		if (row?.status === 'delivered' || row?.status === 'read' || row?.status === 'failed') return;
		await ctx.db.patch(args.messageId, { status: args.status });
	},
});

/** Remove after release 0.6.17; this release calls `channels/messages:listPendingDeliveryStatus`. */
export const listPendingDeliveryStatus = internalQuery({
	args: listPendingDeliveryStatusArgs,
	returns: v.array(pendingDeliveryValidator),
	handler: async (ctx, args) => await pendingDeliveryStatus(ctx, args),
});

/** Remove after release 0.6.17; this release calls `channels/messages:sendChatMessage`. */
// authz: insertChatMessage requires a shared-inbox reader before it writes.
export const sendChatMessage = authedMutation({
	args: sendChatMessageArgs,
	handler: async (ctx, args, session) => await insertChatMessage(ctx, args, session),
});

/** Remove after release 0.6.17; this release calls `channels/config:updateChannelConfig`. */
// authz: saveChannelConfig requires organization:manage before it writes.
export const updateChannelConfig = authedMutation({
	args: updateChannelConfigArgs,
	handler: async (ctx, args, session) => await saveChannelConfig(ctx, args, session),
});

/** Remove after release 0.6.17; this release calls `channels/config:setChannelConfigSecret`. */
export const setChannelConfigSecret = internalMutation({
	args: setChannelConfigSecretArgs,
	handler: async (ctx, args) => await writeChannelConfigSecret(ctx, args),
});

/** Remove after release 0.6.17; this release calls `channels/config:getChannelConfigInternal`. */
export const getChannelConfigInternal = internalQuery({
	args: getChannelConfigInternalArgs,
	handler: async (ctx, args) => await channelConfigByChannel(ctx, args),
});

/** Remove after release 0.6.17; this release calls `channels/outboundTargets:getContactChannelIdentifier`. */
export const getContactChannelIdentifier = internalQuery({
	args: getContactChannelIdentifierArgs,
	handler: async (ctx, args): Promise<string | null> => await contactChannelIdentifier(ctx, args),
});

/** Remove after release 0.6.17; this release calls `channels/outboundTargets:resolveOutboundThread`. */
export const resolveOutboundThread = internalMutation({
	args: resolveOutboundThreadArgs,
	returns: v.id('conversationThreads'),
	handler: async (ctx, args) => await resolveThreadForOutbound(ctx, args),
});

/** Remove after release 0.6.17; this release calls `channels/health:updateChannelHealth`. */
export const updateChannelHealth = internalMutation({
	args: updateChannelHealthArgs,
	handler: async (ctx, args) => await recordChannelHealth(ctx, args),
});

/** Remove after release 0.6.17; the channel health cron now registers `channels/health:runChannelHealthChecks`. */
export const runChannelHealthChecks = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => await checkEnabledChannels(ctx),
});

/** Remove after release 0.6.17; this release calls `channels/health:getEnabledChannels`. */
export const getEnabledChannels = internalQuery({
	args: {},
	handler: async (ctx) => await enabledChannelConfigs(ctx),
});
