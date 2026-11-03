/**
 * `mail/contactsVcard.importBatch` writes parsed vCard entries into a
 * mailbox's address book: new rows as known contacts nobody has written to
 * yet, existing rows merged by address without losing what the mail built.
 * The server bounds every entry again, and the autocomplete reaches imported
 * rows outside its recent window. Export pages through the whole book.
 */
import { convexTest, type TestConvex } from 'convex-test';
import type { FunctionReturnType } from 'convex/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VCARD_IMPORT_BATCH_SIZE, VCARD_MAX_PHONES } from '@owlat/shared/postboxVcard';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import { modules, seedMailbox } from './helpers.testlib';

const sessionMock = vi.hoisted(() => ({
	userId: 'owner-user',
	role: 'editor' as 'owner' | 'admin' | 'editor',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = async () => ({ userId: sessionMock.userId, role: sessionMock.role });
	return {
		...actual,
		requireOrgMember: vi.fn(session),
		getMutationContext: vi.fn(session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			...(await session()),
			activeOrganizationId: 'org-1',
		})),
	};
});

type T = TestConvex<typeof schema>;

/** The cap on a name (`@owlat/shared/postboxVcardEntry`). */
const VCARD_MAX_TEXT_LENGTH = 256;

beforeEach(() => {
	sessionMock.userId = 'owner-user';
	sessionMock.role = 'editor';
});

async function contactsOf(t: T, mailboxId: Id<'mailboxes'>) {
	return t.run(async (ctx) =>
		ctx.db
			.query('mailContacts')
			.withIndex('by_mailbox_and_email', (q) => q.eq('mailboxId', mailboxId))
			.collect()
	);
}

describe('mail/contactsVcard.importBatch', () => {
	it('adds new rows and merges into rows the mail built', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'owner-user' });
		await t.run(async (ctx) => {
			await ctx.db.insert('mailContacts', {
				mailboxId,
				email: 'ada@example.com',
				displayName: 'Ada (work)',
				phones: [{ value: '+44 20 7946 0000', type: 'cell' }],
				useCount: 7,
				lastUsedAt: 5,
				createdAt: 5,
			});
		});

		const result = await t.mutation(api.mail.contactsVcard.importBatch, {
			mailboxId,
			entries: [
				{
					email: 'Ada@Example.com',
					displayName: 'Ada Lovelace',
					organization: 'Analytical Engines',
					phones: [{ value: '+44-20-7946-0000' }, { value: '+44 20 7946 0001', type: 'work' }],
				},
				{
					email: 'grace@example.org',
					displayName: 'Grace Hopper',
					postalAddresses: [{ type: 'work', street: '1 Navy Way', locality: 'Arlington' }],
				},
				{ email: 'not an address' },
			],
		});
		expect(result).toEqual({ created: 1, merged: 1, skipped: 1 });

		const rows = await contactsOf(t, mailboxId);
		const ada = rows.find((row) => row.email === 'ada@example.com')!;
		expect(ada).toMatchObject({
			displayName: 'Ada (work)',
			organization: 'Analytical Engines',
			phones: [
				{ value: '+44 20 7946 0000', type: 'cell' },
				{ value: '+44 20 7946 0001', type: 'work' },
			],
			useCount: 7,
			lastUsedAt: 5,
		});
		expect(ada.importedAt).toBeTypeOf('number');
		const grace = rows.find((row) => row.email === 'grace@example.org')!;
		expect(grace).toMatchObject({
			displayName: 'Grace Hopper',
			postalAddresses: [{ type: 'work', street: '1 Navy Way', locality: 'Arlington' }],
			useCount: 0,
		});
		expect(grace.importedAt).toBeTypeOf('number');

		// An imported row is a known contact to the reader's screener.
		const state = await t.query(api.mail.contacts.senderState, {
			mailboxId,
			email: 'grace@example.org',
		});
		expect(state.isKnown).toBe(true);
	});

	it('bounds what a hand-made call stores', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'owner-user' });
		await t.mutation(api.mail.contactsVcard.importBatch, {
			mailboxId,
			entries: [
				{
					email: 'long@example.com',
					displayName: `\u202e${'n'.repeat(VCARD_MAX_TEXT_LENGTH * 10)}`,
					phones: Array.from({ length: 50 }, (_, n) => ({ value: `+1 555 ${1000 + n}` })),
				},
			],
		});
		const [row] = await contactsOf(t, mailboxId);
		expect(row!.displayName).toBe('n'.repeat(VCARD_MAX_TEXT_LENGTH));
		expect(row!.phones).toHaveLength(VCARD_MAX_PHONES);

		const oversized = Array.from({ length: VCARD_IMPORT_BATCH_SIZE + 1 }, (_, n) => ({
			email: `p${n}@example.com`,
		}));
		await expect(
			t.mutation(api.mail.contactsVcard.importBatch, { mailboxId, entries: oversized })
		).rejects.toThrow(/At most/);
	});

	it("refuses another member's personal mailbox", async () => {
		const t = convexTest(schema, modules);
		const theirs = await seedMailbox(t, { userId: 'someone-else' });
		await expect(
			t.mutation(api.mail.contactsVcard.importBatch, {
				mailboxId: theirs,
				entries: [{ email: 'x@example.com' }],
			})
		).rejects.toThrow(/not accessible/i);
		expect(await contactsOf(t, theirs)).toEqual([]);
	});
});

