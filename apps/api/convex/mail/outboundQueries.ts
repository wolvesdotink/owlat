/**
 * v8-isolate-resident helpers used by the Node-side dispatchDraft action.
 *
 * Convex requires `query` and `mutation` definitions to live in non-node
 * files (they only run in the v8 runtime), so the action in mailOutbound.ts
 * (`'use node'`) calls into these via `internal.mail.outboundQueries.*`.
 *
 * The claim/revert/writeSentMessage trio that used to live here moved to
 * the Mail draft lifecycle module — the sole writer of `mailDrafts.state`
 * and the multi-table send-success cascade. See ADR-0028. The only thing
 * left in this file is the threading-header lookup the dispatcher does
 * before building the RFC 5322 envelope.
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';

export const getMessage = internalQuery({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args) => ctx.db.get(args.messageId),
});
