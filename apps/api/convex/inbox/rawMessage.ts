/**
 * Signed URL for a team-inbox message's raw `.eml`.
 *
 * The reader fetches it and extracts an attachment client-side, because the
 * attachment bytes live in the raw MIME — the `inboundMessages` row carries
 * metadata, not content. Same shape as the personal-mailbox pair in
 * `mail/mailbox/messages.ts`: an internal QUERY does the authorization (queries
 * can read the database) and a public ACTION mints the URL (minting needs
 * action storage, because `sealedBlobUrl` may probe the blob's envelope when
 * INSTANCE_SECRET is absent).
 *
 * The gate is the SHARED-INBOX one — a signed-in owner or admin, the same check
 * `inbox/queries.getThread` makes. Deliberately not `loadReadableMessage`,
 * which is a personal-mailbox OWNERSHIP predicate and would deny every
 * team-inbox reader.
 *
 * No new HTTP route: `GET /sealed-blob` already serves the minted token, with
 * `nosniff`, `no-store`, a sandbox CSP and `Content-Disposition: attachment`
 * for `message/rfc822`.
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { publicAction } from '../lib/authedFunctions';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { isSharedInboxReader } from './access';
import { sealedBlobUrl } from '../lib/sealedBlob';
import { logWarn } from '../lib/runtimeLog';

/**
 * The authorization half: a signed-in owner or admin, or nothing.
 *
 * `internalQuery`, so there is no public surface to opt out of and no
 * opt-out marker belongs here — that note goes on the ACTION below, which is
 * the callable one.
 */
export const getInboundMessageRawStorageId = internalQuery({
	args: { messageId: v.id('inboundMessages') },
	handler: async (ctx, args): Promise<Id<'_storage'> | null> => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!isSharedInboxReader(session)) return null;
		const row = await ctx.db.get(args.messageId);
		if (!row) return null;
		// CONFIRMED MALWARE IS NOT DOWNLOADABLE. The reader hides the control on a
		// quarantined message, but the action is callable directly, so the refusal
		// has to be here as well or the client-side hide is the whole gate. The
		// sealed blob still exists — an operator investigating what was sent reads
		// it out of storage, not through a browser-facing signed URL.
		if (row.virusVerdict === 'infected') return null;
		// Absent once the retention sweep has released the bytes, and on any
		// message that arrived through the legacy route without them.
		return row.rawStorageId ?? null;
	},
});

// public: soft-auth — the internal source query returns null for anonymous and enforces the owner/admin gate
export const getInboundMessageRawUrl = publicAction({
	args: { messageId: v.id('inboundMessages') },
	handler: async (ctx, args): Promise<string | null> => {
		const storageId: Id<'_storage'> | null = await ctx.runQuery(
			internal.inbox.rawMessage.getInboundMessageRawStorageId,
			args
		);
		if (!storageId) return null;
		// E8b: the raw `.eml` is sealed at rest, so it is served through the
		// decrypt proxy rather than as a direct storage URL. Returns null — a real
		// state the caller must handle, not an error — when there is a key but no
		// CONVEX_SITE_URL to proxy through, and when a keyless instance meets a
		// blob that is structurally sealed.
		const url = await sealedBlobUrl(ctx.storage, storageId, 'message/rfc822');
		if (!url) {
			// The reader hides the control for the two states it can see (swept
			// bytes, quarantine), so a null that reaches a user is one of the two
			// CONFIGURATION states — and the client answers it with "could not be
			// downloaded, try again", which will never come true. `sealedBlobUrl`
			// returns its nulls silently, so without this line an instance holding
			// INSTANCE_SECRET and no CONVEX_SITE_URL fails every attachment
			// download on every message with nothing anywhere to find.
			logWarn(
				'[Inbox raw] could not mint a sealed-blob URL — check INSTANCE_SECRET/CONVEX_SITE_URL',
				{
					messageId: args.messageId,
				}
			);
		}
		return url;
	},
});
