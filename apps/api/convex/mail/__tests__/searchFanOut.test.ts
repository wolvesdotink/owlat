/**
 * Multi-mailbox search (`mail/mailbox/search.ts::search`).
 *
 * The query grew from "one required mailboxId" to "an array, or everything the
 * caller can read", which puts three things at risk that only an end-to-end run
 * can show: that the single-mailbox call is byte-for-byte the old behaviour,
 * that the fan-out merges by `receivedAt` rather than by mailbox, and that the
 * manual keyset walks the union without skipping or repeating a message. The
 * authz edge — a mailbox id the caller cannot read — is asserted here too,
 * because the fan-out re-derives the target set rather than taking the caller's.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import { modules, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';

const sessionMock = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'editor' as 'owner' | 'admin' | 'editor' | null,
	orgId: 'org-1',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => {
			if (sessionMock.role === null) throw new Error('Not authenticated');
			return { userId: sessionMock.userId, role: sessionMock.role };
		}),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getBetterAuthSessionWithRole: vi.fn(async () => {
			if (sessionMock.role === null) return null;
			return {
				userId: sessionMock.userId,
				role: sessionMock.role,
				activeOrganizationId: sessionMock.orgId,
			};
		}),
	};
});

type Ctx = TestConvex<typeof schema>;

/** A mailbox with an inbox folder, owned by `userId`. */
async function seedInbox(t: Ctx, userId: string, address: string): Promise<Id<'mailboxes'>> {
	const mailboxId = await seedMailbox(t, { userId, address });
	await seedFolder(t, mailboxId);
	return mailboxId;
}

/** One message in the mailbox's inbox, at a controlled arrival time. */
async function seedAt(t: Ctx, mailboxId: Id<'mailboxes'>, subject: string, receivedAt: number) {
	return await seedMessage(t, mailboxId, { subject, receivedAt });
}

/** Two mailboxes of user-A with interleaved arrival times. */
async function seedTwoMailboxes(t: Ctx) {
	const personal = await seedInbox(t, 'user-A', 'a@hinterland.camp');
	const team = await seedInbox(t, 'user-A', 'team@hinterland.camp');
	await seedAt(t, personal, 'oldest', 1_000);
	await seedAt(t, team, 'middle', 2_000);
	await seedAt(t, personal, 'newest', 3_000);
	return { personal, team };
}

/** Subjects of a search response, in the order the query returned them. */
function subjects(result: { messages: Array<{ subject: string }> }): string[] {
	return result.messages.map((m) => m.subject);
}

describe('search — single mailbox (legacy shape)', () => {
	it('still searches only the named mailbox', async () => {
		const t = convexTest(schema, modules);
		const { personal } = await seedTwoMailboxes(t);
		const result = await t.query(api.mail.mailbox.search.search, {
			mailboxId: personal,
			text: '',
		});
		expect(subjects(result)).toEqual(['newest', 'oldest']);
	});

	it('returns empty for a mailbox the caller cannot read', async () => {
		const t = convexTest(schema, modules);
		const foreign = await seedInbox(t, 'user-B', 'b@hinterland.camp');
		await seedAt(t, foreign, 'secret', 5_000);
		const result = await t.query(api.mail.mailbox.search.search, { mailboxId: foreign, text: '' });
		expect(result).toEqual({ messages: [], hasMore: false, nextCursor: null });
	});
});

