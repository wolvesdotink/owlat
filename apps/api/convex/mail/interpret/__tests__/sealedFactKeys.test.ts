/**
 * Final review: fact keys are never stored in plaintext. New facts carry a
 * keyed hash and a sealed label; matching (restatement, conflict, a re-read)
 * runs on the hash, also against a row from before (plaintext `factKey`).
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import type { ReduceFact, ReduceResult } from '../reduceInput';
import { factKeyHash, normalizeFactKey } from '../factKeys';
import {
	addMessageToThread,
	modules,
	reduceResult,
	seedMailThread,
	type Test,
} from './interpret.testlib';

vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../lib/sessionOrganization');
	const session = { userId: 'user-A', role: 'owner', activeOrganizationId: 'org-1' };
	return { ...actual, getMutationContext: vi.fn(async () => session) };
});

const T1 = Date.UTC(2026, 9, 5, 9, 0);
const T2 = Date.UTC(2026, 9, 6, 9, 0);
const KEY = '["dr. jane roe","diagnosis",""]';

async function apply(
	t: Test,
	id: Id<'mailMessages'>,
	threadId: Id<'mailThreads'>,
	result: ReduceResult,
	sourceAt = T1
) {
	const revision = await t.run(
		async (ctx) =>
			(
				await ctx.db
					.query('threadBriefs')
					.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
					.first()
			)?.interpretationRevision ?? 0
	);
	return t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
		source: { kind: 'mail', id },
		threadRef: { kind: 'mail', id: threadId },
		mode: 'brief',
		contentRevision: 'rev-1',
		extractorVersion: 4,
		expectedRevision: revision,
		deletionEpoch: 0,
		sourceAt,
		direction: 'inbound',
		status: 'complete',
		result,
	});
}

const fact = (over: Partial<ReduceFact> = {}): ReduceFact => ({
	key: KEY,
	assertion: 'Jane Roe is referred to oncology',
	display: { en: 'Referral: oncology', de: 'Überweisung: Onkologie' },
	value: { kind: 'text', text: 'oncology' },
	evidence: [{ segmentId: 's0', start: 0, end: 8, quote: 'oncology' }],
	isVerified: false,
	isReviewNeeded: false,
	...over,
});

const facts = (t: Test, threadId: Id<'mailThreads'>) =>
	t.run(async (ctx) =>
		ctx.db
			.query('threadFacts')
			.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', threadId))
			.collect()
	);

describe('sealed fact keys', () => {
	it('stores a keyed hash and a label, never the plaintext key', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		await apply(t, messageId, threadId, reduceResult({ items: [], facts: [fact()] }));
		const [row] = await facts(t, threadId);
		expect(row?.factKey).toBeUndefined();
		expect(row?.factKeyHash).toBe(await factKeyHash(KEY));
		expect(row?.factKeyHash).not.toContain('jane');
		expect(row?.factKeyLabel).toBe(KEY); // no INSTANCE_SECRET in the harness: not sealed
		expect(await factKeyHash('  ["Dr. Jane Roe","diagnosis",""] ')).toBe(await factKeyHash(KEY));
		expect(normalizeFactKey(' A  B ')).toBe('a b');
	});

	it('a restatement merges and a different value conflicts, also against a row from before', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId: a, threadId } = await seedMailThread(t);
		const b = await addMessageToThread(t, { mailboxId, threadId }, { text: 'x', receivedAt: T2 });
		const c = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{ text: 'y', receivedAt: T2 + 1 }
		);
		await apply(t, a, threadId, reduceResult({ items: [], facts: [fact()] }));
		// As a row written before sealed keys: plaintext key only.
		await t.run(async (ctx) => {
			const row = (await ctx.db.query('threadFacts').first())!;
			await ctx.db.patch(row._id, {
				factKey: KEY,
				factKeyHash: undefined,
				factKeyLabel: undefined,
			});
		});
		await apply(
			t,
			b,
			threadId,
			reduceResult({
				items: [],
				facts: [fact({ evidence: [{ segmentId: 's0', start: 0, end: 1, quote: 'x' }] })],
			}),
			T2
		);
		expect(await facts(t, threadId)).toHaveLength(1);
		await apply(
			t,
			c,
			threadId,
			reduceResult({
				items: [],
				facts: [
					fact({
						assertion: 'Jane Roe is referred to cardiology',
						value: { kind: 'text', text: 'cardiology' },
						evidence: [{ segmentId: 's0', start: 0, end: 1, quote: 'y' }],
					}),
				],
			}),
			T2 + 1
		);
		const rows = await facts(t, threadId);
		expect(rows).toHaveLength(2);
		const conflict = rows.find((r) => r.conflictsWithId !== undefined);
		expect(conflict?.factKeyHash).toBe(await factKeyHash(KEY));
	});
});
