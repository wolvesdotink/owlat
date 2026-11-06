/**
 * CardDAV sync into the Postbox address book (`mail/contactsCardDav*.ts`)
 * against an in-memory server behind the SSRF guard's fetch: connecting finds
 * the book through the principal, the first sync creates rows and merges into
 * rows the mail built, a changed etag replaces the synced copy, a removed card
 * takes its row out, and disconnecting removes only the rows the sync added.
 */
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api, internal } from '../../_generated/api';
import type * as SsrfGuard from '../../lib/ssrfGuard';
import type * as ContactsMerge from '../contactsMerge';
import { modules, seedMailbox } from './helpers.testlib';

const sessionMock = vi.hoisted(() => ({ userId: 'owner-user' }));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = async () => ({ userId: sessionMock.userId, role: 'editor' as const });
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

/** The book the fake server holds, and every request it answered. */
const server = vi.hoisted(() => ({
	cards: new Map<string, { etag: string; vcard: string; version: number }>(),
	removed: new Map<string, number>(),
	version: 0,
	hasSyncReport: true,
	requests: [] as Array<{ method: string; url: string; authorization: string | null }>,
	/** Holds the next multiget answer, already read, until the test releases it. */
	gate: null as null | { reached: () => void; release: Promise<void> },
}));

/** Every row each `_applyChanges` transaction took out of the book, by transaction. */
const detachesByTransaction = vi.hoisted(() => new Map<object, number>());

vi.mock('../contactsMerge', async () => {
	const actual = await vi.importActual<typeof ContactsMerge>('../contactsMerge');
	return {
		...actual,
		detachSyncedRow: vi.fn(
			async (ctx: object, row: Parameters<typeof actual.detachSyncedRow>[1]) => {
				detachesByTransaction.set(ctx, (detachesByTransaction.get(ctx) ?? 0) + 1);
				return actual.detachSyncedRow(ctx as Parameters<typeof actual.detachSyncedRow>[0], row);
			}
		),
	};
});

vi.mock('../../lib/ssrfGuard', async () => {
	const actual = await vi.importActual<typeof SsrfGuard>('../../lib/ssrfGuard');
	return { ...actual, fetchGuarded: vi.fn(fakeDav) };
});

const ORIGIN = 'https://dav.example.com';
const BOOK = '/books/me/contacts/';
const PASSWORD = 'app-password';

function multistatus(responses: string[], syncToken?: string): Response {
	const token = syncToken ? `<d:sync-token>${syncToken}</d:sync-token>` : '';
	return new Response(
		`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">${responses.join('')}${token}</d:multistatus>`,
		{ status: 207 }
	);
}

