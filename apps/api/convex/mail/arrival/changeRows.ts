/**
 * Read on arrival: the `expiresAt` horizons of the arrival tables and the one
 * builder of an undo-log change row (SPEC §2.9, §4.4).
 *
 * Every writer of `mailArrivalOperationChanges` builds its row here, so the
 * top-level `messageId` / `labelId` that a message purge and the erasure
 * registry find rows by can never disagree with the change they copy.
 *
 * Isolate-safe; not a Convex function.
 */

import type { WithoutSystemFields } from 'convex/server';
import type { Doc, Id } from '../../_generated/dataModel';
import { DAY_MS } from '../../lib/constants';
import type { ArrivalOperationChangeRow } from '../../lib/validators/arrival';

/** How long each arrival table keeps a row (`maintenance/retention.ts` sweeps `expiresAt`). */
export const ARRIVAL_RETENTION_MS = {
	arrivalRecord: 90 * DAY_MS,
	operation: 30 * DAY_MS,
	ruleDraft: 7 * DAY_MS,
	digest: 30 * DAY_MS,
} as const;

/** The message a change names, if any. */
export function changeMessageId(change: ArrivalOperationChangeRow): Id<'mailMessages'> | undefined {
	return 'messageId' in change ? change.messageId : undefined;
}

/** The fields of one change row, written in the same mutation as the change. */
export function arrivalChangeRow(args: {
	operationId: Id<'mailArrivalOperations'>;
	mailboxId: Id<'mailboxes'>;
	change: ArrivalOperationChangeRow;
	/** An archive cleared a reply-queue verdict undo does not restore. */
	isNeedsReplyCleared?: boolean;
	now: number;
}): WithoutSystemFields<Doc<'mailArrivalOperationChanges'>> {
	const messageId = changeMessageId(args.change);
	return {
		operationId: args.operationId,
		mailboxId: args.mailboxId,
		change: args.change,
		...(messageId ? { messageId } : {}),
		...(args.change.kind === 'messageLabel' ? { labelId: args.change.labelId } : {}),
		...(args.isNeedsReplyCleared ? { isNeedsReplyCleared: true } : {}),
		createdAt: args.now,
		expiresAt: args.now + ARRIVAL_RETENTION_MS.operation,
	};
}
