/**
 * "Export my data" includes what interpretation derived from the member's
 * own personal mail (SPEC §5): per thread its items, facts and activity,
 * unsealed, plus the member's own brief view state. Nothing from a team
 * inbox, nothing from another member's mailbox, and no internal notes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TestConvex } from 'convex-test';
import type schema from '../schema';
import type { Id } from '../_generated/dataModel';
import { sealBodyAtWrite } from '../lib/messageBody';
import { emptyBriefRow } from '../mail/interpret/briefRow';
import { resetSessionMock } from './gdprSessionMock';
import {
	EXPORT_TEST_SECRET,
	EXPORT_TEST_SITE,
	newHarness,
	seedProfile,
	seedOrg,
	seedMember,
	exportAllUserData,
} from './gdprAccountFixtures';
import { seedFolder, seedMailbox, seedMessage } from '../mail/__tests__/helpers.testlib';

vi.mock('../lib/sessionOrganization', async () => {
	const { gdprSessionOrganizationMock } = await import('./gdprSessionMock');
	return await gdprSessionOrganizationMock();
});

beforeEach(resetSessionMock);
afterEach(() => {
	vi.unstubAllEnvs();
});

/** A mailbox with one thread whose brief holds one item, one fact and one activity row. */
async function seedBriefThread(
	t: TestConvex<typeof schema>,
	opts: { userId: string; address: string; scope?: 'shared'; label: string }
): Promise<Id<'mailThreads'>> {
	const mailboxId = await seedMailbox(t, {
		userId: opts.userId,
		organizationId: 'org-x',
		address: opts.address,
		domain: 'example.com',
		...(opts.scope ? { scope: opts.scope } : {}),
	});
	await seedFolder(t, mailboxId, 'inbox');
	const messageId = await seedMessage(t, mailboxId, { subject: opts.label });
	return t.run(async (ctx) => {
		const now = Date.now();
		const threadId = (await ctx.db.get(messageId))!.threadId;
		const ref = { threadKind: 'mail' as const, mailThreadId: threadId };
		await ctx.db.insert('threadBriefs', {
			...emptyBriefRow({ kind: 'mail', id: threadId }, opts.scope ? 'actions' : 'brief', now),
			completeness: 'complete',
		});
		const evidence = [
			{
				source: { kind: 'mail' as const, id: messageId },
				segmentId: 's0',
				start: 0,
				end: 10,
				contentRevision: 'rev-1',
				quote: await sealBodyAtWrite(`${opts.label} quote`),
			},
		];
		await ctx.db.insert('threadItems', {
			...ref,
			mailboxId,
			revision: 1,
			intent: 'request',
			facets: ['payment'],
			assertion: await sealBodyAtWrite(`${opts.label}: pay the invoice`),
			display: {
				en: await sealBodyAtWrite(`${opts.label}: pay the invoice`),
				de: await sealBodyAtWrite(`${opts.label}: zahl die Rechnung`),
			},
			requester: { email: 'jonas@example.com', isUs: false },
			responsible: { isUs: true },
			responsibility: 'us',
			status: 'open',
			disposition: 'unanswered',
			amount: { value: 100, currency: 'EUR' },
			evidence,
			verify: 'passed',
			askedAt: now,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert('threadFacts', {
			...ref,
			factKey: '["invoice","number",""]',
			assertion: await sealBodyAtWrite(`${opts.label}: invoice R-7`),
			display: {
				en: await sealBodyAtWrite('Invoice R-7'),
				de: await sealBodyAtWrite('Rechnung R-7'),
			},
			value: { kind: 'ref', text: await sealBodyAtWrite('R-7') },
			evidence,
			provenance: 'reported',
			status: 'current',
			revision: 1,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert('threadActivity', {
			...ref,
			seq: 1,
			idempotencyKey: `mail:${threadId}|received`,
			type: 'message_received',
			actor: { kind: 'sender' },
			provenance: 'recorded',
			visibility: 'substance',
			payload: await sealBodyAtWrite(JSON.stringify({ text: `${opts.label} arrived` })),
			payloadVersion: 1,
			eventAt: now,
			recordedAt: now,
		});
		return threadId;
	});
}

describe('account export: thread brief', () => {
	it("exports the member's own derived content unsealed, and nothing else", async () => {
		vi.stubEnv('INSTANCE_SECRET', EXPORT_TEST_SECRET);
		vi.stubEnv('CONVEX_SITE_URL', EXPORT_TEST_SITE);
		const t = newHarness();
		await seedProfile(t, 'auth-user-1', 'me@example.com');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'editor');

		const mine = await seedBriefThread(t, {
			userId: 'auth-user-1',
			address: 'me@example.com',
			label: 'Mine',
		});
		await seedBriefThread(t, {
			userId: 'auth-user-1',
			address: 'team@example.com',
			scope: 'shared',
			label: 'Team',
		});
		const theirs = await seedBriefThread(t, {
			userId: 'auth-user-2',
			address: 'other@example.com',
			label: 'Theirs',
		});
		await t.run(async (ctx) => {
			for (const [userId, threadId] of [
				['auth-user-1', mine],
				['auth-user-2', theirs],
			] as const) {
				await ctx.db.insert('threadViewerState', {
					threadKind: 'mail',
					mailThreadId: threadId,
					userId,
					viewOverride: 'conversation',
					seenInterpretationRevision: 1,
					seenActivitySeq: 1,
					updatedAt: 1,
				});
			}
		});

		const exported = await exportAllUserData(t, 'auth-user-1');
		const briefs = exported.personalData.threadBriefs as Array<Record<string, unknown>>;
		expect(briefs).toHaveLength(1);
		expect(briefs[0]).toMatchObject({
			threadId: mine,
			mode: 'brief',
			items: [
				{
					assertion: 'Mine: pay the invoice',
					display: { en: 'Mine: pay the invoice', de: 'Mine: zahl die Rechnung' },
					amount: { value: 100, currency: 'EUR' },
					evidence: [{ quote: 'Mine quote' }],
				},
			],
			isItemsTruncated: false,
			facts: [{ assertion: 'Mine: invoice R-7', value: { kind: 'ref', text: 'R-7' } }],
			activity: [{ type: 'message_received', payload: { text: 'Mine arrived' } }],
		});
		const text = JSON.stringify(briefs);
		expect(text).not.toContain('Team');
		expect(text).not.toContain('Theirs');
		// The stored rows are sealed; the export opened them.
		const stored = await t.run(async (ctx) => ctx.db.query('threadItems').first());
		expect(stored?.assertion).not.toContain('pay the invoice');

		const viewer = exported.personalData.threadViewerState as Array<Record<string, unknown>>;
		expect(viewer).toEqual([
			expect.objectContaining({ userId: 'auth-user-1', mailThreadId: mine }),
		]);
	});
});
