/**
 * `findKnownMessageIds` — the backfill's pre-download dedup check.
 *
 * The walk used to learn a message was a duplicate only after downloading it in
 * full and uploading its raw bytes, so a re-walk paid the provider's bandwidth
 * for mail that was already imported. Behind Gmail's daily IMAP cap that is the
 * difference between an import that converges and one that cannot: a 21 GiB
 * Sent folder spends the budget re-fetching the 12 GiB it has, gets
 * `* BYE [OVERQUOTA]`, and never reaches the rest.
 *
 * The contract that matters here is that this answers EXACTLY what the ingest
 * path would have called a duplicate — same canonicalisation, same
 * mailbox scoping. Answer "known" for something the ingest path would import
 * and the message is silently dropped from the import.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { modules, seedMailbox, seedFolder, seedMessage } from './helpers.testlib';

async function seedAccount(
	t: ReturnType<typeof convexTest>,
	mailboxId: Id<'mailboxes'>
): Promise<Id<'externalMailAccounts'>> {
	let id!: Id<'externalMailAccounts'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		id = await ctx.db.insert('externalMailAccounts', {
			userId: 'user-A',
			organizationId: 'org-1',
			mailboxId,
			imapHost: 'imap.gmail.example',
			imapPort: 993,
			isImapSecure: true,
			smtpHost: 'smtp.gmail.example',
			smtpPort: 465,
			isSmtpSecure: true,
			authMethod: 'password' as const,
			imapUsername: 'team@acme.test',
			status: 'connected' as const,
			createdAt: now,
			updatedAt: now,
		});
	});
	return id;
}

describe('findKnownMessageIds', () => {
	it('recognises a stored message through its angle brackets', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId, 'sent');
		// Stored canonicalised (no brackets), as every ingest path writes it.
		await seedMessage(t, mailboxId, { role: 'sent', rfc822MessageId: 'kept@acme.test' });
		const accountId = await seedAccount(t, mailboxId);

		const known = await t.query(internal.mail.migrationBackfill.findKnownMessageIds, {
			accountId,
			// The server reports them bracketed; the caller gets its own strings back.
			messageIds: ['<kept@acme.test>', '<missing@acme.test>'],
		});

		expect(known).toEqual(['<kept@acme.test>']);
	});

	it('does not recognise a message that lives in a different mailbox', async () => {
		const t = convexTest(schema, modules);
		const ours = await seedMailbox(t, { address: 'team@acme.test' });
		const theirs = await seedMailbox(t, { address: 'other@acme.test' });
		await seedFolder(t, theirs, 'inbox');
		await seedMessage(t, theirs, { rfc822MessageId: 'elsewhere@acme.test' });
		const accountId = await seedAccount(t, ours);

		const known = await t.query(internal.mail.migrationBackfill.findKnownMessageIds, {
			accountId,
			messageIds: ['<elsewhere@acme.test>'],
		});

		// Answering "known" here would drop the message from this import forever.
		expect(known).toEqual([]);
	});

	it('answers nothing for an account that no longer exists', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const accountId = await seedAccount(t, mailboxId);
		await t.run(async (ctx) => await ctx.db.delete(accountId));

		const known = await t.query(internal.mail.migrationBackfill.findKnownMessageIds, {
			accountId,
			messageIds: ['<any@acme.test>'],
		});

		expect(known).toEqual([]);
	});

	it('bounds one call, so a malformed caller cannot fan out unboundedly', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId, 'inbox');
		await seedMessage(t, mailboxId, { rfc822MessageId: 'late@acme.test' });
		const accountId = await seedAccount(t, mailboxId);

		// The one stored id sits past the 500-id ceiling, so it is not looked at.
		const filler = Array.from({ length: 500 }, (_, i) => `<f${i}@acme.test>`);
		const known = await t.query(internal.mail.migrationBackfill.findKnownMessageIds, {
			accountId,
			messageIds: [...filler, '<late@acme.test>'],
		});

		// Over-answering the cap would be the dangerous direction; under-answering
		// only costs a download the ingest path then dedupes.
		expect(known).toEqual([]);
	});
});
