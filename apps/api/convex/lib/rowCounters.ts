/**
 * The maintained counts (plan 3.1) for a row of a table only known at runtime —
 * the generic writers (the demo seed and the sample-data install/removal) that
 * insert or delete rows of several tables through one code path.
 *
 * Code that writes one known table calls `recordListingCounter` /
 * `recordContactGrowth` directly.
 */

import type { Doc, TableNames } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { recordContactGrowth } from '../contacts/growthCounters';
import { recordListingCounter } from './listingCounters';

type AnyRow = { _creationTime: number } & Record<string, unknown>;

/** Move the counters for one row of `table`; a table with no counter is a no-op. */
export async function recordTableRowCounters(
	ctx: MutationCtx,
	table: TableNames,
	before: Doc<TableNames> | null,
	after: Doc<TableNames> | null
): Promise<void> {
	// Narrowing `table` does not narrow the row's type; the case is the guarantee.
	const was = before as unknown as AnyRow | null;
	const now = after as unknown as AnyRow | null;
	switch (table) {
		case 'campaigns':
			return recordListingCounter(ctx, 'campaignStatus', was, now);
		case 'emailTemplates':
			return recordListingCounter(ctx, 'templateType', was, now);
		case 'automations':
			return recordListingCounter(ctx, 'automationStatus', was, now);
		case 'contacts':
			return recordContactGrowth(
				ctx,
				before as unknown as Doc<'contacts'> | null,
				after as unknown as Doc<'contacts'> | null
			);
	}
}
