/**
 * Plan 1.13 / C6: the mailbox gate is decided once per mailbox inside one
 * handler, not once per message.
 *
 * The bulk triage mutations (setFlags, purge, reportSpam) used to run the whole
 * gate per message: two feature-flag reads plus a Better Auth `member` lookup
 * (`getBetterAuthSessionWithRole`). They now reuse the session the
 * `postboxMutation` floor resolved and memoize the decision per mailbox, so a
 * bulk call costs one member lookup (the floor's) and a flag read count that
 * does not grow with the number of messages. The decisions themselves must not
 * change: a message in a mailbox the caller cannot access is still skipped.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import { createMailboxAccessGate, requireMailboxAccess } from '../permissions';
import { modules, seedMailbox, seedFolder, seedMessage } from './helpers.testlib';

const sessionMocks = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'editor' as 'owner' | 'admin' | 'editor',
	floor: undefined as unknown as ReturnType<typeof vi.fn>,
	withRole: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = async () => ({
		userId: sessionMocks.userId,
		role: sessionMocks.role,
		activeOrganizationId: 'org-1',
	});
	// Each of these stands for one Better Auth `member` lookup in production.
	sessionMocks.floor = vi.fn(session);
	sessionMocks.withRole = vi.fn(session);
	return {
		...actual,
		requireOrgMember: sessionMocks.floor,
		getMutationContext: sessionMocks.floor,
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getBetterAuthSessionWithRole: sessionMocks.withRole,
	};
});

const flagReads = vi.hoisted(() => ({ spy: undefined as unknown as ReturnType<typeof vi.fn> }));

vi.mock('../../lib/featureFlagSettings', async () => {
	const actual = await vi.importActual<typeof import('../../lib/featureFlagSettings')>(
		'../../lib/featureFlagSettings'
	);
	flagReads.spy = vi.fn(actual.readFeatureFlagSettings);
	return { ...actual, readFeatureFlagSettings: flagReads.spy };
});

beforeEach(() => {
	sessionMocks.userId = 'user-A';
	sessionMocks.role = 'editor';
});

/** Member lookups (floor + in-handler) and flag reads made by `run`. */
async function countLookups(run: () => Promise<unknown>) {
	sessionMocks.floor.mockClear();
	sessionMocks.withRole.mockClear();
	flagReads.spy.mockClear();
	await run();
	return {
		memberLookups: sessionMocks.floor.mock.calls.length + sessionMocks.withRole.mock.calls.length,
		inHandlerLookups: sessionMocks.withRole.mock.calls.length,
		flagReads: flagReads.spy.mock.calls.length,
	};
}

async function seedOwnMailbox(t: TestConvex<typeof schema>, count: number) {
	const mailboxId = await seedMailbox(t, { userId: 'user-A' });
	await seedFolder(t, mailboxId, 'inbox');
	await seedFolder(t, mailboxId, 'spam');
	await seedFolder(t, mailboxId, 'trash');
	const ids: Id<'mailMessages'>[] = [];
	for (let i = 0; i < count; i++) {
		ids.push(await seedMessage(t, mailboxId, { subject: `m${i}`, receivedAt: 1_000 + i }));
	}
	return { mailboxId, ids };
}

