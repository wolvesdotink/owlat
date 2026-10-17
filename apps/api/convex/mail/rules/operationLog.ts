/**
 * Read on arrival (SPEC §2.9, §4.4, §6.2, §6.4): the undo log of rule work.
 * One operation header per message and pass (`rule_apply`, or
 * `delayed_archive` for an executed delayed action), created on the first
 * change it logs, its change rows built by `arrivalChangeRow` and written in
 * the same mutation as the change itself.
 *
 * Isolate-safe; not a Convex function.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { ArrivalOperationChangeRow } from '../../lib/validators/arrival';
import { ARRIVAL_RETENTION_MS, arrivalChangeRow } from '../arrival/changeRows';

type OperationHeader = Pick<
	Doc<'mailArrivalOperations'>,
	'mailboxId' | 'kind' | 'actor' | 'threadId' | 'messageId' | 'filterId'
>;

/** An operation that exists once something is logged under it. */
export class RuleOperationLog {
	private operationId: Id<'mailArrivalOperations'> | null = null;
	private count = 0;

	constructor(
		private readonly ctx: MutationCtx,
		private readonly header: OperationHeader,
		private readonly now: number
	) {}

	/** The operation's id, creating the header if nothing was logged yet. */
	async ensure(): Promise<Id<'mailArrivalOperations'>> {
		if (this.operationId) return this.operationId;
		this.operationId = await this.ctx.db.insert('mailArrivalOperations', {
			...this.header,
			changeCount: 0,
			status: 'applied',
			createdAt: this.now,
			expiresAt: this.now + ARRIVAL_RETENTION_MS.operation,
		});
		return this.operationId;
	}

	/** Log one change row under the operation. */
	async add(change: ArrivalOperationChangeRow, isNeedsReplyCleared?: boolean): Promise<void> {
		const operationId = await this.ensure();
		await this.ctx.db.insert(
			'mailArrivalOperationChanges',
			arrivalChangeRow({
				operationId,
				mailboxId: this.header.mailboxId,
				change,
				isNeedsReplyCleared,
				now: this.now,
			})
		);
		this.count += 1;
	}

	/** Write the change count; returns the operation's id, or null when nothing was logged. */
	async finish(): Promise<Id<'mailArrivalOperations'> | null> {
		if (this.operationId && this.count > 0) {
			await this.ctx.db.patch(this.operationId, { changeCount: this.count });
		}
		return this.operationId;
	}
}
