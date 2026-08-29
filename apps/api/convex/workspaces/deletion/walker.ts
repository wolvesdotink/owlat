/**
 * Organization deletion walker — owns the entry point (`start`) called by
 * `organizationSettings.remove` and the self-scheduled `runStep` hop. The
 * ordered cascade list and the typed dispatch registry it drives live in the
 * sibling `steps/registry.ts` (split out for the ~500 LOC ratchet): WHAT gets
 * deleted and in what order is a data decision that changes with every new
 * table, while the lifecycle plumbing here does not.
 *
 * Pattern mirrors the **Step walker** (ADR-0004, automations), the
 * **Agent walker** (inbox agent pipeline), and the **IMAP command
 * walker** (ADR-0016): typed dispatch table, pure per-kind modules,
 * walker owns lifecycle plumbing.
 *
 * See docs/adr/0025-organization-deletion-module-family.md.
 */

import { internalMutation } from '../../_generated/server';
import { internal } from '../../_generated/api';
import {
	organizationDeletionTableValidator,
	type OrganizationDeletionTable,
} from './steps/_common';
import { ORGANIZATION_DELETION_STEPS, STEPS } from './steps/registry';

/**
 * Returns the next table after `table` in `STEPS`, or `null` if `table`
 * is the terminal step. The terminal-discipline is encoded here once
 * — pre-deepening, each switch case asserted `getNextStep(step)!`
 * non-null at the boundary and relied on the terminal case's earlier
 * `return` to dodge a null-deref. Drift #6.
 */
export function nextTable(table: OrganizationDeletionTable): OrganizationDeletionTable | null {
	const idx = STEPS.indexOf(table);
	if (idx === -1 || idx === STEPS.length - 1) return null;
	return STEPS[idx + 1] ?? null;
}

/**
 * Entry point — called by `organizationSettings.remove`. Schedules the
 * first step. Zero-arg: the wipe operates on the single-org-per-
 * deployment data plane, so there's nothing to scope to.
 */
export const start = internalMutation({
	args: {},
	handler: async (ctx) => {
		await ctx.scheduler.runAfter(0, internal.workspaces.deletion.walker.runStep, {
			table: STEPS[0],
		});
	},
});

/**
 * Self-scheduled walker hop. Runs one batch via the dispatch registry;
 * re-fires the same step while `hasMore`; advances to the next step
 * when `hasMore` flips to false; terminates when there's no next step.
 *
 * The `table` arg is validated against the literal union — a typo is
 * a compile-time + boot-time error, not a silent runtime no-op.
 * Drift #5.
 */
export const runStep = internalMutation({
	args: { table: organizationDeletionTableValidator },
	handler: async (ctx, { table }) => {
		const mod = ORGANIZATION_DELETION_STEPS[table];
		const { hasMore } = await mod.deleteBatch(ctx);

		if (hasMore) {
			await ctx.scheduler.runAfter(0, internal.workspaces.deletion.walker.runStep, { table });
			return;
		}

		const next = nextTable(table);
		if (next === null) return;

		await ctx.scheduler.runAfter(0, internal.workspaces.deletion.walker.runStep, {
			table: next,
		});
	},
});
