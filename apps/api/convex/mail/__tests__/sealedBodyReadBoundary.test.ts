/**
 * Sealed Mail E8b — the READ BOUNDARY of the personal-mailbox surfaces.
 *
 * E8b seals `mailMessages.textBodyInline` / `htmlBodyInline` at rest and E8a
 * routed every reader that NAMES a body field through `lib/messageBody.ts`. The
 * list views, the search, the split-inbox sections and the by-id reads name no
 * body field at all — they return `Doc<'mailMessages'>` rows verbatim — so they
 * slipped past both, and the reader (which renders `htmlBodyInline` straight off
 * the row it was handed) started painting `atrest:1:…` envelopes as the message
 * body.
 *
 * What is pinned here is the boundary rule: sealing is an AT-REST property, so a
 * row that leaves an access-checked read carries PLAINTEXT — on every one of
 * those surfaces, for a sealed row and for a legacy-plaintext one alike, with an
 * absent inline column staying absent (the reader keys its lazy blob fetch on
 * exactly that).
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import type { DatabaseWriter } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { sealMessageBody } from '../../lib/messageBody';
import { isSealedAtRest } from '../../lib/atRestBodies';
import { modules, seedMailbox, seedFolder, seedMessage } from './helpers.testlib';

const INSTANCE_SECRET = 'unit-test-instance-secret-value';
const TEXT = 'Confirmation requested — click the link below to confirm.';
const HTML = '<p>Confirmation requested — click the link below to confirm.</p>';

// The reader surfaces are soft-auth: an org owner reads any mailbox in the org.
const sessionMocks = vi.hoisted(() => ({
	getBetterAuthSessionWithRole: vi.fn(),
}));
vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		getBetterAuthSessionWithRole: sessionMocks.getBetterAuthSessionWithRole,
	};
});

beforeEach(() => {
	vi.stubEnv('INSTANCE_SECRET', INSTANCE_SECRET);
	sessionMocks.getBetterAuthSessionWithRole.mockResolvedValue({
		userId: 'test-user',
		role: 'owner',
		activeOrganizationId: 'test-org',
	});
});
afterEach(() => {
	vi.unstubAllEnvs();
});

type T = ReturnType<typeof convexTest>;

/** A mailbox with an inbox folder, owned by the mocked session's user. */
async function seedInbox(t: T): Promise<Id<'mailboxes'>> {
	const mailboxId = await seedMailbox(t, {
		userId: 'test-user',
		organizationId: 'test-org',
		address: 'me@example.com',
		domain: 'example.com',
	});
	await seedFolder(t, mailboxId, 'inbox');
	return mailboxId;
}

/** Seed one message whose inline bodies are SEALED exactly as the write path
 * (and the E8b back-fill) leaves them. */
async function seedSealedMessage(
	t: T,
	mailboxId: Id<'mailboxes'>,
	over: { subject?: string; pinnedSection?: string; fromAddress?: string } = {}
): Promise<Id<'mailMessages'>> {
	const messageId = await seedMessage(t, mailboxId, {
		subject: over.subject ?? 'Confirmation Requested',
		...(over.fromAddress ? { fromAddress: over.fromAddress } : {}),
		...(over.pinnedSection ? { pinnedSection: over.pinnedSection } : {}),
		textBodyInline: await sealMessageBody(TEXT),
		htmlBodyInline: await sealMessageBody(HTML),
	});
	// Guard the premise: the row really is ciphertext at rest.
	await t.run(async (ctx: { db: DatabaseWriter }) => {
		const row = await ctx.db.get(messageId);
		expect(isSealedAtRest(row?.textBodyInline ?? '')).toBe(true);
		expect(isSealedAtRest(row?.htmlBodyInline ?? '')).toBe(true);
	});
	return messageId;
}

/** Assert a row the client received carries the plaintext body, not an envelope. */
function expectPlaintextBody(row: { textBodyInline?: string; htmlBodyInline?: string }): void {
	expect(row.textBodyInline).toBe(TEXT);
	expect(row.htmlBodyInline).toBe(HTML);
}

