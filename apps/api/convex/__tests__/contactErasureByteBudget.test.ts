import { describe, expect, it } from 'vitest';
import type { TestConvex } from 'convex-test';
import type schema from '../schema';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { createTestContact } from './factories';
import { newHarness } from './testModules';
import { ErasureBudget, estimateDocumentBytes } from '../contacts/erasure/budget';
import { drainEach } from '../contacts/erasure/phaseKit';
import { advanceErasure, type ErasurePosition } from '../contacts/erasure/phases';
import {
	ERASURE_BYTES_PER_TRANSACTION,
	ERASURE_ROWS_PER_TRANSACTION,
} from '../contacts/erasure/walker';

/**
 * The contact-erasure byte budget: every transaction's reads are bounded
 * BEFORE they happen, measured in encoded bytes, and every read is charged.
 * The walker under enforced platform limits is in
 * `contactErasureLimits.integration.test.ts`.
 */

type Harness = TestConvex<typeof schema>;

const KiB = 1024;
const MiB = 1024 * KiB;
const utf8 = (text: string) => new TextEncoder().encode(text).length;

/** `ctx` whose database hands every document it returns to `onRead`. */
function recordingCtx(ctx: MutationCtx, onRead: (doc: Record<string, unknown>) => void) {
	const record = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) record(item);
		} else if (value !== null && typeof value === 'object') {
			if ('page' in value && Array.isArray(value.page)) record(value.page);
			else if ('_id' in value) onRead(value as Record<string, unknown>);
		}
	};
	const wrap = <T extends object>(target: T): T =>
		new Proxy(target, {
			get(object, property) {
				const value: unknown = Reflect.get(object, property, object);
				if (typeof value !== 'function' || typeof property === 'symbol') return value;
				return (...args: unknown[]) => {
					const result: unknown = value.apply(object, args);
					if (result instanceof Promise) {
						return result.then((resolved: unknown) => {
							record(resolved);
							return resolved;
						});
					}
					return result !== null && typeof result === 'object' ? wrap(result) : result;
				};
			},
		});
	return { ...ctx, db: wrap(ctx.db) } as MutationCtx;
}

describe('byte bounds before reads', () => {
	it('crosses 32 rows of 600 KiB in several transactions under a 16 MiB read ceiling', async () => {
		let remaining = Array.from({ length: 32 }, (_, i) => ({
			_id: `row${i}`,
			body: 'x'.repeat(600 * KiB),
		}));
		const bytesPerTransaction: number[] = [];
		while (remaining.length > 0 && bytesPerTransaction.length < 64) {
			// The platform: a transaction that reads past 16 MiB fails.
			let bytesRead = 0;
			const budget = new ErasureBudget(ERASURE_ROWS_PER_TRANSACTION, ERASURE_BYTES_PER_TRANSACTION);
			await drainEach(
				budget,
				async (limit) => {
					const rows = remaining.slice(0, limit);
					for (const row of rows) bytesRead += utf8(row.body);
					if (bytesRead > 16 * MiB) throw new Error('Read too much data');
					return rows;
				},
				async (row) => {
					remaining = remaining.filter((r) => r !== row);
				}
			);
			bytesPerTransaction.push(bytesRead);
		}

		expect(remaining).toHaveLength(0);
		expect(bytesPerTransaction.length).toBeGreaterThan(1);
		for (const bytes of bytesPerTransaction) {
			expect(bytes).toBeGreaterThan(0);
			expect(bytes).toBeLessThanOrEqual(ERASURE_BYTES_PER_TRANSACTION);
		}
	});

	it('counts CJK text at its UTF-8 size: 16 × 250,000 characters exhaust 4 MiB', () => {
		const doc = { _id: 'cjk', body: '漢'.repeat(250_000) };
		expect(estimateDocumentBytes(doc)).toBeGreaterThanOrEqual(utf8(doc.body));

		const budget = new ErasureBudget(ERASURE_ROWS_PER_TRANSACTION, 4 * MiB);
		for (let i = 0; i < 16; i++) budget.charge(doc);
		expect(budget.isExhausted).toBe(true);
	});

	it('never under-counts ASCII, CJK or astral text', () => {
		const growth = (text: string) =>
			estimateDocumentBytes({ body: text }) - estimateDocumentBytes({ body: '' });
		expect(growth('a'.repeat(1000))).toBe(1000);
		expect(growth('é'.repeat(1000))).toBe(2000);
		expect(growth('中'.repeat(1000))).toBe(3000);
		// Two UTF-16 units each, four bytes each.
		expect(growth('😀'.repeat(1000))).toBe(4000);

		for (const text of ['plain', 'Grüße', '中文字符', '😀🎉𝄞', 'a中😀é'.repeat(700)]) {
			const doc = { _id: 'id', body: text };
			expect(estimateDocumentBytes(doc)).toBeGreaterThanOrEqual(
				utf8(text) + utf8('_id') + utf8('id') + utf8('body')
			);
		}
	});

	it('keeps a batch of mixed-script rows inside the encoded byte allowance', async () => {
		// 8 bytes per 4 UTF-16 units: `length` sees half of what is stored.
		const rows = Array.from({ length: 12 }, (_, i) => ({
			_id: `mixed${i}`,
			body: 'a中😀'.repeat(90_000),
		}));
		const budget = new ErasureBudget(ERASURE_ROWS_PER_TRANSACTION, 3 * MiB);
		let encodedRead = 0;
		await drainEach(
			budget,
			async (limit) => {
				const batch = rows.splice(0, limit);
				for (const row of batch) encodedRead += utf8(row.body);
				return batch;
			},
			async () => {}
		);
		expect(encodedRead).toBeGreaterThan(0);
		expect(encodedRead).toBeLessThanOrEqual(3 * MiB);
		expect(budget.bytes).toBeGreaterThanOrEqual(encodedRead);
		expect(rows.length).toBeGreaterThan(0);
	});
});

