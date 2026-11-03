/**
 * The per-thread reader view (mail/threadView.ts):
 *   - a thread nobody chose a view for reads null
 *   - the chat view is stored on the caller's own viewer row and read back;
 *     switching back stores the conversation view
 *   - the first choice does not turn the brief's whole history into "new
 *     since you last looked"
 *   - another reader's choice is their own
 *   - a team inbox has no view switch, and a caller without mailbox access
 *     gets nothing
 */

import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { enableFeatures } from './factories';

const sessionMock = vi.hoisted(() => ({
	userId: 'test-user',
	role: 'owner' as 'owner' | 'editor',
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	const session = async () => ({
		userId: sessionMock.userId,
		role: sessionMock.role,
		activeOrganizationId: 'test-org',
	});
	return {
		...actual,
		requireOrgMember: vi.fn().mockImplementation(session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn().mockImplementation(session),
		getBetterAuthSessionWithRole: vi.fn().mockImplementation(session),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('llmProvider')
	)
);

type T = ReturnType<typeof convexTest>;

async function setup(opts: { scope?: 'personal' | 'shared' } = {}) {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	await enableFeatures(t, ['mail.external']);
	const threadId = await t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'test-user',
			organizationId: 'test-org',
			address: 'me@example.com',
			domain: 'example.com',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
			...(opts.scope ? { scope: opts.scope } : {}),
		});
		return await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 'lunch',
			participants: ['alice@example.com', 'me@example.com'],
			messageCount: 2,
			unreadCount: 0,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 'Thursday works',
			latestFromAddress: 'alice@example.com',
			latestSubject: 'Lunch',
			folderRoles: ['inbox'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
	});
	return { t, threadId };
}

const viewOf = (t: T, threadId: Id<'mailThreads'>) =>
	t.query(api.mail.threadView.get, { threadId });

async function as<R>(userId: string, role: 'owner' | 'editor', run: () => Promise<R>) {
	sessionMock.userId = userId;
	sessionMock.role = role;
	try {
		return await run();
	} finally {
		sessionMock.userId = 'test-user';
		sessionMock.role = 'owner';
	}
}

describe('mail/threadView', () => {
	it('reads null until the viewer picks a view', async () => {
		const { t, threadId } = await setup();
		expect(await viewOf(t, threadId)).toBeNull();
	});

	it('stores the chat view and the way back on the caller’s viewer row', async () => {
		const { t, threadId } = await setup();
		await t.mutation(api.mail.threadView.set, { threadId, view: 'chat' });
		expect(await viewOf(t, threadId)).toBe('chat');
		await t.mutation(api.mail.threadView.set, { threadId, view: 'conversation' });
		expect(await viewOf(t, threadId)).toBe('conversation');
		const rows = await t.run((ctx) => ctx.db.query('threadViewerState').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ userId: 'test-user', mailThreadId: threadId });
	});

	it('marks the brief seen as it stands when the choice creates the row', async () => {
		const { t, threadId } = await setup();
		await t.run(async (ctx) => {
			await ctx.db.insert('threadBriefs', {
				threadKind: 'mail',
				mailThreadId: threadId,
				mode: 'brief',
				sourceRevision: 4,
				interpretationRevision: 4,
				lastActivitySeq: 9,
				completeness: 'complete',
				deletionEpoch: 0,
				updatedAt: Date.now(),
			});
		});
		await t.mutation(api.mail.threadView.set, { threadId, view: 'chat' });
		const row = await t.run((ctx) => ctx.db.query('threadViewerState').first());
		expect(row).toMatchObject({ seenInterpretationRevision: 4, seenActivitySeq: 9 });
	});

	it('keeps each reader’s choice their own', async () => {
		const { t, threadId } = await setup();
		await t.mutation(api.mail.threadView.set, { threadId, view: 'chat' });
		// An org owner reads every mailbox, and has picked nothing here.
		expect(await as('another-owner', 'owner', () => viewOf(t, threadId))).toBeNull();
	});

	it('refuses a team inbox thread', async () => {
		const { t, threadId } = await setup({ scope: 'shared' });
		await expect(t.mutation(api.mail.threadView.set, { threadId, view: 'chat' })).rejects.toThrow();
		expect(await viewOf(t, threadId)).toBeNull();
	});

	it('gives a caller without mailbox access nothing', async () => {
		const { t, threadId } = await setup();
		await t.mutation(api.mail.threadView.set, { threadId, view: 'chat' });
		await as('someone-else', 'editor', async () => {
			expect(await viewOf(t, threadId)).toBeNull();
			await expect(
				t.mutation(api.mail.threadView.set, { threadId, view: 'conversation' })
			).rejects.toThrow();
		});
		expect(await viewOf(t, threadId)).toBe('chat');
	});
});
