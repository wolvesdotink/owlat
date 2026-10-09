/**
 * Daily Brief commitments ↔ thread brief items (mail/interpret/commitmentLink.ts):
 * the commitment links to the item for the same obligation, the item links
 * back, and closing the item leaves the commitment's reminder state alone.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { api, internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import { onItemsCreated, pickCommitmentItem } from '../commitmentLink';
import { modules, reduceItem, reduceResult, seedMailThread, type Test } from './interpret.testlib';

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
	};
});

beforeEach(() => {
	session.current = { userId: 'user-A', role: 'owner', activeOrganizationId: 'org-1' };
});

const SENT = Date.UTC(2026, 9, 7, 9, 0);

async function interpret(t: Test, messageId: Id<'mailMessages'>, threadId: Id<'mailThreads'>) {
	await t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
		source: { kind: 'mail', id: messageId },
		threadRef: { kind: 'mail', id: threadId },
		mode: 'brief',
		contentRevision: 'rev-1',
		extractorVersion: 1,
		expectedRevision: 0,
		deletionEpoch: 0,
		sourceAt: SENT,
		direction: 'inbound',
		status: 'complete',
		result: reduceResult({
			items: [
				reduceItem(),
				reduceItem({
					assertion: 'Confirm the venue',
					display: { en: 'Jonas confirms the venue', de: 'Jonas bestätigt den Ort' },
					responsible: { email: 'jonas@example.com', isUs: false },
					due: undefined,
				}),
			],
		}),
	});
	return t.run(async (ctx) =>
		(await ctx.db.query('threadItems').collect()).find((i) => i.responsibility === 'us')!
	);
}

const commitmentArgs = (
	mailboxId: Id<'mailboxes'>,
	threadId: Id<'mailThreads'>,
	messageId: Id<'mailMessages'>
) => ({
	mailboxId,
	threadId,
	messageId,
	direction: 'inbound' as const,
	description: 'Send the signed contract by Friday',
	dueAt: Date.UTC(2026, 9, 9),
	source: 'llm' as const,
});

describe('commitment links', () => {
	it('links a commitment extracted after the interpretation, both ways', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId, threadId } = await seedMailThread(t);
		const item = await interpret(t, messageId, threadId);
		await t.mutation(
			internal.mail.commitments.applyCommitment,
			commitmentArgs(mailboxId, threadId, messageId)
		);
		const commitment = await t.run(async (ctx) => ctx.db.query('mailCommitments').first());
		expect(commitment?.threadItemId).toBe(item._id);
		const linked = await t.run(async (ctx) => ctx.db.get(item._id));
		expect(linked?.commitmentId).toBe(commitment?._id);
		// Linking is not a change of the obligation: the revision stays.
		expect(linked?.revision).toBe(item.revision);

		// Closing the item does not touch the commitment's reminder state.
		await t.mutation(api.mail.interpret.reactions.markDone, { itemId: item._id });
		expect((await t.run(async (ctx) => ctx.db.get(commitment!._id)))?.status).toBe('open');
	});

	it('links a commitment that landed first once the items exist', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId, threadId } = await seedMailThread(t);
		await t.mutation(
			internal.mail.commitments.applyCommitment,
			commitmentArgs(mailboxId, threadId, messageId)
		);
		expect(
			(await t.run(async (ctx) => ctx.db.query('mailCommitments').first()))?.threadItemId
		).toBeUndefined();
		// The reducer links once it has inserted the message's items.
		const item = await interpret(t, messageId, threadId);
		const commitment = await t.run(async (ctx) => ctx.db.query('mailCommitments').first());
		expect(commitment?.threadItemId).toBe(item._id);
		expect((await t.run(async (ctx) => ctx.db.get(item._id)))?.commitmentId).toBe(commitment?._id);

		// The hook itself: nothing created, or a Team Inbox source, links nothing.
		await t.run(async (ctx) => {
			await ctx.db.patch(commitment!._id, { threadItemId: undefined });
			await ctx.db.patch(item._id, { commitmentId: undefined });
		});
		await t.run(async (ctx) => onItemsCreated(ctx, { kind: 'mail', id: messageId }, []));
		await t.run(async (ctx) =>
			onItemsCreated(ctx, { kind: 'inbound', id: 'x' as Id<'inboundMessages'> }, [item._id])
		);
		expect(
			(await t.run(async (ctx) => ctx.db.query('mailCommitments').first()))?.threadItemId
		).toBeUndefined();
		await t.run(async (ctx) => onItemsCreated(ctx, { kind: 'mail', id: messageId }, [item._id]));
		expect(
			(await t.run(async (ctx) => ctx.db.query('mailCommitments').first()))?.threadItemId
		).toBe(item._id);
	});
});

describe('pickCommitmentItem', () => {
	const messageId = 'm1' as Id<'mailMessages'>;
	const evidence = [
		{
			source: { kind: 'mail' as const, id: messageId },
			segmentId: 's0',
			start: 0,
			end: 1,
			contentRevision: 'r',
		},
	];
	const item = (id: string, over: Record<string, unknown> = {}) => ({
		_id: id as Id<'threadItems'>,
		intent: 'request' as const,
		responsibility: 'us' as const,
		evidence,
		askedAt: 1,
		...over,
	});
	const commitment = (direction: 'inbound' | 'outbound') => ({
		_id: 'c1' as Id<'mailCommitments'>,
		messageId,
		direction,
	});

	it('prefers the promise for an outbound commitment and the ask for an inbound one', () => {
		const items = [item('ask'), item('promise', { intent: 'promise' })];
		expect(pickCommitmentItem(commitment('outbound'), items)?._id).toBe('promise');
		expect(pickCommitmentItem(commitment('inbound'), items)?._id).toBe('ask');
	});

	it('only takes our items quoting the message and not linked elsewhere', () => {
		expect(
			pickCommitmentItem(commitment('inbound'), [
				item('theirs', { responsibility: 'them' }),
				item('other', { evidence: [] }),
				item('taken', { commitmentId: 'c2' as Id<'mailCommitments'> }),
			])
		).toBeNull();
	});

	it('prefers an item with a due date', () => {
		expect(
			pickCommitmentItem(commitment('inbound'), [
				item('undated', { askedAt: 0 }),
				item('dated', { due: { phrase: 'Friday', isAmbiguous: false } }),
			])?._id
		).toBe('dated');
	});
});
