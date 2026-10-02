/**
 * Internal notes on Team Inbox threads, through the real functions:
 *  - a note lists between nothing and everything only for a Team Inbox reader;
 *  - @handles resolve to Team Inbox readers only, never the author, and each
 *    newly mentioned person gets one `mention` notice and a Mentions entry;
 *  - an edit notifies only the newly mentioned and takes back the dropped;
 *  - only the author edits; the author or an admin deletes, which leaves a
 *    tombstone with no text and no mentions;
 *  - the list chip counts live notes only;
 *  - `pendingAssignments` hides mention notices from clients that predate them.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { hasPermission, type OrganizationRole } from '../../lib/sessionOrganization';
import type * as SessionOrganization from '../../lib/sessionOrganization';
import type * as Access from '../access';
import type * as FeatureFlags from '../../lib/featureFlags';
import { canDeleteNote } from '../notes';

const session = vi.hoisted(() => ({
	current: { userId: 'user_ada', role: 'owner' as OrganizationRole | null },
	readers: ['user_ada', 'user_ben', 'user_cy'] as string[],
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganization>('../../lib/sessionOrganization');
	const context = () => ({ ...session.current, activeOrganizationId: 'org_1' });
	return {
		...actual,
		getBetterAuthSessionWithRole: vi.fn(async () => context()),
		getMutationContext: vi.fn(async () => context()),
		requireAdminContext: vi.fn(async () => {
			if (!actual.hasPermission(session.current.role, 'organization:manage')) {
				throw new Error('Only owners and admins can perform this action');
			}
			return context();
		}),
	};
});

vi.mock('../access', async () => {
	const actual = await vi.importActual<typeof Access>('../access');
	return { ...actual, listSharedInboxReaderIds: vi.fn(async () => session.readers) };
});

vi.mock('../../lib/featureFlags', async () => {
	const actual = await vi.importActual<typeof FeatureFlags>('../../lib/featureFlags');
	return {
		...actual,
		isFeatureEnabled: vi.fn(async () => true),
		assertFeatureEnabled: vi.fn(async () => undefined),
	};
});

// See receiveMessageAuth.test.ts: the `../../**` glob omits the `inbox/` dir it
// climbed through, so merge a second glob rooted at `inbox/` and re-prefix its keys.
const rootGlob = import.meta.glob('../../**/*.*s');
const inboxGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../inbox/'),
		mod,
	])
);
const modules = { ...rootGlob, ...inboxGlob };

function as(userId: string, role: OrganizationRole | null = 'admin') {
	session.current = { userId, role };
}

async function seed(t: TestConvex<typeof schema>) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		for (const [authUserId, name, email] of [
			['user_ada', 'Ada Marlow', 'ada@example.com'],
			['user_ben', 'Ben Ortiz', 'ben@example.com'],
			['user_cy', 'Cy Park', 'cy@example.com'],
			['user_eve', 'Eve Editor', 'eve@example.com'],
		] as const) {
			await ctx.db.insert('userProfiles', {
				authUserId,
				name,
				email,
				createdAt: now,
				updatedAt: now,
			});
		}
		return await ctx.db.insert('conversationThreads', {
			subject: 'Invoice 4471',
			normalizedSubject: 'invoice 4471',
			contactIdentifier: 'customer@example.com',
			status: 'open',
			messageCount: 1,
			lastMessageAt: now,
			firstMessageAt: now,
			createdAt: now,
		});
	});
}

async function noticesFor(t: TestConvex<typeof schema>, userId: string) {
	return await t.run(async (ctx) =>
		ctx.db
			.query('inboxAssignmentNotices')
			.withIndex('by_user_and_created', (q) => q.eq('userId', userId))
			.collect()
	);
}

beforeEach(() => {
	as('user_ada', 'owner');
	session.readers = ['user_ada', 'user_ben', 'user_cy'];
});

