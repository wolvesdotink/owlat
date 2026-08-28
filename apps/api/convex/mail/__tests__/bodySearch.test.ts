/**
 * Deep body search (idea 32) — the widened plaintext carve-out end to end.
 *
 * The properties worth pinning are the ones a "just index more text" change
 * gets wrong:
 *   - OFF is byte-identical to the old behaviour: no excerpt is written, and
 *     search still reads the 200-character snippet.
 *   - Turning it ON does not make search WORSE in the window before the
 *     backfill finishes — a half-walked mailbox keeps reading `snippet`.
 *   - Once the walk completes, a phrase past character 200 is findable.
 *   - Turning it OFF again REMOVES the plaintext rather than merely halting,
 *     and retires the completeness flag so a later re-enable cannot read an
 *     emptied index.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api, internal } from '../../_generated/api';
import { buildSearchBody, SEARCH_BODY_MAX_CHARS } from '../searchBody';
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
		// `workspaces/settings.update` (the instance switch) gates on
		// `settings:manage`; the tests here always drive it as the owner.
		requireOrgPermission: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
			activeOrganizationId: 'org-1',
		})),
		getUserIdFromSession: vi.fn(async () => sessionMocks.userId),
	};
});

beforeEach(() => {
	sessionMocks.userId = 'user-A';
	sessionMocks.role = 'owner';
});

/** The walk reschedules itself, so the fake clock has to span the whole drain. */
async function drainScheduler(t: TestConvex<typeof schema>): Promise<void> {
	vi.useFakeTimers();
	try {
		await t.finishAllScheduledFunctions(vi.runAllTimers);
	} finally {
		vi.useRealTimers();
	}
}

async function setIndexing(t: TestConvex<typeof schema>, enabled: boolean): Promise<void> {
	await t.mutation(api.workspaces.settings.update, { isBodySearchIndexingEnabled: enabled });
}

async function excerptOf(
	t: TestConvex<typeof schema>,
	messageId: Id<'mailMessages'>
): Promise<string | undefined> {
	let value: string | undefined;
	await t.run(async (ctx) => {
		value = (await ctx.db.get(messageId))?.searchBody;
	});
	return value;
}

/** A body whose interesting phrase sits well past the 200-char snippet ceiling. */
const DEEP_BODY = `${'filler words about renewal terms. '.repeat(20)}late delivery triggers the penaltyclause in section 8.2, capped at ten percent.`;

describe('buildSearchBody', () => {
	it('prefers the text part and collapses whitespace', () => {
		expect(buildSearchBody('  hello\n\n   world  ', '<p>ignored</p>')).toBe('hello world');
	});

	it('falls through to the HTML when the text part is blank, unlike the snippet builder', () => {
		// An html-only newsletter is exactly the mail whose depth this field
		// exists to reach; an empty excerpt would make it permanently unfindable.
		expect(buildSearchBody('   ', '<p>quarterly <b>report</b></p>')).toBe('quarterly report');
		expect(buildSearchBody(undefined, '<p>quarterly report</p>')).toBe('quarterly report');
	});

	it('drops script/style content and resolves the entities that change tokens', () => {
		expect(buildSearchBody(undefined, '<style>p{color:red}</style><p>AT&amp;T invoice</p>')).toBe(
			'AT&T invoice'
		);
		expect(buildSearchBody(undefined, '<script>var x = "secret"</script><p>hi</p>')).toBe('hi');
	});

	it('caps the excerpt and backs up to a word boundary', () => {
		const long = 'alpha bravo '.repeat(2000);
		const excerpt = buildSearchBody(long, undefined);
		expect(excerpt.length).toBeLessThanOrEqual(SEARCH_BODY_MAX_CHARS);
		expect(excerpt.endsWith('alpha') || excerpt.endsWith('bravo')).toBe(true);
	});

	it('keeps a hard cut when the body has no word boundary to back up to', () => {
		const blob = 'x'.repeat(SEARCH_BODY_MAX_CHARS + 100);
		expect(buildSearchBody(blob, undefined)).toHaveLength(SEARCH_BODY_MAX_CHARS);
	});

	it('returns empty for a body that is only markup', () => {
		expect(buildSearchBody(undefined, '<br/><br/>')).toBe('');
		expect(buildSearchBody(undefined, undefined)).toBe('');
	});
});