describe('every read is charged', () => {
	async function seedContact(t: Harness): Promise<Id<'contacts'>> {
		return t.run((ctx) =>
			ctx.db.insert(
				'contacts',
				createTestContact({ email: 'budget@example.com', deletedAt: Date.now() })
			)
		);
	}

	it('charges every send read and pages a long history 128 at a time', async () => {
		const t = newHarness();
		const contactId = await seedContact(t);
		await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert('campaigns', {
				name: 'C',
				status: 'sent' as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			for (let i = 0; i < 200; i++) {
				await ctx.db.insert('emailSends', {
					campaignId,
					contactId,
					contactEmail: 'budget@example.com',
					contactFirstName: 'Budget',
					status: 'sent' as const,
					queuedAt: Date.now(),
				});
			}
		});

		let position: ErasurePosition = { phase: 'emailSends' };
		let transactions = 0;
		while (position.phase === 'emailSends' && transactions < 100) {
			transactions += 1;
			position = await t.run(async (ctx) => {
				const fetched: Record<string, unknown>[] = [];
				const budget = new ErasureBudget(
					ERASURE_ROWS_PER_TRANSACTION,
					ERASURE_BYTES_PER_TRANSACTION
				);
				const progress = await advanceErasure(
					recordingCtx(ctx, (doc) => fetched.push(doc)),
					contactId,
					position,
					budget,
					'walker'
				);
				// Only the probe's few rows are read a second time, by the page.
				const sendIds = fetched.filter((doc) => 'contactEmail' in doc).map((doc) => doc['_id']);
				expect(sendIds.length - new Set(sendIds).size).toBeLessThanOrEqual(4);
				const fetchedBytes = fetched.reduce((sum, doc) => sum + estimateDocumentBytes(doc), 0);
				expect(budget.bytes).toBeGreaterThanOrEqual(fetchedBytes);
				return progress;
			});
		}

		// A probe plus a page of 128, then the other 72.
		expect(transactions).toBe(2);
		await t.run(async (ctx) => {
			const sends = await ctx.db
				.query('emailSends')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.collect();
			expect(sends).toHaveLength(200);
			for (const send of sends) expect(send.contactEmail).toBe('[erased]');
		});
	});

	it('charges the step runs an automation-run deletion reads on its behalf', async () => {
		const t = newHarness();
		const contactId = await seedContact(t);
		await t.run(async (ctx) => {
			const now = Date.now();
			const automationId = await ctx.db.insert('automations', {
				name: 'A',
				triggerType: 'contact_created' as const,
				status: 'active' as const,
				createdAt: now,
				updatedAt: now,
			});
			const stepId = await ctx.db.insert('automationSteps', {
				automationId,
				stepIndex: 0,
				stepType: 'delay' as const,
				config: { duration: 1, unit: 'days' } as never,
				createdAt: now,
				updatedAt: now,
			});
			const runId = await ctx.db.insert('automationRuns', {
				automationId,
				contactId,
				currentStepIndex: 0,
				status: 'completed' as const,
				startedAt: now,
				triggeredBy: 'contact_created',
			});
			for (let i = 0; i < 6; i++) {
				await ctx.db.insert('automationStepRuns', {
					automationRunId: runId,
					automationStepId: stepId,
					stepIndex: 0,
					stepType: 'delay' as const,
					status: 'failed' as const,
					scheduledAt: now,
					retryCount: 0,
					errorMessage: '失'.repeat(100_000),
				});
			}
		});

		await t.run(async (ctx) => {
			const stepRuns: Record<string, unknown>[] = [];
			const budget = new ErasureBudget(ERASURE_ROWS_PER_TRANSACTION, ERASURE_BYTES_PER_TRANSACTION);
			await advanceErasure(
				recordingCtx(ctx, (doc) => {
					if ('automationRunId' in doc) stepRuns.push(doc);
				}),
				contactId,
				{ phase: 'automationRuns' },
				budget,
				'walker'
			);
			expect(stepRuns.length).toBeGreaterThan(0);
			const stepRunBytes = stepRuns.reduce((sum, doc) => sum + estimateDocumentBytes(doc), 0);
			expect(budget.bytes).toBeGreaterThanOrEqual(stepRunBytes);
			expect(stepRunBytes).toBeLessThanOrEqual(ERASURE_BYTES_PER_TRANSACTION);
		});
	});
});
