/**
 * Single attachment parts for the Postbox reader (plan 3.5 / E6).
 *
 * `mail/messageParts.ts` stores each attachment leaf of a delivered message as
 * its own sealed blob. These reads hand the reader ONE of them — a download
 * URL for a file, the iCalendar text for the invite card — so it no longer
 * fetches the whole raw `.eml` for a few kilobytes out of it.
 *
 * Every answer that is not a stored part (older mail, a message whose parts
 * are still being cut, one with more leaves than are stored) tells the client
 * to use the raw `.eml` as before. Access is the same gate as the raw download
 * (`loadReadableMessage`), so a message the caller cannot read yields nothing.
 */

import { v } from 'convex/values';
import { internalQuery, type QueryCtx } from '../../_generated/server';
import { publicAction } from '../../lib/authedFunctions';
import type { Doc, Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { readSealedBlobBytes, sealedBlobUrl } from '../../lib/sealedBlob';
import { pickStoredPart } from '../messageParts';
import { loadReadableMessage } from './messages';

/** The stored parts of a message the caller may read, or null. */
async function loadReadableParts(
	ctx: QueryCtx,
	messageId: Id<'mailMessages'>
): Promise<{ readable: boolean; row: Doc<'mailMessageParts'> | null }> {
	const message = await loadReadableMessage(ctx, messageId);
	if (!message) return { readable: false, row: null };
	const row = await ctx.db
		.query('mailMessageParts')
		.withIndex('by_raw_storage', (q) => q.eq('rawStorageId', message.rawStorageId))
		.first();
	return { readable: true, row };
}

/**
 * The stored blob for one attachment, picked the way `extractAttachmentAt`
 * picks it out of the raw message, or null when there is none to serve.
 */
// public: soft-auth — returns null for anonymous; mailbox access is still enforced in-handler
export const getReadableMessagePart = internalQuery({
	args: {
		messageId: v.id('mailMessages'),
		partIndex: v.string(),
		filename: v.optional(v.string()),
	},
	handler: async (
		ctx,
		args
	): Promise<{ storageId: Id<'_storage'>; contentType: string } | null> => {
		const { row } = await loadReadableParts(ctx, args.messageId);
		if (!row || row.status !== 'stored') return null;
		const part = pickStoredPart(row.parts, args.partIndex, args.filename);
		return part ? { storageId: part.storageId, contentType: part.contentType } : null;
	},
});

/**
 * A signed URL for ONE attachment of a message, or `null` when the part is not
 * stored on its own — the reader then extracts it from the raw `.eml` as it did
 * before. The URL is minted cacheable: a part never changes, so the browser may
 * keep it privately for the token's lifetime.
 */
// public: soft-auth — internal source query returns null for anonymous and enforces mailbox access
// authz: gate lives in internal.mail.mailbox.parts.getReadableMessagePart (loadReadableMessage).
export const getMessagePartUrl = publicAction({
	args: {
		messageId: v.id('mailMessages'),
		partIndex: v.string(),
		filename: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<string | null> => {
		const part: { storageId: Id<'_storage'>; contentType: string } | null = await ctx.runQuery(
			internal.mail.mailbox.parts.getReadableMessagePart,
			args
		);
		if (!part) return null;
		return await sealedBlobUrl(ctx.storage, part.storageId, part.contentType, {
			cacheable: true,
		});
	},
});

/** What ingest recorded about a message's `text/calendar` leaf. */
type CalendarState =
	| { state: 'found'; storageId: Id<'_storage'> }
	| { state: 'absent' }
	| { state: 'unknown' };

// public: soft-auth — returns null for anonymous; mailbox access is still enforced in-handler
export const getReadableMessageCalendar = internalQuery({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args): Promise<CalendarState> => {
		const { readable, row } = await loadReadableParts(ctx, args.messageId);
		// Unreadable reads as "no invite": the raw path answers null for it too,
		// and the card stays hidden either way.
		if (!readable) return { state: 'absent' };
		if (!row) return { state: 'unknown' };
		return row.calendarStorageId
			? { state: 'found', storageId: row.calendarStorageId }
			: { state: 'absent' };
	},
});

/**
 * The invite card's iCalendar text, cut out at ingest.
 *
 * `absent`: the message has no `text/calendar` leaf, so there is no card.
 * `unknown`: nothing was stored for it (older mail, or extraction has not run
 * yet); the card reads the raw `.eml` instead.
 */
// public: soft-auth — internal source query returns absent for anonymous and enforces mailbox access
// authz: gate lives in internal.mail.mailbox.parts.getReadableMessageCalendar (loadReadableMessage).
export const getMessageCalendar = publicAction({
	args: { messageId: v.id('mailMessages') },
	handler: async (
		ctx,
		args
	): Promise<{ status: 'found'; ics: string } | { status: 'absent' } | { status: 'unknown' }> => {
		const calendar: CalendarState = await ctx.runQuery(
			internal.mail.mailbox.parts.getReadableMessageCalendar,
			args
		);
		if (calendar.state !== 'found') return { status: calendar.state };
		const bytes = await readSealedBlobBytes(ctx.storage, calendar.storageId);
		if (bytes === null) return { status: 'unknown' };
		return { status: 'found', ics: new TextDecoder('utf-8').decode(bytes) };
	},
});