describe('mailMessages read boundary — sealed bodies leave as plaintext', () => {
	it('listMessages: a folder page carries decrypted inline bodies', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		await seedSealedMessage(t, mailboxId);

		const { messages } = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId,
			folderRole: 'inbox',
		});
		expect(messages).toHaveLength(1);
		expectPlaintextBody(messages[0]!);
	});

	it('listByLabel: the label view carries decrypted inline bodies', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		const messageId = await seedSealedMessage(t, mailboxId);
		const labelId = await t.run(async (ctx: { db: DatabaseWriter }) => {
			const id = await ctx.db.insert('mailLabels', {
				mailboxId,
				name: 'Bookings',
				createdAt: Date.now(),
			});
			await ctx.db.patch(messageId, { labelIds: [id] });
			return id;
		});

		const { messages } = await t.query(api.mail.mailbox.queries.listByLabel, {
			mailboxId,
			labelId,
		});
		expect(messages).toHaveLength(1);
		expectPlaintextBody(messages[0]!);
	});

	it('getMessage: the reader deep-link fallback carries a decrypted body', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		const messageId = await seedSealedMessage(t, mailboxId);

		const message = await t.query(api.mail.mailbox.messages.getMessage, { messageId });
		expect(message).not.toBeNull();
		expectPlaintextBody(message!);
	});

	it('listThreadMessages: every message in the conversation is decrypted', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		const messageId = await seedSealedMessage(t, mailboxId);

		const result = await t.query(api.mail.mailbox.messages.listThreadMessages, { messageId });
		expect(result?.messages).toHaveLength(1);
		expectPlaintextBody(result!.messages[0]!);
	});

	it('search: a structured (text-free) result page is decrypted', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		await seedSealedMessage(t, mailboxId, { fromAddress: 'no-reply@hinterland.camp' });

		const { messages } = await t.query(api.mail.mailbox.search.search, {
			mailboxId,
			text: '',
			from: 'no-reply',
		});
		expect(messages).toHaveLength(1);
		expectPlaintextBody(messages[0]!);
	});

	it('listSections: both the named section and the remainder are decrypted', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		await t.run(async (ctx: { db: DatabaseWriter }) => {
			const now = Date.now();
			await ctx.db.insert('mailFilters', {
				mailboxId,
				name: 'Deploys',
				isEnabled: true,
				priority: 100,
				conditions: [{ field: 'from', op: 'contains', value: 'ci@' }],
				actions: [{ type: 'pinToSection', sectionName: 'Deploys' }],
				stopProcessing: false,
				createdAt: now,
				updatedAt: now,
			});
		});
		await seedSealedMessage(t, mailboxId, { subject: 'Pinned', pinnedSection: 'Deploys' });
		await seedSealedMessage(t, mailboxId, { subject: 'Unpinned' });

		const { sections } = await t.query(api.mail.sections.listSections, { mailboxId });
		const named = sections.find((s) => s.name === 'Deploys');
		const remainder = sections.find((s) => s.name === null);
		expect(named?.messages).toHaveLength(1);
		expect(remainder?.messages).toHaveLength(1);
		expectPlaintextBody(named!.messages[0]!);
		expectPlaintextBody(remainder!.messages[0]!);
	});

	it('a legacy-plaintext row (pre-E8b / unmigrated) is returned verbatim', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		// Including one whose body merely STARTS with the reserved prefix: it is
		// plaintext, and the strict envelope test must read it as such.
		const looksSealed = 'atrest: not really — a customer pasted this';
		await seedMessage(t, mailboxId, {
			subject: 'Legacy',
			textBodyInline: looksSealed,
			htmlBodyInline: '<p>legacy html</p>',
		});

		const { messages } = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId,
			folderRole: 'inbox',
		});
		expect(messages[0]?.textBodyInline).toBe(looksSealed);
		expect(messages[0]?.htmlBodyInline).toBe('<p>legacy html</p>');
	});

	it('a blob-stored body keeps its inline columns ABSENT, not present-undefined', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		// No inline body at all — the shape the reader keys its lazy blob fetch on.
		await seedMessage(t, mailboxId, { subject: 'Big newsletter' });

		const { messages } = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId,
			folderRole: 'inbox',
		});
		expect(messages[0]).not.toHaveProperty('textBodyInline');
		expect(messages[0]).not.toHaveProperty('htmlBodyInline');
	});
});