describe('delivery — the excerpt is written only when the instance opted in', () => {
	async function deliver(t: TestConvex<typeof schema>): Promise<Id<'mailMessages'>> {
		const mailboxId = await seedMailbox(t, { address: 'me@hinterland.camp' });
		await seedFolder(t, mailboxId);
		await seedFolder(t, mailboxId, 'spam');
		let rawStorageId!: Id<'_storage'>;
		await t.run(async (ctx) => {
			rawStorageId = await ctx.storage.store(new Blob(['raw']));
		});
		const result = await t.mutation(internal.mail.delivery.deliverToMailbox, {
			rawStorageId,
			rawSize: 3,
			recipientAddress: 'me@hinterland.camp',
			from: 'ines@brightpath.example',
			to: ['me@hinterland.camp'],
			cc: [],
			bcc: [],
			subject: 'Renewal terms, redlined',
			textBodyInline: DEEP_BODY,
			snippet: DEEP_BODY.slice(0, 200),
			searchBody: buildSearchBody(DEEP_BODY, undefined),
			messageId: '<deep-1@brightpath.example>',
			receivedAt: Date.now(),
			attachments: [],
			spamVerdict: 'ham' as const,
		});
		if (!('messageId' in result)) throw new Error('delivery was skipped');
		return result.messageId;
	}

	it('leaves the column absent while the switch is off (today’s row, unchanged)', async () => {
		const t = convexTest(schema, modules);
		const messageId = await deliver(t);
		expect(await excerptOf(t, messageId)).toBeUndefined();
	});

	it('writes the excerpt once the switch is on', async () => {
		const t = convexTest(schema, modules);
		await setIndexing(t, true);
		const messageId = await deliver(t);
		expect(await excerptOf(t, messageId)).toContain('penaltyclause in section 8.2');
	});
});

describe('mail.bodySearchBackfill', () => {
	it('refuses to start while the instance switch is off', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		await expect(t.mutation(api.mail.bodySearchBackfill.start, { mailboxId })).rejects.toThrow();
	});

	it('refuses a non-owner', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'user-A' });
		await setIndexing(t, true);
		sessionMocks.userId = 'user-B';
		sessionMocks.role = 'editor';
		await expect(t.mutation(api.mail.bodySearchBackfill.start, { mailboxId })).rejects.toThrow();
		expect(await t.query(api.mail.bodySearchBackfill.status, { mailboxId })).toBeNull();
	});

	it('walks existing mail, reports completion, and is idempotent on re-run', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		const messageId = await seedMessage(t, mailboxId, {
			subject: 'Renewal terms',
			snippet: DEEP_BODY.slice(0, 200),
			textBodyInline: DEEP_BODY,
		});

		await setIndexing(t, true);
		expect(await excerptOf(t, messageId)).toBeUndefined();

		await t.mutation(api.mail.bodySearchBackfill.start, { mailboxId });
		await drainScheduler(t);

		expect(await excerptOf(t, messageId)).toContain('penaltyclause in section 8.2');
		const job = await t.query(api.mail.bodySearchBackfill.status, { mailboxId });
		expect(job?.status).toBe('completed');
		expect(job?.mode).toBe('index');
		expect(job?.scannedCount).toBe(1);
		expect(job?.indexedCount).toBe(1);

		// A re-run scans the row again but writes nothing: the excerpt is already there.
		await t.mutation(api.mail.bodySearchBackfill.start, { mailboxId });
		await drainScheduler(t);
		const rerun = await t.query(api.mail.bodySearchBackfill.status, { mailboxId });
		expect(rerun?.scannedCount).toBe(1);
		expect(rerun?.indexedCount).toBe(0);
	});

	it('falls back to the snippet for a message with no readable body', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		const messageId = await seedMessage(t, mailboxId, {
			subject: 'attachment only',
			snippet: 'see attached',
		});

		await setIndexing(t, true);
		await t.mutation(api.mail.bodySearchBackfill.start, { mailboxId });
		await drainScheduler(t);

		// Never LESS findable than before the feature existed.
		expect(await excerptOf(t, messageId)).toBe('see attached');
	});
});

