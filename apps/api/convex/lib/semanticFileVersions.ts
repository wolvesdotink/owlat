/**
 * Walking a file's version chain (`semanticFiles.previousVersionId`), newest
 * first.
 *
 * A new version points at the one it replaces, so the history of a file is a
 * linked list read one `ctx.db.get` at a time. Two readers walk it:
 *
 *   - `semanticFiles.getVersionHistory` (legacy) walks to the end of the chain
 *     with no budget, as it always has: a cap there would cut an older
 *     client's list short with no way to say so;
 *   - `files.history.list` walks at most `budget` rows per call and hands back
 *     where it stopped, so a long chain is read a page at a time.
 *
 * Both stop at a row they already visited. `create` only links a new row to an
 * existing one, so the app cannot make a loop, but a loop in stored data would
 * otherwise spin until the query hit the read limit and failed.
 *
 * Every visited row is read whole (a get cannot project), then offered to
 * `canRead`; a row the caller may not read is left out but still walked
 * through, so a permitted older version behind it is reached.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';

export interface VersionChainStep {
	/** Rows the caller may read, newest first. */
	readable: Doc<'semanticFiles'>[];
	/**
	 * The next row to visit when the budget ran out first; null when the walk
	 * reached the end of the chain: no predecessor, a predecessor that no
	 * longer exists, or a row this walk already visited.
	 */
	next: Id<'semanticFiles'> | null;
}

export async function walkVersionChain(
	ctx: Pick<QueryCtx, 'db'>,
	startId: Id<'semanticFiles'>,
	canRead: (file: Doc<'semanticFiles'>) => Promise<boolean>,
	budget: number = Number.POSITIVE_INFINITY
): Promise<VersionChainStep> {
	const visited = new Set<Id<'semanticFiles'>>();
	const readable: Doc<'semanticFiles'>[] = [];
	let currentId: Id<'semanticFiles'> | undefined = startId;

	while (currentId && !visited.has(currentId) && visited.size < budget) {
		visited.add(currentId);
		const file: Doc<'semanticFiles'> | null = await ctx.db.get(currentId);
		if (!file) return { readable, next: null };
		if (await canRead(file)) readable.push(file);
		currentId = file.previousVersionId;
	}

	return { readable, next: currentId && !visited.has(currentId) ? currentId : null };
}