describe('search — fan-out', () => {
	it('merges every readable mailbox newest-first when none is named', async () => {
		const t = convexTest(schema, modules);
		await seedTwoMailboxes(t);
		const result = await t.query(api.mail.mailbox.search.search, { text: '' });
		expect(subjects(result)).toEqual(['newest', 'middle', 'oldest']);
	});

	it('searches exactly the requested mailboxes', async () => {
		const t = convexTest(schema, modules);
		const { team } = await seedTwoMailboxes(t);
		const result = await t.query(api.mail.mailbox.search.search, {
			mailboxIds: [team],
			text: '',
		});
		expect(subjects(result)).toEqual(['middle']);
	});

	it('drops a requested mailbox the caller cannot read', async () => {
		const t = convexTest(schema, modules);
		const { personal } = await seedTwoMailboxes(t);
		const foreign = await seedInbox(t, 'user-B', 'b@hinterland.camp');
		await seedAt(t, foreign, 'secret', 9_000);
		const result = await t.query(api.mail.mailbox.search.search, {
			mailboxIds: [personal, foreign],
			text: '',
		});
		expect(subjects(result)).toEqual(['newest', 'oldest']);
	});

	it('never leaks another user’s mailbox into the "everything readable" default', async () => {
		const t = convexTest(schema, modules);
		await seedTwoMailboxes(t);
		const foreign = await seedInbox(t, 'user-B', 'b@hinterland.camp');
		await seedAt(t, foreign, 'secret', 9_000);
		const result = await t.query(api.mail.mailbox.search.search, { text: '' });
		expect(subjects(result)).not.toContain('secret');
	});

	it('walks the union one row at a time without skipping or repeating', async () => {
		const t = convexTest(schema, modules);
		await seedTwoMailboxes(t);
		const seen: string[] = [];
		let cursor: string | undefined;
		for (let guard = 0; guard < 10; guard += 1) {
			const page: { messages: Array<{ subject: string }>; hasMore: boolean; nextCursor: unknown } =
				await t.query(api.mail.mailbox.search.search, { text: '', limit: 1, cursor });
			seen.push(...subjects(page));
			if (!page.hasMore) break;
			cursor = page.nextCursor as string;
		}
		expect(seen).toEqual(['newest', 'middle', 'oldest']);
	});

	it('keeps making progress when a whole page shares one timestamp', async () => {
		// Same-millisecond arrivals are the case a naive `receivedAt` keyset either
		// loops on forever or steps over; walking them one row at a time must still
		// terminate having seen each exactly once.
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t, 'user-A', 'a@hinterland.camp');
		for (const subject of ['tie-1', 'tie-2', 'tie-3']) {
			await seedAt(t, mailboxId, subject, 4_000);
		}
		const seen: string[] = [];
		let cursor: string | undefined;
		for (let guard = 0; guard < 12; guard += 1) {
			const page: { messages: Array<{ subject: string }>; hasMore: boolean; nextCursor: unknown } =
				await t.query(api.mail.mailbox.search.search, { text: '', limit: 1, cursor });
			seen.push(...subjects(page));
			if (!page.hasMore) break;
			cursor = page.nextCursor as string;
		}
		expect(seen.slice().sort()).toEqual(['tie-1', 'tie-2', 'tie-3']);
	});

	it('applies the structured operators per mailbox', async () => {
		const t = convexTest(schema, modules);
		await seedTwoMailboxes(t);
		const result = await t.query(api.mail.mailbox.search.search, {
			text: '',
			subject: 'mid',
		});
		expect(subjects(result)).toEqual(['middle']);
	});

	it('merges free-text hits from every mailbox', async () => {
		const t = convexTest(schema, modules);
		const personal = await seedInbox(t, 'user-A', 'a@hinterland.camp');
		const team = await seedInbox(t, 'user-A', 'team@hinterland.camp');
		await seedAt(t, personal, 'invoice overdue', 1_000);
		await seedAt(t, team, 'invoice paid', 2_000);
		await seedAt(t, personal, 'lunch', 3_000);
		const result = await t.query(api.mail.mailbox.search.search, { text: 'invoice' });
		expect(subjects(result)).toEqual(['invoice paid', 'invoice overdue']);
	});

	it('returns nothing for an anonymous caller', async () => {
		const t = convexTest(schema, modules);
		await seedTwoMailboxes(t);
		sessionMock.role = null;
		try {
			const result = await t.query(api.mail.mailbox.search.search, { text: '' });
			expect(result).toEqual({ messages: [], hasMore: false, nextCursor: null });
		} finally {
			sessionMock.role = 'editor';
		}
	});
});