describe('inbox notes', () => {
	it('lists notes oldest first with their author, for readers only', async () => {
		const t = convexTest(schema, modules);
		const threadId = await seed(t);
		await t.mutation(api.inbox.notes.create, { threadId, body: 'First look: refund 4472.' });
		as('user_ben');
		await t.mutation(api.inbox.notes.create, { threadId, body: 'Billing confirmed.' });

		const notes = await t.query(api.inbox.notes.listForThread, { threadId });
		expect(notes.map((n) => [n.body, n.authorName])).toEqual([
			['First look: refund 4472.', 'Ada Marlow'],
			['Billing confirmed.', 'Ben Ortiz'],
		]);

		as('user_eve', 'editor');
		expect(await t.query(api.inbox.notes.listForThread, { threadId })).toEqual([]);
		await expect(
			t.mutation(api.inbox.notes.create, { threadId, body: 'sneaky' })
		).rejects.toThrow();
	});

	it('refuses an empty or oversized body and strips control characters', async () => {
		const t = convexTest(schema, modules);
		const threadId = await seed(t);
		await expect(t.mutation(api.inbox.notes.create, { threadId, body: '   ' })).rejects.toThrow(
			/needs some text/
		);
		await expect(
			t.mutation(api.inbox.notes.create, { threadId, body: 'x'.repeat(5_001) })
		).rejects.toThrow(/at most 5000/);
		await t.mutation(api.inbox.notes.create, { threadId, body: ' a\u0007b\r\nc ' });
		const [note] = await t.query(api.inbox.notes.listForThread, { threadId });
		expect(note?.body).toBe('ab\nc');
	});

	it('notifies mentioned readers once, never the author or a non-reader', async () => {
		const t = convexTest(schema, modules);
		const threadId = await seed(t);
		await t.mutation(api.inbox.notes.create, {
			threadId,
			body: '@ben and @ben.ortiz, can you check? cc @eve @ada',
		});

		const [note] = await t.query(api.inbox.notes.listForThread, { threadId });
		expect(note?.mentionedUserIds).toEqual(['user_ben']);
		const notices = await noticesFor(t, 'user_ben');
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({
			kind: 'mention',
			threadId,
			noteId: note?._id,
			subject: 'Invoice 4471',
			assignedByName: 'Ada Marlow',
		});
		expect(await noticesFor(t, 'user_eve')).toHaveLength(0);
		expect(await noticesFor(t, 'user_ada')).toHaveLength(0);

		as('user_ben');
		const mentioned = await t.query(api.inbox.noteMentions.listMentionedThreads, {});
		expect(mentioned.threads.map((row) => [row._id, row.unreadMention])).toEqual([
			[threadId, true],
		]);
		expect(await t.query(api.inbox.noteMentions.countUnreadMentions, {})).toBe(1);
		await t.mutation(api.inbox.reads.markThreadSeen, { threadId });
		expect(await t.query(api.inbox.noteMentions.countUnreadMentions, {})).toBe(0);
	});

	it('an edit notifies only the newly mentioned and drops the unmentioned', async () => {
		const t = convexTest(schema, modules);
		const threadId = await seed(t);
		const noteId = await t.mutation(api.inbox.notes.create, { threadId, body: 'ask @ben' });
		await t.mutation(api.inbox.notes.update, { noteId, body: 'ask @ben and @cy' });
		await t.mutation(api.inbox.notes.update, { noteId, body: 'ask @cy' });

		expect(await noticesFor(t, 'user_ben')).toHaveLength(1);
		expect(await noticesFor(t, 'user_cy')).toHaveLength(1);
		as('user_ben');
		expect((await t.query(api.inbox.noteMentions.listMentionedThreads, {})).threads).toEqual([]);
		as('user_cy');
		expect((await t.query(api.inbox.noteMentions.listMentionedThreads, {})).threads).toHaveLength(
			1
		);

		const [note] = await t.query(api.inbox.notes.listForThread, { threadId });
		expect(note?.editedAt).not.toBeNull();
		expect(note?.mentionedUserIds).toEqual(['user_cy']);
	});

	it('only the author edits; the author or an admin deletes, leaving a tombstone', async () => {
		const t = convexTest(schema, modules);
		const threadId = await seed(t);
		const noteId = await t.mutation(api.inbox.notes.create, { threadId, body: 'mine @ben' });

		as('user_ben');
		await expect(t.mutation(api.inbox.notes.update, { noteId, body: 'not yours' })).rejects.toThrow(
			/Only its author/
		);
		await t.mutation(api.inbox.notes.remove, { noteId });

		const [note] = await t.query(api.inbox.notes.listForThread, { threadId });
		expect(note).toMatchObject({ isDeleted: true, body: '', mentionedUserIds: [] });
		const stored = await t.run((ctx) => ctx.db.get(noteId as Id<'threadNotes'>));
		expect(stored?.body).toBe('');
		expect((await t.query(api.inbox.noteMentions.listMentionedThreads, {})).threads).toEqual([]);

		as('user_ada', 'owner');
		await expect(t.mutation(api.inbox.notes.update, { noteId, body: 'back' })).rejects.toThrow(
			/deleted/
		);
		// Deleting twice is a no-op.
		await t.mutation(api.inbox.notes.remove, { noteId });
	});

	it('counts live notes per thread for the list chip', async () => {
		const t = convexTest(schema, modules);
		const threadId = await seed(t);
		const otherId = await t.run(async (ctx) => {
			const thread = await ctx.db.get(threadId);
			const { _id, _creationTime, ...rest } = thread!;
			return await ctx.db.insert('conversationThreads', rest);
		});
		await t.mutation(api.inbox.notes.create, { threadId, body: 'one' });
		const second = await t.mutation(api.inbox.notes.create, { threadId, body: 'two' });
		await t.mutation(api.inbox.notes.create, { threadId, body: 'three' });
		await t.mutation(api.inbox.notes.remove, { noteId: second });

		const counts = await t.query(api.inbox.notes.countsForThreads, {
			threadIds: [threadId, otherId],
		});
		expect(counts).toEqual([{ threadId, count: 2 }]);
	});

	it('hides mention notices from clients that do not ask for them', async () => {
		const t = convexTest(schema, modules);
		const threadId = await seed(t);
		await t.mutation(api.inbox.notes.create, { threadId, body: '@ben look' });

		as('user_ben');
		expect(await t.query(api.inbox.queries.pendingAssignments, {})).toEqual([]);
		const withMentions = await t.query(api.inbox.queries.pendingAssignments, {
			includeMentions: true,
		});
		expect(withMentions).toHaveLength(1);
		expect(withMentions[0]).toMatchObject({ kind: 'mention', threadId });
	});
});

describe('canDeleteNote', () => {
	it('lets the author and admins delete', () => {
		expect(canDeleteNote({ authorId: 'a' }, 'a', 'editor')).toBe(true);
		expect(canDeleteNote({ authorId: 'a' }, 'b', 'admin')).toBe(true);
		expect(canDeleteNote({ authorId: 'a' }, 'b', 'editor')).toBe(false);
		expect(hasPermission('editor', 'organization:manage')).toBe(false);
	});
});
