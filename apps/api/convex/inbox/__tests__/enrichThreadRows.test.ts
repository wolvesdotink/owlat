/**
 * `enrichThreadRows` resolves each distinct assignee once per call.
 *
 * Rows are enriched concurrently, so a cache filled only after the profile read
 * resolves lets every row with the same assignee start its own read. The fake
 * reader answers asynchronously, the way `ctx.db` does, and counts the reads.
 */

import { describe, it, expect } from 'vitest';
import type { QueryCtx } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import { enrichThreadRows } from '../queries';

type Profile = { authUserId: string; name?: string; email: string; image?: string };

function countingReader(profiles: Profile[]) {
	const reads = { userProfiles: 0, threadReads: 0 };
	const db = {
		query(table: 'userProfiles' | 'threadReads') {
			return {
				withIndex(_name: string, range: (q: unknown) => unknown) {
					const eqs: Record<string, unknown> = {};
					const q = {
						eq(field: string, value: unknown) {
							eqs[field] = value;
							return q;
						},
					};
					range(q);
					const answer = async () => {
						reads[table] += 1;
						// Resolve on a later tick, as a real index read does.
						await Promise.resolve();
						await Promise.resolve();
						if (table === 'threadReads') return null;
						return profiles.find((p) => p.authUserId === eqs['authUserId']) ?? null;
					};
					return { first: answer, unique: answer };
				},
			};
		},
	};
	return { ctx: { db } as unknown as QueryCtx, reads };
}

function threadRows(assignees: Array<string | undefined>): Doc<'conversationThreads'>[] {
	return assignees.map(
		(assignedTo, i) =>
			({
				_id: `thread-${i}` as Id<'conversationThreads'>,
				_creationTime: i,
				lastMessageAt: 1_000 + i,
				...(assignedTo ? { assignedTo } : {}),
			}) as unknown as Doc<'conversationThreads'>
	);
}

const ANA: Profile = { authUserId: 'user-ana', name: 'Ana', email: 'ana@owlat.test' };
const BEN: Profile = { authUserId: 'user-ben', name: 'Ben', email: 'ben@owlat.test' };

describe('enrichThreadRows assignee reads', () => {
	it('reads one profile for 20 rows that share an assignee', async () => {
		const { ctx, reads } = countingReader([ANA]);
		const rows = await enrichThreadRows(ctx, threadRows(Array(20).fill(ANA.authUserId)), 'viewer');

		expect(reads).toEqual({ userProfiles: 1, threadReads: 20 });
		expect(rows.map((r) => r.assignee)).toEqual(
			Array.from({ length: 20 }, () => ({ name: 'Ana', email: 'ana@owlat.test', image: undefined }))
		);
	});

	it('reads two profiles for 20 rows split between two assignees', async () => {
		const { ctx, reads } = countingReader([ANA, BEN]);
		const assignees = Array.from({ length: 20 }, (_, i) =>
			i % 2 === 0 ? ANA.authUserId : BEN.authUserId
		);
		const rows = await enrichThreadRows(ctx, threadRows(assignees), 'viewer');

		expect(reads).toEqual({ userProfiles: 2, threadReads: 20 });
		expect(rows.map((r) => r.assignee?.name)).toEqual(
			assignees.map((a) => (a === ANA.authUserId ? 'Ana' : 'Ben'))
		);
	});

	it('reads a missing profile once and leaves unassigned rows unread', async () => {
		const { ctx, reads } = countingReader([]);
		const rows = await enrichThreadRows(
			ctx,
			threadRows([...Array(10).fill('user-gone'), ...Array(10).fill(undefined)]),
			'viewer'
		);

		expect(reads).toEqual({ userProfiles: 1, threadReads: 20 });
		expect(rows.every((r) => r.assignee === null)).toBe(true);
	});
});
