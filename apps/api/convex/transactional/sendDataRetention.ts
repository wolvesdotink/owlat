/**
 * Retention and visibility of the data variables a template send stores.
 *
 * An API caller's `dataVariables` are often bearer material: a password-reset
 * token, a magic sign-in link, an order's contents. The Send keeps them only so
 * an operator can see what a fresh send was given. So:
 *
 *   - Before the sweep, only a member who may edit transactional templates
 *     (`templates:manage`, the permission the template editor requires) reads
 *     the values; everyone else sees the variable names.
 *   - Once a send has left `queued` and {@link SEND_DATA_VARIABLES_RETENTION_MS}
 *     has passed since, the sweep removes the values and keeps the names.
 *
 * The worker never reads the row's copy: the values ride the queued envelope,
 * so removing them from a finished send changes nothing about delivery.
 */

import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { internalMutation } from '../lib/writeFence';

/**
 * How long a finished send keeps the values its caller supplied: a day, enough
 * to look into a send that went wrong today and short enough that a reset link
 * is not readable long after it was mailed.
 */
export const SEND_DATA_VARIABLES_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Sends examined per sweep run; a longer backlog continues in a follow-up run. */
const SWEEP_BATCH = 200;

type SendDataFields = Pick<
	Doc<'transactionalSends'>,
	| '_creationTime'
	| 'status'
	| 'sentAt'
	| 'failedAt'
	| 'dataVariables'
	| 'dataVariableNames'
	| 'dataVariablesRedactedAt'
>;

/** Who sees what of a send's data variables. */
export type DataVariablesAccess = 'visible' | 'hidden' | 'redacted';

/**
 * When a send's values may be removed: the window after it left the queue.
 * `null` while it is still queued.
 */
function retentionEndsAt(send: SendDataFields): number | null {
	if (send.status === 'queued') return null;
	const finishedAt = Math.max(send._creationTime, send.sentAt ?? 0, send.failedAt ?? 0);
	return finishedAt + SEND_DATA_VARIABLES_RETENTION_MS;
}

/**
 * A send as a reader may see it: `dataVariables` only for a reader who may edit
 * transactional templates and only until the sweep, the names always, and when
 * the values will be removed.
 */
export function withDataVariablesForViewer<T extends SendDataFields>(
	send: T,
	canReadValues: boolean
): Omit<T, 'dataVariables'> & {
	dataVariables?: SendDataFields['dataVariables'];
	dataVariableNames: string[];
	dataVariablesAccess: DataVariablesAccess;
	dataVariablesRemovedAfter?: number;
} {
	const { dataVariables, ...rest } = send;
	const dataVariableNames = send.dataVariableNames ?? Object.keys(dataVariables ?? {});
	const access: DataVariablesAccess =
		send.dataVariablesRedactedAt !== undefined ? 'redacted' : canReadValues ? 'visible' : 'hidden';
	const removedAfter = access === 'redacted' ? null : retentionEndsAt(send);
	return {
		...rest,
		...(access === 'visible' && dataVariables !== undefined ? { dataVariables } : {}),
		dataVariableNames,
		dataVariablesAccess: access,
		...(removedAfter !== null ? { dataVariablesRemovedAfter: removedAfter } : {}),
	};
}

/**
 * The patch that ends a send's retention, or `null` while it must wait: a send
 * still `queued` is not finished, and a finished one keeps its values for the
 * window after it left the queue.
 */
export function dataVariablesRetentionPatch(
	send: Doc<'transactionalSends'>,
	now: number
): Partial<Doc<'transactionalSends'>> | null {
	const endsAt = retentionEndsAt(send);
	if (endsAt === null || endsAt > now) return null;
	const names = Object.keys(send.dataVariables ?? {});
	return {
		dataVariables: undefined,
		...(names.length > 0 ? { dataVariableNames: names } : {}),
		dataVariablesRedactedAt: now,
	};
}

/**
 * Remove the values of every template send whose retention ended. Walks the
 * sends the sweep has not passed yet, oldest first, up to those created a
 * window ago; a send skipped because it is still queued or only just finished
 * is met again on a later run. Rows written before the sweep existed are
 * walked the same way.
 */
export const sweepDataVariables = internalMutation({
	args: { cursor: v.optional(v.string()), startedAt: v.optional(v.number()) },
	handler: async (ctx, args): Promise<{ examined: number; redacted: number }> => {
		const now = Date.now();
		// Pinned for the whole walk: a continuation must repeat the first page's
		// index range for its cursor to stay valid.
		const startedAt = args.startedAt ?? now;
		const page = await ctx.db
			.query('transactionalSends')
			.withIndex('by_kind_data_variables_redacted', (q) =>
				q
					.eq('kind', 'transactional')
					.eq('dataVariablesRedactedAt', undefined)
					.lt('_creationTime', startedAt - SEND_DATA_VARIABLES_RETENTION_MS)
			)
			.paginate({ cursor: args.cursor ?? null, numItems: SWEEP_BATCH });

		let redacted = 0;
		for (const send of page.page) {
			const patch = dataVariablesRetentionPatch(send, now);
			if (!patch) continue;
			await ctx.db.patch(send._id, patch);
			redacted++;
		}
		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.transactional.sendDataRetention.sweepDataVariables, {
				cursor: page.continueCursor,
				startedAt,
			});
		}
		return { examined: page.page.length, redacted };
	},
});
