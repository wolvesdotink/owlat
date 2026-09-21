/**
 * The composer's recipient-confidence reads (`mail/contacts`):
 * `knownRecipients` (which addresses are NOT strangers) and
 * `correspondentDomains` (the domains this mailbox writes to, the corpus behind
 * the did-you-mean hint).
 *
 * Both are soft-auth `publicQuery`s over per-user mail, so the boundary matters
 * as much as the answer: an `editor` may read only their OWN mailbox, and a
 * refused read returns EMPTY. Empty is the safe direction for `knownRecipients`
 * precisely because the client must not read "nothing is known" as "everyone is
 * a stranger" — the web guard only speaks once the query has actually answered
 * for a mailbox it owns.
 *
 * Session mocking mirrors mailOwnership.integration.test.ts: one mutable
 * hoisted session, flipped with `setUser`.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

const sessionMock = vi.hoisted(() => ({
	user: { id: 'user-alice', role: 'editor' as 'owner' | 'admin' | 'editor', orgId: 'org-1' },
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		getBetterAuthSessionWithRole: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
			activeOrganizationId: sessionMock.user.orgId,
		})),
		requireOrgMember: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
		})),
		getMutationContext: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
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

const setUser = (id: string, role: 'owner' | 'admin' | 'editor' = 'editor') => {
	sessionMock.user.id = id;
	sessionMock.user.role = role;
};

beforeEach(() => setUser('user-alice'));

async function seedMailbox(
	t: TestConvex<typeof schema>,
	ownerUserId: string,
	address: string
): Promise<Id<'mailboxes'>> {
	return t.run(async (ctx) => {
		const now = Date.now();
		return ctx.db.insert('mailboxes', {
			userId: ownerUserId,
			organizationId: 'org-1',
			address,
			domain: 'northwind.studio',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
	});
}

/** Seed address-book rows, oldest first, one hour apart. */
async function seedContacts(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	emails: string[]
) {
	await t.run(async (ctx) => {
		const now = Date.now();
		for (const [index, email] of emails.entries()) {
			await ctx.db.insert('mailContacts', {
				mailboxId,
				email,
				useCount: 1,
				lastUsedAt: now - (emails.length - index) * 3_600_000,
				createdAt: now,
			});
		}
	});
}

describe('mail.contacts.knownRecipients', () => {
	it('returns only the addresses already in the address book', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, 'user-alice', 'ada@northwind.studio');
		await seedContacts(t, mailboxId, ['ines@northwind.studio']);

		const known = await t.query(api.mail.contacts.knownRecipients, {
			mailboxId,
			emails: ['ines@northwind.studio', 'j.weber@acme-corp.io'],
		});
		expect(known).toEqual(['ines@northwind.studio']);
	});

	it('normalizes case and deduplicates the question', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, 'user-alice', 'ada@northwind.studio');
		await seedContacts(t, mailboxId, ['ines@northwind.studio']);

		const known = await t.query(api.mail.contacts.knownRecipients, {
			mailboxId,
			emails: ['INES@Northwind.Studio', 'ines@northwind.studio', 'not-an-address'],
		});
		expect(known).toEqual(['ines@northwind.studio']);
	});

	it('answers empty for a mailbox the caller does not own', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, 'user-alice', 'ada@northwind.studio');
		await seedContacts(t, mailboxId, ['ines@northwind.studio']);

		setUser('user-bob');
		expect(
			await t.query(api.mail.contacts.knownRecipients, {
				mailboxId,
				emails: ['ines@northwind.studio'],
			})
		).toEqual([]);
	});

	it('lets an org admin read a member mailbox', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, 'user-alice', 'ada@northwind.studio');
		await seedContacts(t, mailboxId, ['ines@northwind.studio']);

		setUser('user-admin', 'admin');
		expect(
			await t.query(api.mail.contacts.knownRecipients, {
				mailboxId,
				emails: ['ines@northwind.studio'],
			})
		).toEqual(['ines@northwind.studio']);
	});
});

describe('mail.contacts.correspondentDomains', () => {
	it('returns the distinct domains written to, most recent first', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, 'user-alice', 'ada@northwind.studio');
		await seedContacts(t, mailboxId, [
			'old@legacy.example',
			'ines@northwind.studio',
			'other@northwind.studio',
		]);

		expect(await t.query(api.mail.contacts.correspondentDomains, { mailboxId })).toEqual([
			'northwind.studio',
			'legacy.example',
		]);
	});

	it('answers empty for a mailbox the caller does not own', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, 'user-alice', 'ada@northwind.studio');
		await seedContacts(t, mailboxId, ['ines@northwind.studio']);

		setUser('user-bob');
		expect(await t.query(api.mail.contacts.correspondentDomains, { mailboxId })).toEqual([]);
	});
});
