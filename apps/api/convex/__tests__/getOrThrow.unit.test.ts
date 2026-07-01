/**
 * Unit tests for `getOrThrow` in `_utils/errors.ts`.
 *
 * No Convex setup: `getOrThrow` only depends on `ctx.db.get`, so a stub reader
 * exercises both branches — the document is returned when present, and a
 * `not_found` `ConvexError` is thrown (via `throwNotFound`) when it is null.
 */

import { describe, it, expect } from 'vitest';
import { ConvexError } from 'convex/values';
import { getOrThrow } from '../_utils/errors';
import type { Doc, Id } from '../_generated/dataModel';

describe('getOrThrow', () => {
	it('returns the document when present', async () => {
		const doc = { _id: 'x' } as unknown as Doc<'contacts'>;
		const ctx = { db: { get: async () => doc } };
		const result = await getOrThrow(ctx, 'x' as Id<'contacts'>, 'Contact');
		expect(result).toBe(doc);
	});

	it('throws a not_found ConvexError when the document is null', async () => {
		const ctx = { db: { get: async () => null } };
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
