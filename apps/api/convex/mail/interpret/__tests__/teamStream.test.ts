/**
 * The team stream (inbox/teamStream.ts, mail/interpret/teamStream.ts): one
 * order across emails, replies, internal notes and activity; pages that walk
 * back without gaps; internal notes only for the people who may read the
 * thread, never with the `chat` feature off for a mailbox discussion; and no
 * route from the stream into anything that builds a prompt or a mail.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { api, internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import { enableFeatures } from '../../../__tests__/factories';
import { appendActivity } from '../activity';
import type { TeamStreamEntry, TeamStreamPage } from '../briefShape';
import { STREAM_PAGE_SIZE } from '../teamStreamRead';
import {
	addMessageToThread,
	modules,
	reduceItem,
	reduceResult,
	seedMailThread,
	seedTeamThread,
	type Test,
} from './interpret.testlib';

const session = vi.hoisted(() => ({
	current: { userId: 'user-A', role: 'owner', activeOrganizationId: 'org-1' },
}));

vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session.current),
		isActiveOrgMember: vi.fn(async () => true),
		getMutationContext: vi.fn(async () => session.current),
		getBetterAuthSessionWithRole: vi.fn(async () => session.current),
		requireAdminContext: vi.fn(async () => session.current),
	};
});

beforeEach(() => {
	session.current = { userId: 'user-A', role: 'owner', activeOrganizationId: 'org-1' };
});

const SENT = Date.UTC(2026, 9, 7, 9, 0);
const MIN = 60_000;

async function interpretTeam(
	t: Test,
	threadId: Id<'conversationThreads'>,
	inboundId: Id<'inboundMessages'>
) {
	await t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
		source: { kind: 'inbound', id: inboundId },
		threadRef: { kind: 'team', id: threadId },
		mode: 'actions',
		contentRevision: `rev-${inboundId}`,
		extractorVersion: 1,
		expectedRevision: 0,
		deletionEpoch: 0,
		sourceAt: SENT,
		direction: 'inbound',
		status: 'complete',
		result: reduceResult({ items: [reduceItem()], latest: undefined, facts: undefined }),
	});
	return t.run(async (ctx) => {
		const item = await ctx.db
			.query('threadItems')
			.withIndex('by_conversation_thread_and_status', (q) =>
				q.eq('conversationThreadId', threadId).eq('status', 'open')
			)
			.first();
		return item!._id;
	});
}

function kinds(page: TeamStreamPage | null) {
	return (page?.entries ?? []).map((e) => e.kind);
}

async function walkTeam(t: Test, threadId: Id<'conversationThreads'>) {
	const pages: TeamStreamEntry[][] = [];
	let cursor: string | null = null;
	for (let i = 0; i < 20; i++) {
		const page: TeamStreamPage | null = await t.query(api.inbox.teamStream.page, {
			threadId,
			locale: 'en',
			cursor,
		});
		if (!page) throw new Error('no page');
		pages.push(page.entries);
		if (page.isDone) return pages.reverse().flat();
		cursor = page.cursor;
	}
	throw new Error('the walk did not end');
}

describe('Team Inbox stream', () => {
	it('merges the email, the reply that went out, notes and activity in time order', async () => {
		const t = convexTest(schema, modules);
		const { threadId, inboundId } = await seedTeamThread(t);
		const itemId = await interpretTeam(t, threadId, inboundId);
		await t.run(async (ctx) => {
			await ctx.db.patch(inboundId, {
				processingStatus: 'sent',
				draftResponse: 'The approved draft',
				approvalSource: 'auto',
			});
			const sendId = await ctx.db.insert('transactionalSends', {
				kind: 'agent_reply',
				inboundMessageId: inboundId,
				email: 'customer@example.com',
				status: 'sent',
				queuedAt: SENT + 30 * MIN,
				sentAt: SENT + 31 * MIN,
			});
			await ctx.db.insert('interpretSources', {
				threadKind: 'team',
				conversationThreadId: threadId,
				source: { kind: 'teamReply', id: sendId },
				sourceKey: `teamReply:${sendId}`,
				eligibility: {
					isLive: true,
					isThreadMuted: false,
					isBulkHeaderPresent: false,
					isSenderKnown: true,
				},
				snapshot: { subject: 'Re: Order 42', text: 'Refund is on its way.', capturedAt: SENT },
				createdAt: SENT,
				updatedAt: SENT,
			});
			await appendActivity(ctx, {
				threadRef: { kind: 'team', id: threadId },
				idempotencyKey: 'held',
				type: 'send_held',
				actor: { kind: 'system' },
				provenance: 'recorded',
				eventAt: SENT + 20 * MIN,
			});
			await appendActivity(ctx, {
				threadRef: { kind: 'team', id: threadId },
				idempotencyKey: 'assign',
				type: 'assigned',
				actor: { kind: 'user', id: 'user-A' },
				provenance: 'recorded',
				eventAt: SENT + 21 * MIN,
			});
			await ctx.db.insert('threadNotes', {
				threadId,
				authorId: 'user-A',
				body: 'Refund is fine, @mika',
				mentionedUserIds: [],
				threadItemId: itemId,
				createdAt: SENT + 10 * MIN,
			});
			await ctx.db.insert('inboxFollowUps', {
				threadId,
				inReplyToMessageId: inboundId,
				subject: 'Re: Order 42',
				body: 'One more thing',
				status: 'scheduled',
				createdBy: 'user-A',
				createdAt: SENT + 40 * MIN,
				sendAt: SENT + 41 * MIN,
			});
		});

		const page = await t.query(api.inbox.teamStream.page, { threadId, locale: 'en' });
		expect(page?.isDone).toBe(true);
		const entries = page!.entries;
		// Sorted by time: strictly ascending positions.
		for (let i = 1; i < entries.length; i++) {
			const [a, b] = [entries[i - 1]!, entries[i]!];
			expect(a.at < b.at || (a.at === b.at && a.key < b.key)).toBe(true);
		}
		const email = entries.find((e) => e.kind === 'customerEmail');
		expect(email).toMatchObject({ preview: expect.stringContaining('Where is my order') });
		const replies = entries.filter((e) => e.kind === 'teamReply');
		expect(replies).toEqual([
			expect.objectContaining({ body: 'Refund is on its way.', status: 'sent', isAgent: true }),
			expect.objectContaining({
				body: 'One more thing',
				status: 'queued',
				sendAt: SENT + 41 * MIN,
			}),
		]);
		const note = entries.find((e) => e.kind === 'note');
		expect(note).toMatchObject({
			noteSource: 'threadNote',
			threadItemId: itemId,
			threadItemText: 'Send the signed contract',
		});
		const activityTypes = entries.flatMap((e) => (e.kind === 'activity' ? [e.activity.type] : []));
		expect(activityTypes).toContain('send_held');
		expect(activityTypes).toContain('item_opened');
		// Housekeeping never becomes a system line.
		expect(activityTypes).not.toContain('assigned');
		const opened = entries.find((e) => e.kind === 'activity' && e.activity.type === 'item_opened');
		expect(opened).toMatchObject({ itemText: 'Send the signed contract' });
	});

	it('pages back across every source without gaps or repeats', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedTeamThread(t);
		await t.run(async (ctx) => {
			for (let i = 0; i < STREAM_PAGE_SIZE + 15; i++) {
				await ctx.db.insert('threadNotes', {
					threadId,
					authorId: 'user-A',
					body: `note ${i}`,
					mentionedUserIds: [],
					createdAt: SENT + i * MIN,
				});
				if (i % 3 === 0) {
					await appendActivity(ctx, {
						threadRef: { kind: 'team', id: threadId },
						idempotencyKey: `held-${i}`,
						type: 'send_held',
						actor: { kind: 'system' },
						provenance: 'recorded',
						eventAt: SENT + i * MIN,
					});
				}
			}
		});
		const first = await t.query(api.inbox.teamStream.page, { threadId, locale: 'en' });
		expect(first?.isDone).toBe(false);
		expect(first?.entries).toHaveLength(STREAM_PAGE_SIZE);
		const walked = await walkTeam(t, threadId);
		const keys = walked.map((e) => e.key);
		expect(new Set(keys).size).toBe(keys.length);
		expect(walked.filter((e) => e.kind === 'note')).toHaveLength(STREAM_PAGE_SIZE + 15);
		expect(walked.filter((e) => e.kind === 'activity')).toHaveLength(19);
		expect(walked.filter((e) => e.kind === 'customerEmail')).toHaveLength(1);
		const ats = walked.map((e) => e.at);
		expect([...ats].sort((a, b) => a - b)).toEqual(ats);
	});

	it('is closed to anyone who cannot read the Team Inbox', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedTeamThread(t);
		await t.run(async (ctx) => {
			await ctx.db.insert('threadNotes', {
				threadId,
				authorId: 'user-A',
				body: 'internal only',
				mentionedUserIds: [],
				createdAt: SENT,
			});
		});
		session.current = { userId: 'user-B', role: 'member', activeOrganizationId: 'org-1' };
		expect(await t.query(api.inbox.teamStream.page, { threadId, locale: 'en' })).toBeNull();
	});

	it('keeps a deleted note as a tombstone without its text', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedTeamThread(t);
		const noteId = await t.mutation(api.inbox.notes.create, { threadId, body: 'oops' });
		await t.mutation(api.inbox.notes.remove, { noteId });
		const page = await t.query(api.inbox.teamStream.page, { threadId, locale: 'en' });
		expect(page?.entries.find((e) => e.kind === 'note')).toMatchObject({
			isDeleted: true,
			body: '',
			reactions: [],
		});
	});
});

describe('Workbench team rows', () => {
	it("lead with the top open action of the team, never the customer's", async () => {
		const t = convexTest(schema, modules);
		const { threadId, inboundId } = await seedTeamThread(t);
		await interpretTeam(t, threadId, inboundId);
		const rows = await t.query(api.inbox.teamStream.topItems, {
			threadIds: [threadId],
			locale: 'de',
		});
		expect(rows).toEqual([
			expect.objectContaining({ threadId, text: 'Schick den unterschriebenen Vertrag', count: 1 }),
		]);
		session.current = { userId: 'user-B', role: 'member', activeOrganizationId: 'org-1' };
		expect(
			await t.query(api.inbox.teamStream.topItems, { threadIds: [threadId], locale: 'en' })
		).toEqual([]);
	});
});

describe('shared mailbox stream', () => {
	it('carries the discussion only with chat on, and never to a reader without access', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, threadId } = await seedMailThread(t, {
			address: 'sales@owlat.test',
			scope: 'shared',
		});
		await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{
				text: 'Our reply',
				receivedAt: SENT + 5 * MIN,
				fromAddress: 'sales@owlat.test',
			}
		);
		await enableFeatures(t, ['chat']);
		await t.mutation(api.chat.mailDiscussion.post, { threadId, body: 'Who takes this?' });

		const withChat = await t.query(api.mail.interpret.teamStream.page, { threadId, locale: 'en' });
		expect(kinds(withChat)).toEqual(['customerEmail', 'teamReply', 'note']);
		expect(withChat?.entries[2]).toMatchObject({
			noteSource: 'chatMessage',
			body: 'Who takes this?',
		});

		await t.run(async (ctx) => {
			const flagRow = await ctx.db.query('featureFlagSettings').first();
			if (flagRow) {
				await ctx.db.patch(flagRow._id, {
					featureFlags: { ...flagRow.featureFlags, chat: false },
				});
			}
			const settings = await ctx.db.query('instanceSettings').first();
			if (settings) {
				await ctx.db.patch(settings._id, {
					featureFlags: { ...settings.featureFlags, chat: false },
				});
			}
		});
		const withoutChat = await t.query(api.mail.interpret.teamStream.page, {
			threadId,
			locale: 'en',
		});
		expect(kinds(withoutChat)).toEqual(['customerEmail', 'teamReply']);

		session.current = { userId: 'user-B', role: 'member', activeOrganizationId: 'org-1' };
		expect(
			await t.query(api.mail.interpret.teamStream.page, { threadId, locale: 'en' })
		).toBeNull();
	});
});

describe('the stream stays out of every prompt and mail', () => {
	const ROOT = join(__dirname, '..', '..', '..');
	function files(dir: string): string[] {
		const out: string[] = [];
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) {
				if (name !== '__tests__' && name !== '_generated' && name !== 'node_modules') {
					out.push(...files(path));
				}
			} else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(path);
		}
		return out;
	}

	it('is read by no module but its own', () => {
		const readers = files(ROOT)
			.filter((path) =>
				/teamStream(Read|Merge)?['"]|\bteamStream\.page\b/.test(readFileSync(path, 'utf8'))
			)
			.map((path) => relative(ROOT, path).split('\\').join('/'))
			.sort();
		expect(readers).toEqual([
			'inbox/teamStream.ts',
			'mail/interpret/teamStream.ts',
			'mail/interpret/teamStreamRead.ts',
		]);
	});
});
