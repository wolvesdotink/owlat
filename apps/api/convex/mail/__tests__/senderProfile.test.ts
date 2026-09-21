/**
 * The sender profile read (plan idea 45).
 *
 * The properties worth pinning are the ones that make it safe to render as a
 * badge: it is scoped to ONE mailbox and one address, it never asserts an
 * authentication verdict it did not observe, and it stays a bounded indexed
 * take no matter how long the correspondence has run.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import { modules, seedMailbox, seedFolder, seedMessage } from './helpers.testlib';

const sessionMocks = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'owner' as 'owner' | 'admin' | 'editor',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
		})),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
			activeOrganizationId: 'org-1',
		})),
	};
});

beforeEach(() => {
	sessionMocks.userId = 'user-A';
	sessionMocks.role = 'owner';
});

const INES = 'ines@northwind.studio';

/** Stamp inbound-authentication verdicts onto an already-seeded message. */
async function stampAuth(
	t: ReturnType<typeof convexTest>,
	messageId: Id<'mailMessages'>,
	patch: Record<string, string>
) {
	await t.run(async (ctx) => {
		await ctx.db.patch(messageId, patch);
	});
}

describe('mail.senderProfile.profile', () => {
	it('summarizes one sender: name, count, window and recent threads', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);

		await seedMessage(t, mailboxId, {
			subject: 'Invoice 4471 double-charged',
			fromAddress: INES,
			fromName: 'Ines Weber',
			receivedAt: 1_000,
		});
		await seedMessage(t, mailboxId, {
			subject: 'Onboarding call move?',
			fromAddress: INES,
			receivedAt: 3_000,
		});
		// Someone else's mail must not leak into her profile.
		await seedMessage(t, mailboxId, { subject: 'Unrelated', fromAddress: 'bob@example.com' });

		const profile = await t.query(api.mail.senderProfile.profile, { mailboxId, email: INES });
		expect(profile.messageCount).toBe(2);
		expect(profile.isCountCapped).toBe(false);
		expect(profile.displayName).toBe('Ines Weber');
		expect(profile.firstSeenAt).toBe(1_000);
		expect(profile.lastSeenAt).toBe(3_000);
		expect(profile.threads.map((row) => row.subject)).toEqual([
			'Onboarding call move?',
			'Invoice 4471 double-charged',
		]);
		expect(profile.threads.every((row) => row.folderParam === 'inbox')).toBe(true);
	});

	it('matches the address case-insensitively, as the index stores it', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		await seedMessage(t, mailboxId, { fromAddress: INES });

		const profile = await t.query(api.mail.senderProfile.profile, {
			mailboxId,
			email: '  Ines@Northwind.Studio ',
		});
		expect(profile.email).toBe(INES);
		expect(profile.messageCount).toBe(1);
	});

	it('reports unknown authentication rather than implying a pass', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		await seedMessage(t, mailboxId, { fromAddress: INES });

		const profile = await t.query(api.mail.senderProfile.profile, { mailboxId, email: INES });
		expect(profile.auth).toMatchObject({ verdict: 'unknown', checked: 0, passed: 0 });
	});

	it('reports a clean record as a pass and a broken one as mixed', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		const first = await seedMessage(t, mailboxId, { fromAddress: INES, receivedAt: 1_000 });
		const second = await seedMessage(t, mailboxId, { fromAddress: INES, receivedAt: 2_000 });
		await stampAuth(t, first, { dmarcResult: 'pass', spfResult: 'pass', dkimResult: 'pass' });
		await stampAuth(t, second, { dmarcResult: 'pass' });

		let profile = await t.query(api.mail.senderProfile.profile, { mailboxId, email: INES });
		expect(profile.auth).toMatchObject({ verdict: 'pass', checked: 2, passed: 2 });

		await stampAuth(t, second, { dmarcResult: 'fail' });
		profile = await t.query(api.mail.senderProfile.profile, { mailboxId, email: INES });
		expect(profile.auth).toMatchObject({ verdict: 'mixed', checked: 2, passed: 1 });
	});

	it('counts an ARC-rescued DMARC fail as a pass and names the forwarder', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		const messageId = await seedMessage(t, mailboxId, { fromAddress: INES });
		await stampAuth(t, messageId, {
			dmarcResult: 'fail',
			dmarcOverride: 'arc',
			arcSealer: 'lists.example',
		});

		const profile = await t.query(api.mail.senderProfile.profile, { mailboxId, email: INES });
		expect(profile.auth.verdict).toBe('pass');
		expect(profile.auth.latest?.arcSealer).toBe('lists.example');
	});

	it('lists each conversation once, however many messages it holds', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		const first = await seedMessage(t, mailboxId, { subject: 'Thread A', fromAddress: INES });
		const second = await seedMessage(t, mailboxId, {
			subject: 'Thread A again',
			fromAddress: INES,
		});
		// Fold the second message into the first's thread, as a real reply would be.
		await t.run(async (ctx) => {
			const a = await ctx.db.get(first);
			await ctx.db.patch(second, { threadId: a!.threadId });
		});

		const profile = await t.query(api.mail.senderProfile.profile, { mailboxId, email: INES });
		expect(profile.messageCount).toBe(2);
		expect(profile.threads).toHaveLength(1);
	});

	it('returns the empty profile for a nonsense address instead of scanning', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		await seedMessage(t, mailboxId, { fromAddress: INES });

		const profile = await t.query(api.mail.senderProfile.profile, {
			mailboxId,
			email: 'not-an-address',
		});
		expect(profile).toMatchObject({ messageCount: 0, threads: [], firstSeenAt: null });
	});

	it('never serves another org member’s mailbox', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'user-A' });
		await seedFolder(t, mailboxId);
		await seedMessage(t, mailboxId, { fromAddress: INES });

		sessionMocks.userId = 'user-B';
		sessionMocks.role = 'editor';
		const profile = await t.query(api.mail.senderProfile.profile, { mailboxId, email: INES });
		expect(profile).toMatchObject({ messageCount: 0, threads: [] });
	});
});
