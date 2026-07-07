/**
 * Thread-presence coverage (inbox/presence.ts):
 *   - heartbeat upserts one row per (thread, user) and refreshes mode + timestamp
 *   - two users on one thread both appear in the active list
 *   - list applies the 60s active window (boundary: 59s in, 61s out)
 *   - the internalSweep cron deletes expired rows and keeps active ones
 *   - access control: a non-admin member cannot read presence (list → []) and
 *     cannot heartbeat (adminMutation floor throws).
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { PRESENCE_ACTIVE_WINDOW_MS } from '../inbox/presence';

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

		// 1s inside the 60s window → active.
		await seedPresence(t, threadId, 'fresh', 'viewing', now - (PRESENCE_ACTIVE_WINDOW_MS - 1000));
		// 1s past the window → expired.
		await seedPresence(t, threadId, 'stale', 'viewing', now - (PRESENCE_ACTIVE_WINDOW_MS + 1000));

		const list = await t.query(api.inbox.presence.list, { threadId });
		expect(list).toHaveLength(1);
		expect(list[0]!.userId).toBe('fresh');
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
