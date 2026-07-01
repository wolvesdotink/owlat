/**
 * Unit tests for `getOrThrow` in `_utils/errors.ts`.
 *
 * No Convex setup: `getOrThrow` only depends on `ctx.db.get`, so a stub reader
 * exercises both branches — the document is returned when present, and a
 * `not_found` `ConvexError` is thrown (via `throwNotFound`) when it is null.
 *
 * The stub `get` is generic over `TableNames`, mirroring the real Convex
 * `db.get`. This keeps `getOrThrow`'s single inference site (`id`) honest: a
 * monomorphic stub would let a broken signature (where `T` also infers from
 * `ctx.db.get`) pass here while failing at real call sites.
 */

import { describe, it, expect } from 'vitest';
import { ConvexError } from 'convex/values';
import { getOrThrow } from '../_utils/errors';
import type { Doc, Id, TableNames } from '../_generated/dataModel';

describe('getOrThrow', () => {
	it('returns the document when present', async () => {
		const doc = { _id: 'x' } as unknown as Doc<'contacts'>;
		const ctx = {
			db: { get: async <TN extends TableNames>(_id: Id<TN>) => doc as unknown as Doc<TN> },
		};
		const result = await getOrThrow(ctx, 'x' as Id<'contacts'>, 'Contact');
		expect(result).toBe(doc);
	});

	it('narrows the return type to the requested table (compile-time guard)', async () => {
		const doc = { _id: 'x' } as unknown as Doc<'contacts'>;
		const ctx = {
			db: { get: async <TN extends TableNames>(_id: Id<TN>) => doc as unknown as Doc<TN> },
		};
		const contact = await getOrThrow(ctx, 'x' as Id<'contacts'>, 'Contact');
		// Fails to compile if `T` ever widens to the full `TableNames` union again
		// (i.e. if `ctx.db.get` reintroduces a second inference site for `T`).
		const narrowed: Doc<'contacts'> = contact;
		expect(narrowed).toBe(doc);
	});

	it('throws a not_found ConvexError when the document is null', async () => {
		const ctx = {
			db: { get: async <TN extends TableNames>(_id: Id<TN>): Promise<Doc<TN> | null> => null },
		};
		await expect(
			getOrThrow(ctx, 'missing' as Id<'contacts'>, 'Contact'),
		).rejects.toBeInstanceOf(ConvexError);
		try {
			await getOrThrow(ctx, 'missing' as Id<'contacts'>, 'Contact');
			expect.unreachable('should have thrown');
		} catch (err) {
			const data = (err as ConvexError<{ category: string; message: string }>).data;
			expect(data.category).toBe('not_found');
			expect(data.message).toBe('Contact not found');
		}
	});
});
