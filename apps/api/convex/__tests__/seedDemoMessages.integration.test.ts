/**
 * The demo seed's team-inbox threads (`seedDemo/messages.ts`): each fixture
 * message is delivered through the hosted inbound path once, and a re-run of
 * the seed skips every message already delivered.
 */

import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { modules } from './testModules';
import { seedFolder, seedMailbox } from '../mail/__tests__/helpers.testlib';
import messagesFixture from '../seedDemo/fixtures/mailboxMessages.json';

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('seedDemo.messages.seedMailboxMessages', () => {
	it('delivers every fixture message once, and a re-run skips them all', async () => {
		const t = convexTest({ schema, modules });
		rateLimiterTest.register(t);
		for (const address of new Set(messagesFixture.map((message) => message.recipient))) {
			const mailboxId = await seedMailbox(t, {
				address,
				domain: 'demo.localhost',
				scope: 'shared',
			});
			await seedFolder(t, mailboxId);
		}

		const first = await t.action(internal.seedDemo.messages.seedMailboxMessages, {});
		expect(first).toEqual({ inserted: messagesFixture.length, skipped: 0 });
		const delivered = await t.run(async (ctx) =>
			(await ctx.db.query('mailMessages').collect()).map((m) => m.rfc822MessageId).sort()
		);
		expect(delivered).toHaveLength(messagesFixture.length);

		const again = await t.action(internal.seedDemo.messages.seedMailboxMessages, {});
		expect(again).toEqual({ inserted: 0, skipped: messagesFixture.length });
		expect(await t.run(async (ctx) => (await ctx.db.query('mailMessages').collect()).length)).toBe(
			messagesFixture.length
		);
	});
});
