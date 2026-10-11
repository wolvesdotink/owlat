/**
 * Migration 0068: plaintext fact keys become a keyed hash and a sealed label,
 * over several pages, idempotent and resumable from the ledger.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import {
	modules,
	seedFolder,
	seedMailbox,
	seedMessage,
} from '../../mail/__tests__/helpers.testlib';
import { MIGRATION, sealedKeyPatch } from '../0068_seal_fact_keys';
import { factKeyHash, rowFactKeyLabel } from '../../mail/interpret/factKeys';

const migration = internal.migrations[MIGRATION];

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('0068_seal_fact_keys', () => {
	it('converts every plaintext key, keeps redacted ones opaque, and is idempotent', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		const messageId = await seedMessage(t, mailboxId, { subject: 's' });
		const threadId = await t.run(async (ctx) => (await ctx.db.get(messageId))!.threadId);
		const base = {
			threadKind: 'mail' as const,
			mailThreadId: threadId,
			assertion: 'a',
			display: { en: 'a', de: 'a' },
			evidence: [],
			provenance: 'reported' as const,
			status: 'current' as const,
			revision: 1,
			createdAt: 1,
			updatedAt: 1,
		};
		await t.run(async (ctx) => {
			// More rows than one page.
			for (let i = 0; i < 130; i++) {
				await ctx.db.insert('threadFacts', { ...base, factKey: `["dr. roe ${i}","diagnosis",""]` });
			}
			await ctx.db.insert('threadFacts', { ...base, factKey: 'redacted:x' });
		});

		await t.mutation(migration.run, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		await t.run(async (ctx) => {
			const rows = await ctx.db.query('threadFacts').collect();
			expect(rows.every((r) => r.factKey === undefined)).toBe(true);
			const first = rows.find((r) => r.factKeyLabel !== undefined)!;
			expect(await rowFactKeyLabel(first)).toMatch(/dr\. roe \d+/);
			expect(first.factKeyHash).toBe(await factKeyHash(await rowFactKeyLabel(first)));
			const redacted = rows.find((r) => r.factKeyLabel === undefined)!;
			expect(redacted.factKeyHash).toBe('redacted:x');
			const run = await ctx.db
				.query('migrationRuns')
				.withIndex('by_migration', (q) => q.eq('migration', MIGRATION))
				.first();
			expect(run?.status).toBe('completed');
		});
		// A converted row has nothing left to convert; a finished walk is left alone.
		expect(await sealedKeyPatch({ factKeyHash: 'h' })).toBeNull();
		expect(await t.mutation(migration.run, {})).toMatchObject({ started: false });
	});
});
