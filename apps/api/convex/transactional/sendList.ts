/**
 * One page of `GET /api/v1/transactional` (`./sendStatusHttp.ts`): the sends
 * the transactional API created, newest first, each as the status route
 * answers it (`./sendStatus.ts`).
 *
 * The same rows the status route reads by id, and no others: only
 * `kind: 'transactional'` (an automation, inbox or preview send was never
 * named to an API caller) and only live ones (an erased send is soft-deleted
 * and scrubbed of its address).
 *
 * Every filter is one range of one index, bounded by when the send was
 * queued, so a page reads at most `limit` sends however many other sends the
 * table holds. A filter no index serves is not offered.
 */

import { v } from 'convex/values';
import type { TransactionalSendStatus } from '@owlat/public-contract';
import type { Doc, Id } from '../_generated/dataModel';
import { internalQuery, type QueryCtx } from '../_generated/server';
import { sendStatusValidator } from '../lib/literalValidators';
import { paginateClientCursor } from '../lib/pagination';
import { toSendStatus } from './sendStatus';

/**
 * Bytes of sends one page reads before it ends early with a cursor to the
 * rest. A send keeps its data variables (up to the 100,000-byte request
 * budget each), so a full page of large ones would pass the 16 MiB one query
 * may read. The page stops after the send that crosses this budget, and a
 * document is at most 1 MiB, so its sends stay under 9 MiB and leave the rest
 * for the templates it reads alongside.
 */
export const SEND_LIST_PAGE_BYTES = 8 * 1024 * 1024;

export interface SendListPageArgs {
	/** A normalised recipient address, or null for every recipient. */
	email: string | null;
	status: Doc<'transactionalSends'>['status'] | null;
	/** Queued at or after, in ms. */
	since: number;
	/** Queued before, in ms. */
	until: number;
	limit: number;
	/** The paginator's own cursor, or null for the first page. */
	cursor: string | null;
}

/** The index range the filters name, newest first, one page of it. */
export async function readSendListPage(db: QueryCtx['db'], args: SendListPageArgs) {
	const sends = db.query('transactionalSends');
	const { email, status, since, until } = args;
	const query =
		email !== null && status !== null
			? sends.withIndex('by_kind_deleted_email_status', (q) =>
					q
						.eq('kind', 'transactional')
						.eq('deletedAt', undefined)
						.eq('email', email)
						.eq('status', status)
						.gte('_creationTime', since)
						.lt('_creationTime', until)
				)
			: email !== null
				? sends.withIndex('by_kind_deleted_email', (q) =>
						q
							.eq('kind', 'transactional')
							.eq('deletedAt', undefined)
							.eq('email', email)
							.gte('_creationTime', since)
							.lt('_creationTime', until)
					)
				: status !== null
					? sends.withIndex('by_kind_deleted_status', (q) =>
							q
								.eq('kind', 'transactional')
								.eq('deletedAt', undefined)
								.eq('status', status)
								.gte('_creationTime', since)
								.lt('_creationTime', until)
						)
					: sends.withIndex('by_kind_deleted', (q) =>
							q
								.eq('kind', 'transactional')
								.eq('deletedAt', undefined)
								.gte('_creationTime', since)
								.lt('_creationTime', until)
						);
	return await paginateClientCursor(query.order('desc'), {
		numItems: args.limit,
		cursor: args.cursor,
		maximumBytesRead: SEND_LIST_PAGE_BYTES,
	});
}

export const listForApi = internalQuery({
	args: {
		email: v.union(v.string(), v.null()),
		status: v.union(sendStatusValidator, v.null()),
		since: v.number(),
		until: v.number(),
		limit: v.number(),
		cursor: v.union(v.string(), v.null()),
	},
	handler: async (
		ctx,
		args
	): Promise<{ data: TransactionalSendStatus[]; cursor: string | null; isDone: boolean }> => {
		const page = await readSendListPage(ctx.db, args);
		// A page usually comes from a handful of templates: read each once.
		const templates = new Map<Id<'transactionalEmails'>, Doc<'transactionalEmails'> | null>();
		const data: TransactionalSendStatus[] = [];
		for (const send of page.page) {
			const templateId = send.transactionalEmailId;
			let template: Doc<'transactionalEmails'> | null = null;
			if (templateId) {
				if (!templates.has(templateId)) templates.set(templateId, await ctx.db.get(templateId));
				template = templates.get(templateId) ?? null;
			}
			data.push(toSendStatus(send, template));
		}
		return { data, cursor: page.isDone ? null : page.continueCursor, isDone: page.isDone };
	},
});
