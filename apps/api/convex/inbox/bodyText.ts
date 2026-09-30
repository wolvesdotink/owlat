/**
 * The full text of a team-inbox message whose readable part is held in storage.
 *
 * The thread view renders `textBody` straight off the rows `getThread` returns,
 * and a query cannot read blob contents — so a message whose text (or, with no
 * text part, whose HTML) was too large to keep on its row arrives with only its
 * `bodyExcerpt`, and the reader asks here for the rest. With no text part the
 * answer is the HTML as plain text, the same conversion the excerpt used.
 *
 * Same shape as `inbox/rawMessage.ts`: an internal QUERY does the
 * authorization, a public ACTION reads the blob through the one body accessor
 * (`lib/messageBodyInbound.ts`), so the plaintext never passes through a URL or
 * an unauthenticated route.
 *
 * The gate is the SHARED-INBOX one — a signed-in owner or admin, the check
 * `getThread` makes before it returns the same message's inline text.
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { publicAction } from '../lib/authedFunctions';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { htmlToPlainText } from '@owlat/shared/html';
import { openInboundMessageBody } from '../lib/messageBodyInbound';
import { isSharedInboxReader } from './access';

/**
 * The authorization half: the row for a signed-in owner or admin, or nothing.
 * `internalQuery`, so the opt-out marker belongs on the action below.
 */
export const getReadableInboundMessage = internalQuery({
	args: { messageId: v.id('inboundMessages') },
	handler: async (ctx, args): Promise<Doc<'inboundMessages'> | null> => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!isSharedInboxReader(session)) return null;
		return await ctx.db.get(args.messageId);
	},
});

// public: soft-auth — the internal source query returns null for anonymous and enforces the owner/admin gate
// authz: gate lives in internal.inbox.bodyText.getReadableInboundMessage (owner/admin, inherited identity).
export const getInboundMessageText = publicAction({
	args: { messageId: v.id('inboundMessages') },
	handler: async (ctx, args): Promise<string | null> => {
		const message: Doc<'inboundMessages'> | null = await ctx.runQuery(
			internal.inbox.bodyText.getReadableInboundMessage,
			args
		);
		if (!message) return null;
		const { text, html } = await openInboundMessageBody(message, ctx.storage);
		if (text?.trim()) return text;
		if (html) return htmlToPlainText(html);
		return text ?? null;
	},
});