describe('bulk triage decides mailbox access once per mailbox', () => {
	it('setFlags over many messages makes one member lookup and flat flag reads', async () => {
		const t = convexTest(schema, modules);
		const { ids } = await seedOwnMailbox(t, 6);

		const one = await countLookups(() =>
			t.mutation(api.mail.messageActions.setFlags, { messageIds: ids.slice(0, 1), seen: true })
		);
		const many = await countLookups(() =>
			t.mutation(api.mail.messageActions.setFlags, { messageIds: ids, flagged: true })
		);

		// The floor's lookup is the only one; the handler reuses its session.
		expect(many.memberLookups).toBe(1);
		expect(many.inHandlerLookups).toBe(0);
		// Flag reads do not scale with the number of messages.
		expect(many.flagReads).toBe(one.flagReads);

		const rows = await t.run((ctx) => Promise.all(ids.map((id) => ctx.db.get(id))));
		expect(rows.every((m) => m?.flagFlagged === true)).toBe(true);
	});

	it('purge over many messages makes one member lookup', async () => {
		const t = convexTest(schema, modules);
		const { ids } = await seedOwnMailbox(t, 4);

		const counts = await countLookups(() =>
			t.mutation(api.mail.messageActions.purge, { messageIds: ids })
		);

		expect(counts.memberLookups).toBe(1);
		const rows = await t.run((ctx) => Promise.all(ids.map((id) => ctx.db.get(id))));
		expect(rows.every((m) => m === null)).toBe(true);
	});

	it('reportSpam shares one decision across the check, the verdict loop and the move', async () => {
		const t = convexTest(schema, modules);
		const { ids } = await seedOwnMailbox(t, 5);

		const one = await countLookups(() =>
			t.mutation(api.mail.messageActions.notSpam, { messageIds: ids.slice(0, 1) })
		);
		const many = await countLookups(() =>
			t.mutation(api.mail.messageActions.reportSpam, { messageIds: ids })
		);

		expect(many.memberLookups).toBe(1);
		expect(many.inHandlerLookups).toBe(0);
		expect(many.flagReads).toBeLessThanOrEqual(one.flagReads + 1);
		const rows = await t.run((ctx) => Promise.all(ids.map((id) => ctx.db.get(id))));
		expect(rows.every((m) => m?.spamVerdict === 'spam')).toBe(true);
	});

	it('still skips messages in a mailbox the caller cannot access', async () => {
		const t = convexTest(schema, modules);
		const { ids: own } = await seedOwnMailbox(t, 2);
		// Someone else's personal mailbox: an editor has no access to it.
		const otherId = await seedMailbox(t, { userId: 'user-B', address: 'b@owlat.test' });
		await seedFolder(t, otherId, 'inbox');
		const foreign = [
			await seedMessage(t, otherId, { subject: 'x1' }),
			await seedMessage(t, otherId, { subject: 'x2' }),
		];

		const counts = await countLookups(() =>
			t.mutation(api.mail.messageActions.setFlags, {
				messageIds: [own[0]!, foreign[0]!, own[1]!, foreign[1]!],
				flagged: true,
			})
		);

		expect(counts.memberLookups).toBe(1);
		const rows = await t.run((ctx) =>
			Promise.all([...own, ...foreign].map((id) => ctx.db.get(id)))
		);
		expect(rows.map((m) => m?.flagFlagged)).toEqual([true, true, false, false]);
	});
});

describe('createMailboxAccessGate', () => {
	it('matches requireMailboxAccess per mailbox and resolves the session once', async () => {
		const t = convexTest(schema, modules);
		const own = await seedMailbox(t, { userId: 'user-A' });
		const other = await seedMailbox(t, { userId: 'user-B', address: 'b@owlat.test' });
		const suspended = await seedMailbox(t, {
			userId: 'user-A',
			address: 'c@owlat.test',
			status: 'suspended',
		});

		await t.run(async (ctx) => {
			const expected = await Promise.all(
				[own, other, suspended].map((id) => requireMailboxAccess(ctx, id))
			);
			sessionMocks.withRole.mockClear();
			const gate = createMailboxAccessGate(ctx);
			const first = await Promise.all([own, other, suspended].map((id) => gate(id)));
			const again = await Promise.all([own, other, suspended, own].map((id) => gate(id)));
			expect(first).toEqual(expected);
			expect(again.slice(0, 3)).toEqual(expected);
			expect(sessionMocks.withRole).toHaveBeenCalledTimes(1);
		});
	});

	it('keeps minRole in the key: a member-level grant never answers an owner check', async () => {
		const t = convexTest(schema, modules);
		const shared = await seedMailbox(t, { userId: 'user-B', scope: 'shared' });
		await t.run(async (ctx) => {
			await ctx.db.insert('mailboxMembers', {
				mailboxId: shared,
				authUserId: 'user-A',
				role: 'member',
				addedBy: 'user-B',
				createdAt: Date.now(),
			});
			const gate = createMailboxAccessGate(ctx);
			expect((await gate(shared)).ok).toBe(true);
			expect(await gate(shared, 'owner')).toEqual({ ok: false, reason: 'forbidden' });
		});
	});

	it('uses the floor session it is given instead of resolving one', async () => {
		const t = convexTest(schema, modules);
		const own = await seedMailbox(t, { userId: 'user-A' });
		await t.run(async (ctx) => {
			sessionMocks.withRole.mockClear();
			const gate = createMailboxAccessGate(ctx, {
				userId: 'user-A',
				role: 'editor',
				activeOrganizationId: 'org-1',
			});
			expect((await gate(own)).ok).toBe(true);
			expect(sessionMocks.withRole).not.toHaveBeenCalled();
		});
	});
});
