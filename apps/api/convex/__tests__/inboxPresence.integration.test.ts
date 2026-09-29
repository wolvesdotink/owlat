/**
 * Thread-presence coverage (inbox/presence.ts):
 *   - heartbeat upserts one row per (thread, user) and refreshes mode + timestamp
 *   - two users on one thread both appear in the active list
 *   - a same-mode beat inside PRESENCE_REFRESH_MS does not rewrite the row
 *   - list applies the active window (boundary: 1s in, 1s out)
 *   - the internalSweep cron deletes expired rows and keeps active ones
 *   - presentAssignees answers the team-inbox ring per (thread, assignee) pair
 *   - access control: a non-admin member cannot read presence (list → []) and
 *     cannot heartbeat (adminMutation floor throws).
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	MAX_ASSIGNEE_PRESENCE_PAIRS,
	PRESENCE_ACTIVE_WINDOW_MS,
	PRESENCE_REFRESH_MS,
} from '../inbox/presence';

const sessionMock = vi.hoisted(() => ({
	user: { id: 'user-owner', role: 'owner' as 'owner' | 'admin' | 'editor' },
}));

const setUser = (id: string, role: 'owner' | 'admin' | 'editor' = 'owner') => {
	sessionMock.user.id = id;
	sessionMock.user.role = role;
};

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../lib/sessionOrganization')>(
		'../lib/sessionOrganization'
	);
	return {
		...actual,
		requireOrgMember: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
		})),
		getMutationContext: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
		})),
		requireAdminContext: vi.fn().mockImplementation(async () => {
			if (sessionMock.user.role === 'editor') throw new Error('forbidden');
			return { userId: sessionMock.user.id, role: sessionMock.user.role };
		}),
		isActiveOrgMember: vi.fn().mockImplementation(async () => true),
		getBetterAuthSessionWithRole: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			activeOrganizationId: 'org-singleton',
			role: sessionMock.user.role,
		})),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('agentClassifier') &&
			!path.includes('agentDrafter') &&
			!path.includes('agentRouter') &&
			!path.includes('agent/walker') &&
			!path.includes('agent/steps/index') &&
			!path.includes('agent/steps/shared') &&
			!path.includes('agent/steps/classify') &&
			!path.includes('agent/steps/draft') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

const seedThread = (t: TestConvex<typeof schema>) =>
	t.run(async (ctx) => {
		const now = Date.now();
		return ctx.db.insert('conversationThreads', {
			subject: 'Presence thread',
			normalizedSubject: 'presence thread',
			contactIdentifier: 'someone@example.com',
			status: 'open',
			messageCount: 1,
			lastMessageAt: now,
			firstMessageAt: now,
			createdAt: now,
		});
	});

const seedPresence = (
	t: TestConvex<typeof schema>,
	threadId: Id<'conversationThreads'>,
	userId: string,
	mode: 'viewing' | 'replying',
	heartbeatAt: number
) =>
	t.run(async (ctx) => {
		await ctx.db.insert('threadPresence', { threadId, userId, mode, heartbeatAt });
	});

describe('inbox.presence.heartbeat', () => {
	it('upserts one row per (thread, user) and refreshes mode + timestamp', async () => {
		const t = convexTest(schema, modules);
		setUser('user-owner', 'owner');
		const threadId = await seedThread(t);

		await t.mutation(api.inbox.presence.heartbeat, { threadId, mode: 'viewing' });
		await t.mutation(api.inbox.presence.heartbeat, { threadId, mode: 'replying' });

		const rows = await t.run(async (ctx) =>
			ctx.db
				.query('threadPresence')
				.withIndex('by_thread', (q) => q.eq('threadId', threadId))
				.collect()
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.mode).toBe('replying');
		expect(rows[0]!.userId).toBe('user-owner');
	});

	it('skips the write for a same-mode beat until the row is PRESENCE_REFRESH_MS old', async () => {
		const t = convexTest(schema, modules);
		setUser('user-owner', 'owner');
		const threadId = await seedThread(t);
		const readRow = () =>
			t.run(async (ctx) =>
				ctx.db
					.query('threadPresence')
					.withIndex('by_thread', (q) => q.eq('threadId', threadId))
					.unique()
			);

		// A row written 20s ago (one client beat): the next same-mode beat is a no-op.
		const recent = Date.now() - 20_000;
		await seedPresence(t, threadId, 'user-owner', 'viewing', recent);
		await t.mutation(api.inbox.presence.heartbeat, { threadId, mode: 'viewing' });
		expect((await readRow())!.heartbeatAt).toBe(recent);

		// A mode flip is written straight away.
		await t.mutation(api.inbox.presence.heartbeat, { threadId, mode: 'replying' });
		const flipped = (await readRow())!;
		expect(flipped.mode).toBe('replying');
		expect(flipped.heartbeatAt).toBeGreaterThan(recent);

		// Once the stored beat is PRESENCE_REFRESH_MS old, a same-mode beat re-stamps it.
		const old = Date.now() - PRESENCE_REFRESH_MS;
		await t.run(async (ctx) => ctx.db.patch(flipped._id, { heartbeatAt: old }));
		await t.mutation(api.inbox.presence.heartbeat, { threadId, mode: 'replying' });
		expect((await readRow())!.heartbeatAt).toBeGreaterThan(old);
	});

	it('keeps a row active between its re-stamps, with one missed beat to spare', () => {
		// The re-stamp lands on the first beat at or past PRESENCE_REFRESH_MS, so
		// a row can be one 20s beat older than that; one more beat may be lost.
		expect(PRESENCE_ACTIVE_WINDOW_MS).toBeGreaterThan(PRESENCE_REFRESH_MS + 2 * 20_000);
	});

	it('keeps distinct rows for distinct users on the same thread', async () => {
		const t = convexTest(schema, modules);
		const threadId = await seedThread(t);

		setUser('user-a', 'owner');
		await t.mutation(api.inbox.presence.heartbeat, { threadId, mode: 'viewing' });
		setUser('user-b', 'admin');
		await t.mutation(api.inbox.presence.heartbeat, { threadId, mode: 'replying' });

		const list = await t.query(api.inbox.presence.list, { threadId });
		expect(list).toHaveLength(2);
		expect(list.map((r) => r.userId).sort()).toEqual(['user-a', 'user-b']);
	});
});

describe('inbox.presence.list active window', () => {
	it('includes a row 1s inside the window and excludes one just past it', async () => {
		const t = convexTest(schema, modules);
		setUser('user-owner', 'owner');
		const threadId = await seedThread(t);
		const now = Date.now();

		// 1s inside the window → active.
		await seedPresence(t, threadId, 'fresh', 'viewing', now - (PRESENCE_ACTIVE_WINDOW_MS - 1000));
		// 1s past the window → expired.
		await seedPresence(t, threadId, 'stale', 'viewing', now - (PRESENCE_ACTIVE_WINDOW_MS + 1000));

		const list = await t.query(api.inbox.presence.list, { threadId });
		expect(list).toHaveLength(1);
		expect(list[0]!.userId).toBe('fresh');
	});
});

describe('inbox.presence.presentAssignees', () => {
	it('returns the threads whose named assignee is active there, and no others', async () => {
		const t = convexTest(schema, modules);
		setUser('user-owner', 'owner');
		const here = await seedThread(t);
		const gone = await seedThread(t);
		const elsewhere = await seedThread(t);
		const now = Date.now();

		// Assignee active on `here`; stale on `gone`; on `elsewhere` only a
		// different member is present, which must not light the assignee's ring.
		await seedPresence(t, here, 'assignee-a', 'viewing', now - 1000);
		await seedPresence(t, gone, 'assignee-b', 'viewing', now - (PRESENCE_ACTIVE_WINDOW_MS + 1000));
		await seedPresence(t, elsewhere, 'someone-else', 'replying', now - 1000);

		const present = await t.query(api.inbox.presence.presentAssignees, {
			rows: [
				{ threadId: here, assigneeId: 'assignee-a' },
				{ threadId: gone, assigneeId: 'assignee-b' },
				{ threadId: elsewhere, assigneeId: 'assignee-c' },
			],
		});
		expect(present).toEqual([here]);
	});

	it('checks at most MAX_ASSIGNEE_PRESENCE_PAIRS pairs', async () => {
		const t = convexTest(schema, modules);
		setUser('user-owner', 'owner');
		const threadId = await seedThread(t);
		await seedPresence(t, threadId, 'late-assignee', 'viewing', Date.now());

		const filler = Array.from({ length: MAX_ASSIGNEE_PRESENCE_PAIRS }, (_, i) => ({
			threadId,
			assigneeId: `absent-${i}`,
		}));
		const present = await t.query(api.inbox.presence.presentAssignees, {
			rows: [...filler, { threadId, assigneeId: 'late-assignee' }],
		});
		expect(present).toEqual([]);
	});

	it('returns [] for a non-admin member', async () => {
		const t = convexTest(schema, modules);
		const threadId = await seedThread(t);
		await seedPresence(t, threadId, 'assignee-a', 'viewing', Date.now());

		setUser('user-editor', 'editor');
		const present = await t.query(api.inbox.presence.presentAssignees, {
			rows: [{ threadId, assigneeId: 'assignee-a' }],
		});
		expect(present).toEqual([]);
	});
});

describe('inbox.presence.internalSweep', () => {
	it('deletes expired rows and keeps active ones', async () => {
		const t = convexTest(schema, modules);
		const threadId = await seedThread(t);
		const now = Date.now();

		await seedPresence(t, threadId, 'active', 'viewing', now - 5_000);
		await seedPresence(
			t,
			threadId,
			'expired-1',
			'viewing',
			now - (PRESENCE_ACTIVE_WINDOW_MS + 5_000)
		);
		await seedPresence(
			t,
			threadId,
			'expired-2',
			'replying',
			now - (PRESENCE_ACTIVE_WINDOW_MS + 60_000)
		);

		const result = await t.mutation(internal.inbox.presence.internalSweep, {});
		expect(result.swept).toBe(2);

		const remaining = await t.run(async (ctx) => ctx.db.query('threadPresence').collect());
		expect(remaining).toHaveLength(1);
		expect(remaining[0]!.userId).toBe('active');
	});
});

describe('inbox.presence access control', () => {
	it('a non-admin member cannot read presence (list → [])', async () => {
		const t = convexTest(schema, modules);
		const threadId = await seedThread(t);
		await seedPresence(t, threadId, 'someone', 'viewing', Date.now());

		setUser('user-editor', 'editor');
		const list = await t.query(api.inbox.presence.list, { threadId });
		expect(list).toEqual([]);
	});

	it('a non-admin member cannot heartbeat', async () => {
		const t = convexTest(schema, modules);
		const threadId = await seedThread(t);

		setUser('user-editor', 'editor');
		await expect(
			t.mutation(api.inbox.presence.heartbeat, { threadId, mode: 'viewing' })
		).rejects.toThrow();
	});
});