function ok(href: string, props: string): string {
	return `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');

async function fakeDav(url: string, init: RequestInit = {}): Promise<Response> {
	const method = init.method ?? 'GET';
	const headers = new Headers(init.headers);
	server.requests.push({ method, url, authorization: headers.get('authorization') });
	const path = new URL(url).pathname;
	const body = String(init.body ?? '');
	if (path === '/.well-known/carddav') return new Response('', { status: 404 });
	if (headers.get('authorization') !== `Basic ${btoa(`me:${PASSWORD}`)}`) {
		return new Response('', { status: 401 });
	}
	if (method === 'PROPFIND' && path === '/') {
		return multistatus([
			ok(
				'/',
				'<d:current-user-principal><d:href>/principals/me/</d:href></d:current-user-principal>'
			),
		]);
	}
	if (method === 'PROPFIND' && path === '/principals/me/') {
		return multistatus([
			ok(
				'/principals/me/',
				'<card:addressbook-home-set><d:href>/books/me/</d:href></card:addressbook-home-set>'
			),
		]);
	}
	if (method === 'PROPFIND' && path === '/books/me/') {
		return multistatus([
			ok('/books/me/', '<d:resourcetype><d:collection/></d:resourcetype>'),
			ok(
				BOOK,
				'<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype><d:displayname>Contacts</d:displayname>'
			),
		]);
	}
	if (method === 'PROPFIND' && path === BOOK && headers.get('depth') === '0') {
		return multistatus([
			ok(
				BOOK,
				`<cs:getctag xmlns:cs="http://calendarserver.org/ns/">v${server.version}</cs:getctag>`
			),
		]);
	}
	if (method === 'PROPFIND' && path === BOOK) {
		return multistatus([
			ok(BOOK, '<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>'),
			...[...server.cards].map(([href, card]) => ok(href, `<d:getetag>${card.etag}</d:getetag>`)),
		]);
	}
	if (method === 'REPORT' && body.includes('sync-collection')) {
		if (!server.hasSyncReport) return new Response('', { status: 501 });
		const since = Number(/<d:sync-token>tok-(\d+)<\/d:sync-token>/.exec(body)?.[1] ?? -1);
		const changed = [...server.cards].filter(([, card]) => card.version > since);
		const gone = since < 0 ? [] : [...server.removed].filter(([, version]) => version > since);
		return multistatus(
			[
				...changed.map(([href, card]) => ok(href, `<d:getetag>${card.etag}</d:getetag>`)),
				...gone.map(
					([href]) =>
						`<d:response><d:href>${href}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`
				),
			],
			`tok-${server.version}`
		);
	}
	if (method === 'REPORT' && body.includes('addressbook-multiget')) {
		const hrefs = [...body.matchAll(/<d:href>([^<]+)<\/d:href>/g)].map((m) => m[1]!);
		const answer = multistatus(
			hrefs.flatMap((href) => {
				const card = server.cards.get(href);
				return card
					? [
							ok(
								href,
								`<d:getetag>${card.etag}</d:getetag><card:address-data>${escapeXml(card.vcard)}</card:address-data>`
							),
						]
					: [];
			})
		);
		const gate = server.gate;
		if (gate) {
			server.gate = null;
			gate.reached();
			await gate.release;
		}
		return answer;
	}
	return new Response('', { status: 404 });
}

function putCard(name: string, lines: string[]): void {
	server.version++;
	server.cards.set(`${BOOK}${name}.vcf`, {
		etag: `"${name}-${server.version}"`,
		vcard: ['BEGIN:VCARD', 'VERSION:3.0', ...lines, 'END:VCARD', ''].join('\r\n'),
		version: server.version,
	});
	server.removed.delete(`${BOOK}${name}.vcf`);
}

function deleteCard(name: string): void {
	server.version++;
	server.cards.delete(`${BOOK}${name}.vcf`);
	server.removed.set(`${BOOK}${name}.vcf`, server.version);
}

type T = TestConvex<typeof schema>;

async function contactsOf(t: T, mailboxId: Id<'mailboxes'>) {
	const rows = await t.run(async (ctx) =>
		ctx.db
			.query('mailContacts')
			.withIndex('by_mailbox_and_email', (q) => q.eq('mailboxId', mailboxId))
			.collect()
	);
	return new Map(rows.map((row) => [row.email, row]));
}

async function accountOf(t: T, mailboxId: Id<'mailboxes'>) {
	return t.run(async (ctx) =>
		ctx.db
			.query('mailCardDavAccounts')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
			.first()
	);
}

async function connect(t: T, mailboxId: Id<'mailboxes'>) {
	const result = await t.action(api.mail.contactsCardDavActions.connect, {
		mailboxId,
		serverUrl: 'dav.example.com',
		username: 'me',
		password: PASSWORD,
	});
	await t.finishAllScheduledFunctions(vi.runAllTimers);
	return result;
}

async function sync(t: T, mailboxId: Id<'mailboxes'>) {
	const account = await accountOf(t, mailboxId);
	await t.action(internal.mail.contactsCardDavActions._sync, { accountId: account!._id });
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv('INSTANCE_SECRET', 'carddav-test-instance-secret-0123456789abcdef');
	server.cards.clear();
	server.removed.clear();
	server.version = 0;
	server.hasSyncReport = true;
	server.requests.length = 0;
	server.gate = null;
	detachesByTransaction.clear();
});

/** Hold the next multiget answer; `reached` resolves once a sync is waiting on it. */
function holdNextMultiget(): { reached: Promise<void>; release: () => void } {
	let release!: () => void;
	let reached!: () => void;
	const isReached = new Promise<void>((resolve) => (reached = resolve));
	server.gate = { reached, release: new Promise<void>((resolve) => (release = resolve)) };
	return { reached: isReached, release };
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe('CardDAV address-book sync', () => {
	it('connects through the principal and seals the password', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'owner-user' });

		expect(await connect(t, mailboxId)).toEqual({ ok: true });

		const account = await accountOf(t, mailboxId);
		expect(account).toMatchObject({
			serverUrl: `${ORIGIN}/`,
			addressBookUrl: `${ORIGIN}${BOOK}`,
			addressBookName: 'Contacts',
			username: 'me',
			status: 'ok',
		});
		expect(JSON.stringify(account)).not.toContain(PASSWORD);
		const state = await t.query(api.mail.contactsCardDav.getForMailbox, { mailboxId });
		expect(state).toMatchObject({ addressBookName: 'Contacts', status: 'ok' });
		expect(JSON.stringify(state)).not.toContain('secret');
		// Every request went to the server's own origin.
		expect(server.requests.every((request) => request.url.startsWith(ORIGIN))).toBe(true);
	});

	it('reports refused credentials without storing an account', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'owner-user' });

		const result = await t.action(api.mail.contactsCardDavActions.connect, {
			mailboxId,
			serverUrl: 'https://dav.example.com/',
			username: 'me',
			password: 'wrong',
		});

		expect(result).toEqual({ ok: false, reason: 'auth' });
		expect(await accountOf(t, mailboxId)).toBeNull();
	});

	it('creates rows, merges into rows the mail built, follows etag changes and removals', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'owner-user' });
		await t.run(async (ctx) => {
			await ctx.db.insert('mailContacts', {
				mailboxId,
				email: 'grace@example.com',
				displayName: 'Grace (from mail)',
				useCount: 4,
				lastUsedAt: 1,
				createdAt: 1,
			});
		});
		putCard('ada', ['FN:Ada Lovelace', 'EMAIL:ada@example.com', 'TEL;TYPE=CELL:+44 20 7946 0000']);
		putCard('grace', ['FN:Grace Hopper', 'EMAIL:grace@example.com', 'ORG:Navy']);
		putCard('linus', ['FN:Linus', 'EMAIL:linus@example.org']);

		await connect(t, mailboxId);

		let book = await contactsOf(t, mailboxId);
		expect(book.get('ada@example.com')).toMatchObject({
			displayName: 'Ada Lovelace',
			phones: [{ value: '+44 20 7946 0000', type: 'cell' }],
			useCount: 0,
			cardDavSource: { href: `${ORIGIN}${BOOK}ada.vcf`, isRowCreatedBySync: true },
		});
		// The mail's row keeps its name and use count and gains what it lacked.
		expect(book.get('grace@example.com')).toMatchObject({
			displayName: 'Grace (from mail)',
			organization: 'Navy',
			useCount: 4,
			cardDavSource: { isRowCreatedBySync: false },
		});

		putCard('ada', ['FN:Ada King', 'EMAIL:ada@example.com']);
		deleteCard('linus');
		deleteCard('grace');
		const requestsBefore = server.requests.length;
		await sync(t, mailboxId);

		book = await contactsOf(t, mailboxId);
		// A new etag replaces the synced copy, details the card dropped included.
		expect(book.get('ada@example.com')!.displayName).toBe('Ada King');
		expect(book.get('ada@example.com')!.phones).toBeUndefined();
		expect(book.get('ada@example.com')!.cardDavSource!.etag).toBe(
			server.cards.get(`${BOOK}ada.vcf`)!.etag
		);
		// A removed card takes the row it created out, and only unlinks the mail's row.
		expect(book.has('linus@example.org')).toBe(false);
		expect(book.get('grace@example.com')!.displayName).toBe('Grace (from mail)');
		expect(book.get('grace@example.com')!.cardDavSource).toBeUndefined();
		// The second sync asked for the changes only: one sync report, one multiget of one card.
		const later = server.requests.slice(requestsBefore);
		expect(later.map((request) => request.method)).toEqual(['REPORT', 'REPORT']);
	});

	it('syncs from an etag listing when the server has no sync report', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'owner-user' });
		server.hasSyncReport = false;
		putCard('ada', ['FN:Ada', 'EMAIL:ada@example.com']);
		putCard('linus', ['FN:Linus', 'EMAIL:linus@example.org']);

		await connect(t, mailboxId);
		expect([...(await contactsOf(t, mailboxId)).keys()].sort()).toEqual([
			'ada@example.com',
			'linus@example.org',
		]);

		putCard('ada', ['FN:Ada King', 'EMAIL:ada@example.com']);
		deleteCard('linus');
		await sync(t, mailboxId);

		const book = await contactsOf(t, mailboxId);
		expect([...book.keys()]).toEqual(['ada@example.com']);
		expect(book.get('ada@example.com')!.displayName).toBe('Ada King');
	});

	it('stores a card picture and deletes it with the card', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'owner-user' });
		const jpeg = new Uint8Array(64);
		jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
		putCard('ada', [
			'FN:Ada',
			'EMAIL:ada@example.com',
			`PHOTO;ENCODING=b;TYPE=JPEG:${Buffer.from(jpeg).toString('base64')}`,
		]);

		await connect(t, mailboxId);
		const photoId = (await contactsOf(t, mailboxId)).get('ada@example.com')!.photoStorageId;
		expect(photoId).toBeDefined();
		const stored = await t.run(async (ctx) => (await ctx.storage.get(photoId!))?.type);
		expect(stored).toBe('image/jpeg');

		deleteCard('ada');
		await sync(t, mailboxId);

		expect((await contactsOf(t, mailboxId)).size).toBe(0);
		expect(await t.run(async (ctx) => (await ctx.storage.get(photoId!)) !== null)).toBe(false);
	});

	it('disconnecting removes the account and only the rows the sync created', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'owner-user' });
		await t.run(async (ctx) => {
			await ctx.db.insert('mailContacts', {
				mailboxId,
				email: 'grace@example.com',
				useCount: 2,
				lastUsedAt: 1,
				createdAt: 1,
			});
		});
		putCard('ada', ['FN:Ada', 'EMAIL:ada@example.com']);
		putCard('grace', ['FN:Grace Hopper', 'EMAIL:grace@example.com']);
		await connect(t, mailboxId);

		await t.mutation(api.mail.contactsCardDav.disconnect, { mailboxId });
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		expect(await accountOf(t, mailboxId)).toBeNull();
		const book = await contactsOf(t, mailboxId);
		expect([...book.keys()]).toEqual(['grace@example.com']);
		expect(book.get('grace@example.com')!.displayName).toBe('Grace Hopper');
		expect(book.get('grace@example.com')!.cardDavSource).toBeUndefined();
	});

	it('keeps a name the person edited when the card changes later', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'owner-user' });
		putCard('ada', ['FN:Ada Lovelace', 'EMAIL:ada@example.com', 'ORG:Analytical']);
		await connect(t, mailboxId);

		await t.mutation(api.mail.contacts.upsert, {
			mailboxId,
			email: 'ada@example.com',
			displayName: 'Ada (mine)',
		});
		putCard('ada', [
			'FN:Ada King',
			'EMAIL:ada@example.com',
			'ORG:Babbage',
			'TEL;TYPE=CELL:+44 20 7946 0000',
		]);
		await sync(t, mailboxId);

		const ada = (await contactsOf(t, mailboxId)).get('ada@example.com')!;
		expect(ada.displayName).toBe('Ada (mine)');
		expect(ada.organization).toBe('Analytical');
		// What the person did not edit still follows the card.
		expect(ada.phones).toEqual([{ value: '+44 20 7946 0000', type: 'cell' }]);
		expect(ada.cardDavSource!.etag).toBe(server.cards.get(`${BOOK}ada.vcf`)!.etag);
	});

	it('resumes following the card after the person edited it', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'owner-user' });
		putCard('ada', ['FN:Ada Lovelace', 'EMAIL:ada@example.com', 'ORG:Analytical']);
		await connect(t, mailboxId);
		await t.mutation(api.mail.contacts.upsert, {
			mailboxId,
			email: 'ada@example.com',
			displayName: 'Ada (mine)',
		});
		const edited = (await contactsOf(t, mailboxId)).get('ada@example.com')!;
		expect(edited.cardDavSource).toMatchObject({ isRowCreatedBySync: false });
		expect(edited.cardDavSource!.editedAt).toEqual(expect.any(Number));

		const result = await t.mutation(api.mail.contactsCardDav.resumeCardDavUpdates, {
			contactId: edited._id,
		});
		expect(result).toEqual({ isSyncScheduled: true });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		// The card did not change, yet the sync fetched it and put the server's name back.
		const resumed = (await contactsOf(t, mailboxId)).get('ada@example.com')!;
		expect(resumed.displayName).toBe('Ada Lovelace');
		expect(resumed.cardDavSource).toEqual({
			accountId: edited.cardDavSource!.accountId,
			href: edited.cardDavSource!.href,
			etag: server.cards.get(`${BOOK}ada.vcf`)!.etag,
			isRowCreatedBySync: true,
		});

		putCard('ada', ['FN:Ada King', 'EMAIL:ada@example.com', 'ORG:Babbage']);
		await sync(t, mailboxId);
		const ada = (await contactsOf(t, mailboxId)).get('ada@example.com')!;
		expect(ada.displayName).toBe('Ada King');
		expect(ada.organization).toBe('Babbage');
	});

	it('refuses to resume CardDAV updates of a row no card is linked to', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'owner-user' });
		const contactId = await t.mutation(api.mail.contacts.upsert, {
			mailboxId,
			email: 'grace@example.com',
			displayName: 'Grace',
		});

		await expect(
			t.mutation(api.mail.contactsCardDav.resumeCardDavUpdates, { contactId })
		).rejects.toThrow(/not linked/);
		expect((await contactsOf(t, mailboxId)).get('grace@example.com')!.cardDavSource).toBe(
			undefined
		);
	});

	it('runs one sync of an account at a time', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'owner-user' });
		putCard('ada', ['FN:Ada', 'EMAIL:ada@example.com']);
		await connect(t, mailboxId);

		putCard('ada', ['FN:Ada King', 'EMAIL:ada@example.com']);
		const held = holdNextMultiget();
		const first = sync(t, mailboxId);
		await held.reached;
		const requestsBefore = server.requests.length;
		await sync(t, mailboxId);
		// The second sync found the first one running and asked the server nothing.
		expect(server.requests.length).toBe(requestsBefore);

		held.release();
		await first;
		expect((await contactsOf(t, mailboxId)).get('ada@example.com')!.displayName).toBe('Ada King');
		expect(await accountOf(t, mailboxId)).toMatchObject({
			status: 'ok',
			syncToken: `tok-${server.version}`,
		});
	});

	it('drops the work of a sync whose claim expired, so a removed contact stays removed', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'owner-user' });
		putCard('ada', ['FN:Ada', 'EMAIL:ada@example.com']);
		putCard('linus', ['FN:Linus', 'EMAIL:linus@example.org']);
		await connect(t, mailboxId);

		putCard('linus', ['FN:Linus Torvalds', 'EMAIL:linus@example.org']);
		const held = holdNextMultiget();
		const stale = sync(t, mailboxId);
		await held.reached;
		// The first sync stalls past its claim; a later one reads the removal.
		vi.setSystemTime(Date.now() + 60 * 60 * 1000);
		deleteCard('linus');
		await sync(t, mailboxId);
		expect((await contactsOf(t, mailboxId)).has('linus@example.org')).toBe(false);

		held.release();
		await stale;
		expect((await contactsOf(t, mailboxId)).has('linus@example.org')).toBe(false);
		expect((await accountOf(t, mailboxId))!.syncToken).toBe(`tok-${server.version}`);
	});

	it('takes a large removal out in bounded transactions', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'owner-user' });
		await connect(t, mailboxId);
		const account = (await accountOf(t, mailboxId))!;
		// 120 cards of ten addresses each, all gone from the server; no sync token,
		// so the next sync reads the full listing.
		await t.run(async (ctx) => {
			await ctx.db.patch(account._id, { syncToken: undefined });
			for (let card = 0; card < 120; card++) {
				for (let n = 0; n < 10; n++) {
					await ctx.db.insert('mailContacts', {
						mailboxId,
						email: `person${card}-${n}@example.org`,
						useCount: 0,
						lastUsedAt: 1,
						createdAt: 1,
						cardDavSource: {
							accountId: account._id,
							href: `${ORIGIN}${BOOK}card${card}.vcf`,
							etag: '"1"',
							isRowCreatedBySync: true,
						},
					});
				}
			}
		});

		await sync(t, mailboxId);

		expect((await contactsOf(t, mailboxId)).size).toBe(0);
		const perTransaction = [...detachesByTransaction.values()];
		expect(perTransaction.reduce((sum, rows) => sum + rows, 0)).toBe(1_200);
		expect(perTransaction.length).toBeGreaterThan(1);
		// The cap on rows one removal transaction takes (REMOVED_CARDS_PER_COMMIT cards).
		expect(Math.max(...perTransaction)).toBeLessThanOrEqual(500);
	});

	it('refuses another member’s mailbox before contacting the server', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'someone-else' });

		const result = await t.action(api.mail.contactsCardDavActions.connect, {
			mailboxId,
			serverUrl: 'https://dav.example.com/',
			username: 'me',
			password: PASSWORD,
		});

		expect(result).toEqual({ ok: false, reason: 'forbidden' });
		expect(server.requests).toHaveLength(0);
	});
});
