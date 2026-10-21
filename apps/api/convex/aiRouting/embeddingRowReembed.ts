/**
 * Re-embedding one edited row.
 *
 * An edit to a row's embedding input clears its vectors in every column
 * (`inputChangeFields`), so the row leaves vector search until it is embedded
 * again. With a local embedder that happens at once: the edit schedules
 * `embeddingReembed.reembedRow`, which reads the row here, embeds it, and
 * commits through `commitRowVector`. A hosted embedder costs money, so the row
 * waits for the admin re-embed (admitted per batch).
 */

import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import { internalQuery } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import {
	ownsColumn,
	readSearchableSpace,
	slotFields,
	spaceRefOf,
	vectorInSpace,
} from '../lib/aiRouting/embeddingRegistry';
import { inputFingerprint } from '../lib/aiRouting/embeddingInputs';
import { ensureConfiguredSpace, patchCorpusRow } from '../lib/aiRouting/embeddingActivation';
import {
	embeddingTableValidator,
	measuredEmbeddingSpaceValidator,
} from '../lib/validators/embedding';
import { rowInput } from './embeddingReembedJobs';

/** The row's input, when it has one and lacks a vector in the searchable space. */
export const rowForReembed = internalQuery({
	args: { table: embeddingTableValidator, id: v.string() },
	handler: async (ctx, args): Promise<{ text: string; fingerprint: string } | null> => {
		const id = ctx.db.normalizeId(args.table, args.id);
		const row = id ? await ctx.db.get(id) : null;
		const searchable = await readSearchableSpace(ctx.db);
		if (!row || !searchable || vectorInSpace(row, spaceRefOf(searchable))) return null;
		const text = rowInput(args.table, row, Date.now());
		return text ? { text, fingerprint: inputFingerprint(text) } : null;
	},
});

/**
 * Write the row's fresh vector into the searchable space's column, when the
 * vector is in that space, the space still owns its column, the row still has
 * the input that was embedded, and it has no vector there yet.
 */
export const commitRowVector = internalMutation({
	args: {
		table: embeddingTableValidator,
		id: v.string(),
		fingerprint: v.string(),
		vector: v.array(v.float64()),
		space: measuredEmbeddingSpaceValidator,
	},
	handler: async (ctx, args): Promise<boolean> => {
		// The space the vector is in, by the commit path's rule: a new identity of
		// the configured target (the served model's revision moved) becomes the
		// active space here, and its activation re-embeds the rest.
		const searchable = await ensureConfiguredSpace(ctx, args.space);
		if (!searchable || !(await ownsColumn(ctx.db, searchable))) return false;
		const id = ctx.db.normalizeId(args.table, args.id);
		const row = id ? await ctx.db.get(id) : null;
		if (!row || vectorInSpace(row, spaceRefOf(searchable))) return false;
		const text = rowInput(args.table, row, Date.now());
		if (!text || inputFingerprint(text) !== args.fingerprint) return false;
		const entryType =
			args.table === 'knowledgeEntries' ? (row as Doc<'knowledgeEntries'>).entryType : undefined;
		await patchCorpusRow(
			ctx,
			args.table,
			row,
			slotFields(searchable, args.vector, { now: Date.now(), entryType }),
			{ written: searchable.slot }
		);
		return true;
	},
});
