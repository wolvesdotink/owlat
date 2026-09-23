import type { GenericQueryCtx } from 'convex/server';
import type { DataModel, Id } from '../../_generated/dataModel';
import { CONTACT_RELATIONS } from '../../contacts/erasure/relations';

/**
 * Every row that still references `contactId` through a relation the erasure
 * must clear (`delete` or `unlink` in the registry), as `table.field` strings.
 *
 * Scans whole tables, which is fine for a convex-test fixture and means the
 * check follows the registry instead of a hand-kept list of indexes.
 */
export async function danglingContactReferences(
	ctx: GenericQueryCtx<DataModel>,
	contactId: Id<'contacts'>
): Promise<string[]> {
	const dangling: string[] = [];
	for (const relation of CONTACT_RELATIONS) {
		if (relation.action === 'retain') continue;
		const isArray = relation.field.endsWith('[]');
		const field = isArray ? relation.field.slice(0, -2) : relation.field;
		const rows = await ctx.db.query(relation.table).collect();
		for (const row of rows) {
			const value = (row as Record<string, unknown>)[field];
			const hit = isArray ? Array.isArray(value) && value.includes(contactId) : value === contactId;
			if (hit) dangling.push(`${relation.table}.${relation.field}`);
		}
	}
	return dangling;
}
