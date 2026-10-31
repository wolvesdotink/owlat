/**
 * The daily cleanup of retained webhook payloads (`webhooks/payloads.ts`):
 * it deletes payloads older than 90 days a batch at a time, until a batch
 * comes back short, and leaves newer ones alone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../_generated/api';
import { newHarness } from '../../__tests__/testModules';

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

async function seedPayloads(
	t: ReturnType<typeof newHarness>,
	count: number,
	receivedAt: number
): Promise<void> {
	await t.run(async (ctx) => {
		for (let i = 0; i < count; i++) {
			await ctx.db.insert('webhookPayloads', { source: 'ses', rawPayload: '{}', receivedAt });
		}
	});
}

const remaining = (t: ReturnType<typeof newHarness>) =>
	t.run(async (ctx) => (await ctx.db.query('webhookPayloads').collect()).map((p) => p.receivedAt));

describe('webhooks.payloads.cleanupOldPayloads', () => {
	it('deletes every payload past the retention window over several batches, and keeps the rest', async () => {
		const t = newHarness();
		const now = Date.now();
		await seedPayloads(t, 250, now - 91 * DAY);
		await seedPayloads(t, 3, now - 89 * DAY);
		const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

		await t.action(internal.webhooks.payloads.cleanupOldPayloads, {});

		expect(await remaining(t)).toEqual([now - 89 * DAY, now - 89 * DAY, now - 89 * DAY]);
		// A re-run finds nothing left to delete.
		await t.action(internal.webhooks.payloads.cleanupOldPayloads, {});
		expect(await remaining(t)).toHaveLength(3);
		infoSpy.mockRestore();
	});
});
