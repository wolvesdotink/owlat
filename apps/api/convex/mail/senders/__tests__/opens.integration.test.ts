/**
 * First opens (SPEC §5): the reader's open event and `brief.markSeen` count a
 * live message's first open once, in its delivery week. Bulk mark-read,
 * `setFlags` and `markThreadRead` never count, and mail that was not counted
 * as delivered (a backfill, a team inbox) never counts as opened.
 */

import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { api } from '../../../_generated/api';
import { modules } from '../../__tests__/helpers.testlib';
import { deliverHosted, profileOf, seedPersonalMailbox } from './senders.testlib';

vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../lib/sessionOrganization');
	const session = { userId: 'user-A', role: 'owner' as const, activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
	};
});

const opened = (weeks: number[] | undefined) => (weeks ?? []).reduce((sum, n) => sum + n, 0);

describe('first opens', () => {
	it('counts the reader open once', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		const id = (await deliverHosted(t))!;
		await t.mutation(api.mail.senders.opens.markOpened, { messageId: id });
		await t.mutation(api.mail.senders.opens.markOpened, { messageId: id });
		expect(opened((await profileOf(t, mailboxId))!.openedWeeks)).toBe(1);
		expect((await t.run(async (ctx) => await ctx.db.get(id)))!.isOpenCounted).toBe(true);
	});

	it('does not count bulk mark-read or markThreadRead', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		const first = (await deliverHosted(t))!;
		const second = (await deliverHosted(t))!;
		await t.mutation(api.mail.messageActions.setFlags, { messageIds: [first], seen: true });
		const threadId = (await t.run(async (ctx) => await ctx.db.get(second)))!.threadId;
		await t.mutation(api.mail.messageActions.markThreadRead, { threadId, seen: true });
		expect(opened((await profileOf(t, mailboxId))!.openedWeeks)).toBe(0);
		// …and a later real open still counts.
		await t.mutation(api.mail.senders.opens.markOpened, { messageId: first });
		expect(opened((await profileOf(t, mailboxId))!.openedWeeks)).toBe(1);
	});

	it('counts the newest inbound message when the Overview is marked seen', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		const id = (await deliverHosted(t))!;
		const threadId = (await t.run(async (ctx) => await ctx.db.get(id)))!.threadId;
		await t.mutation(api.mail.interpret.brief.markSeen, {
			threadRef: { kind: 'mail', id: threadId },
		});
		expect(opened((await profileOf(t, mailboxId))!.openedWeeks)).toBe(1);
		await t.mutation(api.mail.senders.opens.markOpened, { messageId: id });
		expect(opened((await profileOf(t, mailboxId))!.openedWeeks)).toBe(1);
	});

	it('ignores mail that was never counted as delivered', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		const id = (await deliverHosted(t))!;
		await t.run(async (ctx) => await ctx.db.patch(id, { isOpenCounted: undefined }));
		await t.mutation(api.mail.senders.opens.markOpened, { messageId: id });
		expect(opened((await profileOf(t, mailboxId))!.openedWeeks)).toBe(0);
	});
});
