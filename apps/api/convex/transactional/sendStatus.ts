/**
 * Where one transactional API send stands, as `GET /api/v1/transactional/{sendId}`
 * answers it (`./sendStatusHttp.ts`).
 *
 * Only a `kind: 'transactional'` row is readable here: that is the row the
 * public send API created and whose id it handed out. An automation, inbox or
 * preview send shares the table but was never named to an API caller, so it
 * reads as not found. An erased row (soft-deleted with its contact) reads as
 * not found too.
 *
 * The answer is built field by field, never by spreading the row, so the
 * send's data variables (which can hold reset tokens and order details) and
 * its internal routing columns never reach the response.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import { internalQuery, type QueryCtx } from '../_generated/server';
import type { TransactionalSendStatus } from '@owlat/public-contract';

const isoOrNull = (at: number | undefined): string | null =>
	at === undefined ? null : new Date(at).toISOString();

/** The readable API send behind a caller-supplied id, or null. */
async function readableApiSend(
	db: QueryCtx['db'],
	rawId: string
): Promise<Doc<'transactionalSends'> | null> {
	// A malformed id, or the id of another table, is a 404 like an unknown one.
	const id = db.normalizeId('transactionalSends', rawId);
	if (!id) return null;
	const send = await db.get(id);
	if (!send || send.kind !== 'transactional' || send.deletedAt !== undefined) return null;
	return send;
}

/**
 * The slug of the template a send used, for the send response's `slug` echo
 * when the request named the template by id. Empty once the template is gone.
 */
export async function templateSlugOfSend(
	db: QueryCtx['db'],
	sendId: Id<'transactionalSends'>
): Promise<string> {
	const send = await db.get(sendId);
	const template = send?.transactionalEmailId ? await db.get(send.transactionalEmailId) : null;
	return template?.slug ?? '';
}

export function toSendStatus(
	send: Doc<'transactionalSends'>,
	template: Doc<'transactionalEmails'> | null
): TransactionalSendStatus {
	const isFailed = send.status === 'failed';
	return {
		sendId: send._id,
		status: send.status,
		email: send.email,
		templateId: template?._id ?? null,
		slug: template?.slug ?? null,
		language: send.language ?? null,
		// Rows written before `queuedAt` existed were queued when they were created.
		queuedAt: isoOrNull(send.queuedAt ?? send._creationTime),
		sentAt: isoOrNull(send.sentAt),
		deliveredAt: isoOrNull(send.deliveredAt),
		openedAt: isoOrNull(send.openedAt),
		clickedAt: isoOrNull(send.clickedAt),
		bouncedAt: isoOrNull(send.bouncedAt),
		complainedAt: isoOrNull(send.complainedAt),
		failedAt: isoOrNull(send.failedAt),
		bounceType: send.bounceType ?? null,
		errorCode: isFailed ? (send.errorCode ?? null) : null,
		errorMessage: isFailed ? (send.errorMessage ?? null) : null,
	};
}

/** The status of one API send, or null when the id names no readable one. */
export const getForApi = internalQuery({
	args: { sendId: v.string() },
	handler: async (ctx, args): Promise<TransactionalSendStatus | null> => {
		const send = await readableApiSend(ctx.db, args.sendId);
		if (!send) return null;
		const template = send.transactionalEmailId ? await ctx.db.get(send.transactionalEmailId) : null;
		return toSendStatus(send, template);
	},
});