describe('search — which index the free-text branch reads', () => {
	async function seedDeepMailbox(t: TestConvex<typeof schema>): Promise<Id<'mailboxes'>> {
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		await seedMessage(t, mailboxId, {
			subject: 'Renewal terms',
			snippet: DEEP_BODY.slice(0, 200),
			textBodyInline: DEEP_BODY,
		});
		return mailboxId;
	}

	it('finds nothing past character 200 while the switch is off', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedDeepMailbox(t);
		const result = await t.query(api.mail.mailbox.search.search, {
			mailboxId,
			text: 'penaltyclause',
		});
		expect(result.messages).toHaveLength(0);
	});

	it('keeps reading the snippet until the backfill completes', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedDeepMailbox(t);
		await setIndexing(t, true);
		// Switch on, walk NOT run: the body index holds nothing for this mailbox,
		// so reading it would return less than the snippet index did.
		const deep = await t.query(api.mail.mailbox.search.search, {
			mailboxId,
			text: 'penaltyclause',
		});
		expect(deep.messages).toHaveLength(0);
		const shallow = await t.query(api.mail.mailbox.search.search, {
			mailboxId,
			text: 'renewal',
		});
		expect(shallow.messages).toHaveLength(1);
	});

	it('finds the deep phrase once the backfill has completed', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedDeepMailbox(t);
		await setIndexing(t, true);
		await t.mutation(api.mail.bodySearchBackfill.start, { mailboxId });
		await drainScheduler(t);

		const result = await t.query(api.mail.mailbox.search.search, {
			mailboxId,
			text: 'penaltyclause',
		});
		expect(result.messages.map((m) => m.subject)).toEqual(['Renewal terms']);
	});
});

describe('turning the switch off', () => {
	it('clears the stored excerpts and retires the completeness flag', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		const messageId = await seedMessage(t, mailboxId, {
			subject: 'Renewal terms',
			snippet: DEEP_BODY.slice(0, 200),
			textBodyInline: DEEP_BODY,
		});
		await setIndexing(t, true);
		await t.mutation(api.mail.bodySearchBackfill.start, { mailboxId });
		await drainScheduler(t);
		expect(await excerptOf(t, messageId)).toBeTruthy();

		await setIndexing(t, false);
		await drainScheduler(t);

		// The opt-out REMOVES the widened plaintext, it does not merely stop adding.
		expect(await excerptOf(t, messageId)).toBeUndefined();
		const job = await t.query(api.mail.bodySearchBackfill.status, { mailboxId });
		expect(job?.mode).toBe('purge');
		expect(job?.status).toBe('completed');

		// And a later re-enable cannot read the emptied index on the strength of
		// the old completed job.
		await setIndexing(t, true);
		const result = await t.query(api.mail.mailbox.search.search, {
			mailboxId,
			text: 'renewal',
		});
		expect(result.messages.map((m) => m.subject)).toEqual(['Renewal terms']);
	});

	it('does not sweep when the setting was already off', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		const messageId = await seedMessage(t, mailboxId, {
			subject: 'kept',
			searchBody: 'an excerpt an earlier run left behind',
		});
		// A save that merely re-states `false` is not a true→false transition.
		await setIndexing(t, false);
		await drainScheduler(t);
		expect(await excerptOf(t, messageId)).toBe('an excerpt an earlier run left behind');
	});
});
