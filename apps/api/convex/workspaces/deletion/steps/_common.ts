/**
 * Organization deletion step (module) — interface + shared helpers.
 *
 * Each step module owns one deletable table. Per-module unit-testable;
 * the **Organization deletion walker** in `../walker.ts` owns the loop
 * (batch repeats vs next-step advance) and the typed dispatch.
 */

import type { MutationCtx } from '../../../_generated/server';
import type { OrganizationDeletionTable } from './tables';

export { type OrganizationDeletionTable, organizationDeletionTableValidator } from './tables';

export const DEFAULT_BATCH_SIZE = 100;

interface DeleteBatchOutcome {
	deletedCount: number;
	hasMore: boolean;
}

/**
 * Contract for one **Organization deletion step (module)**. Each module
 * owns one table — see the file under `steps/<table>.ts`.
 *
 * The walker calls `deleteBatch` and re-fires the same step until
 * `hasMore: false`. Per-row storage purges happen inside `deleteBatch`, still
 * per-row rather than per-batch, so they do not surface in the walker-facing
 * interface. They happen AFTER each `ctx.db.delete`, not before: a blob can be
 * shared by several rows (IMAP COPY — see `deleteMessageRowAndBlobs` in
 * `mail/messagePurge.ts`), and deleting the row first is what lets the step ask
 * the index whether anything still references the blob without having to
 * special-case the row it is in the middle of deleting.
 */
export interface OrganizationDeletionStepModule<T extends OrganizationDeletionTable> {
	readonly table: T;
	readonly batchSize?: number;
	deleteBatch(ctx: MutationCtx): Promise<DeleteBatchOutcome>;
}

/**
 * Declare a step module, keeping the literal `table` type so the registry is
 * type-safe per key (`ORGANIZATION_DELETION_STEPS['mediaAssets'].table`).
 */
export function defineStep<T extends OrganizationDeletionTable>(
	module: OrganizationDeletionStepModule<T>
): OrganizationDeletionStepModule<T> {
	return module;
}