describe('mail/contacts.autocomplete over an imported book', () => {
	it('finds a row outside the recent window by address and by name', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'owner-user' });
		await t.run(async (ctx) => {
			// Every row carries a name: convex-test's search fake throws on a row
			// without the searched field, which real Convex leaves out of the index.
			for (let n = 0; n < 205; n++) {
				await ctx.db.insert('mailContacts', {
					mailboxId,
					email: `recent${n}@example.com`,
					displayName: `Recent ${n}`,
					useCount: 1,
					lastUsedAt: 1_000 + n,
					createdAt: 1,
				});
			}
			await ctx.db.insert('mailContacts', {
				mailboxId,
				email: 'smile@clinic.example',
				displayName: 'Dentist Molar',
				useCount: 0,
				lastUsedAt: 0,
				importedAt: 0,
				createdAt: 0,
			});
		});

		const byEmail = await t.query(api.mail.contacts.autocomplete, { mailboxId, prefix: 'smi' });
		expect(byEmail.map((row) => row.email)).toEqual(['smile@clinic.example']);
		const byName = await t.query(api.mail.contacts.autocomplete, {
			mailboxId,
			prefix: 'Dentist',
		});
		expect(byName.map((row) => row.email)).toEqual(['smile@clinic.example']);
	});
});

describe('mail/contactsVcard.exportPage', () => {
	it('pages through the whole book in export shape, and refuses another member’s', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'owner-user' });
		await t.run(async (ctx) => {
			for (let n = 0; n < 501; n++) {
				await ctx.db.insert('mailContacts', {
					mailboxId,
					email: `p${String(n).padStart(3, '0')}@example.com`,
					phones: [{ value: '+1 555 0100' }],
					useCount: 1,
					lastUsedAt: n,
					createdAt: n,
				});
			}
		});

		const rows: Array<Record<string, unknown>> = [];
		let cursor: string | null = null;
		let pages = 0;
		for (;;) {
			const result: FunctionReturnType<typeof api.mail.contactsVcard.exportPage> = await t.query(
				api.mail.contactsVcard.exportPage,
				{
					mailboxId,
					paginationOpts: { cursor, numItems: 10_000 },
				}
			);
			rows.push(...result.page);
			pages++;
			if (result.isDone) break;
			cursor = result.continueCursor;
		}
		expect(rows).toHaveLength(501);
		expect(pages).toBe(2);
		expect(rows[0]).toEqual({
			email: 'p000@example.com',
			displayName: undefined,
			organization: undefined,
			phones: [{ value: '+1 555 0100' }],
			postalAddresses: undefined,
		});

		const theirs = await seedMailbox(t, { userId: 'someone-else' });
		await expect(
			t.query(api.mail.contactsVcard.exportPage, {
				mailboxId: theirs,
				paginationOpts: { cursor: null, numItems: 10 },
			})
		).rejects.toThrow(/not accessible/i);
	});
});
