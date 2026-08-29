/**
 * Attachment share links (idea 10) — the backend rules.
 *
 * The properties worth a test are the ones about NOT serving: a revoked link is
 * dead the instant it is revoked, an expired one stops on its own without
 * anybody pressing anything, a link narrowed to the mailbox is dead to the
 * public route, and none of the four refusals is distinguishable from the
 * others. Plus the two that make the feature honest at all — the bytes really
 * are deleted, and the detach hands blob ownership to the share instead of
 * dropping it on the floor.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api, internal } from '../../_generated/api';
import { ATTACHMENT_SHARE_EXPIRY_DAY_CHOICES } from '@owlat/shared/attachmentShares';
import { mailShareLinkExpiryDaysValidator } from '../../lib/mailSettingsValidators';
import { modules, seedMailbox } from './helpers.testlib';

const sessionMocks = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'owner' as 'owner' | 'admin' | 'editor' | 'member',
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

const DAY = 24 * 60 * 60 * 1_000;
const TOKEN = 'sharetoken0123456789abcdefghijkl'; // 32 chars, URL alphabet

/** Store real bytes and hang them off a draft as a committed attachment. */
async function seedDraftWithAttachment(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	opts: { filename?: string; isInline?: boolean } = {}
): Promise<{ draftId: Id<'mailDrafts'>; storageId: Id<'_storage'> }> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const storageId = await ctx.storage.store(new Blob([new Uint8Array([1, 2, 3, 4])]));
		const draftId = await ctx.db.insert('mailDrafts', {
			mailboxId,
			toAddresses: ['b@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			fromAddress: 'a@hinterland.camp',
			subject: 'Here is the file',
			bodyHtml: '<p>hi</p>',
			attachments: [
				{
					storageId,
					filename: opts.filename ?? 'huge.zip',
					contentType: 'application/zip',
					size: 4,
					isInline: opts.isInline ?? false,
				},
			],
			state: 'draft',
			lastEditedAt: now,
			createdAt: now,
		});
		return { draftId, storageId };
	});
}

/** Run the whole create path except the scan (which needs an action + fetch). */
async function createShare(
	t: TestConvex<typeof schema>,
	draftId: Id<'mailDrafts'>,
	storageId: Id<'_storage'>,
	overrides: { token?: string; expiryDays?: number } = {}
) {
	return await t.mutation(internal.mail.attachmentShares.createShare, {
		draftId,
		storageId,
		token: overrides.token ?? TOKEN,
		expiryDays: overrides.expiryDays ?? 14,
		scanVerdict: 'clean',
	});
}

async function blobExists(t: TestConvex<typeof schema>, storageId: Id<'_storage'>) {
	return await t.run(async (ctx) => (await ctx.storage.get(storageId)) !== null);
}

async function shareRow(t: TestConvex<typeof schema>, shareId: Id<'mailAttachmentShares'>) {
	return await t.run(async (ctx) => await ctx.db.get(shareId));
}

describe('creating a share from a draft attachment', () => {
	it('detaches the part from the draft but keeps the bytes for the share', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const { draftId, storageId } = await seedDraftWithAttachment(t, mailboxId);

		const created = await createShare(t, draftId, storageId);

		const draft = await t.run(async (ctx) => await ctx.db.get(draftId));
		expect(draft?.attachments).toEqual([]);
		// The bytes survive the detach: `drafts.removeAttachment` would have
		// deleted them, and the whole point is that the share now owns them.
		expect(await blobExists(t, storageId)).toBe(true);
		const row = await shareRow(t, created.shareId);
		expect(row?.storageId).toBe(storageId);
		expect(row?.scope).toBe('anyone');
		expect(row?.sourceDraftId).toBe(draftId);
		expect(row?.downloadCount).toBe(0);
	});

	it('honours the requested lifetime and clamps an unsupported one', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const a = await seedDraftWithAttachment(t, mailboxId);
		const b = await seedDraftWithAttachment(t, mailboxId);

		const thirty = await createShare(t, a.draftId, a.storageId, { expiryDays: 30 });
		const bogus = await createShare(t, b.draftId, b.storageId, {
			token: 'othertoken0123456789abcdefghijkl',
			expiryDays: 3650,
		});

		expect(thirty.expiresAt - Date.now()).toBeGreaterThan(29 * DAY);
		// An out-of-range lifetime falls back to the 14-day default rather than
		// minting a link that outlives everyone's memory of it.
		expect(bogus.expiresAt - Date.now()).toBeLessThan(15 * DAY);
	});

	it('refuses an inline body image, which the rendered HTML still points at', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const { draftId, storageId } = await seedDraftWithAttachment(t, mailboxId, {
			isInline: true,
		});

		await expect(createShare(t, draftId, storageId)).rejects.toThrow();
		expect(await t.run(async (ctx) => (await ctx.db.get(draftId))?.attachments.length)).toBe(1);
	});

	it('refuses a malformed token rather than storing an unservable row', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const { draftId, storageId } = await seedDraftWithAttachment(t, mailboxId);

		await expect(createShare(t, draftId, storageId, { token: 'short' })).rejects.toThrow();
	});

	it('refuses a draft in a mailbox the caller cannot reach', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, {
			userId: 'user-B',
			address: 'b@hinterland.camp',
		});
		const { draftId, storageId } = await seedDraftWithAttachment(t, mailboxId);

		sessionMocks.userId = 'user-C';
		sessionMocks.role = 'member';
		await expect(createShare(t, draftId, storageId)).rejects.toThrow();
		expect(await t.run(async (ctx) => (await ctx.db.get(draftId))?.attachments.length)).toBe(1);
	});
});

describe('serving a token', () => {
	async function seedLiveShare(t: TestConvex<typeof schema>) {
		const mailboxId = await seedMailbox(t);
		const { draftId, storageId } = await seedDraftWithAttachment(t, mailboxId);
		const created = await createShare(t, draftId, storageId);
		return { mailboxId, storageId, shareId: created.shareId };
	}

	it('resolves a live link and counts the hit', async () => {
		const t = convexTest(schema, modules);
		const { shareId, storageId } = await seedLiveShare(t);

		const served = await t.mutation(internal.mail.attachmentShares.consumeShareToken, {
			token: TOKEN,
		});

		expect(served).toMatchObject({ storageId, filename: 'huge.zip' });
		const row = await shareRow(t, shareId);
		expect(row?.downloadCount).toBe(1);
		expect(row?.lastAccessedAt).toBeGreaterThan(0);
	});

	it('refuses a token that never existed, and a malformed one', async () => {
		const t = convexTest(schema, modules);
		await seedLiveShare(t);

		expect(
			await t.mutation(internal.mail.attachmentShares.consumeShareToken, {
				token: 'nosuchtoken0123456789abcdefghijk',
			})
		).toBeNull();
		expect(
			await t.mutation(internal.mail.attachmentShares.consumeShareToken, { token: '../../etc' })
		).toBeNull();
	});

	it('refuses a revoked link', async () => {
		const t = convexTest(schema, modules);
		const { shareId } = await seedLiveShare(t);

		await t.mutation(api.mail.attachmentShares.revoke, { shareId });

		expect(
			await t.mutation(internal.mail.attachmentShares.consumeShareToken, { token: TOKEN })
		).toBeNull();
	});

	it('refuses an expired link without anyone having to revoke it', async () => {
		const t = convexTest(schema, modules);
		const { shareId } = await seedLiveShare(t);
		await t.run(async (ctx) => {
			await ctx.db.patch(shareId, { expiresAt: Date.now() - 1 });
		});

		expect(
			await t.mutation(internal.mail.attachmentShares.consumeShareToken, { token: TOKEN })
		).toBeNull();
	});

	it('refuses a link narrowed to the mailbox, and serves it again once re-widened', async () => {
		const t = convexTest(schema, modules);
		const { shareId } = await seedLiveShare(t);

		await t.mutation(api.mail.attachmentShares.setScope, { shareId, scope: 'mailbox' });
		expect(
			await t.mutation(internal.mail.attachmentShares.consumeShareToken, { token: TOKEN })
		).toBeNull();

		await t.mutation(api.mail.attachmentShares.setScope, { shareId, scope: 'anyone' });
		expect(
			await t.mutation(internal.mail.attachmentShares.consumeShareToken, { token: TOKEN })
		).not.toBeNull();
	});

	it('does not count a refused request', async () => {
		const t = convexTest(schema, modules);
		const { shareId } = await seedLiveShare(t);
		await t.mutation(api.mail.attachmentShares.revoke, { shareId });

		await t.mutation(internal.mail.attachmentShares.consumeShareToken, { token: TOKEN });

		expect((await shareRow(t, shareId))?.downloadCount).toBe(0);
	});
});

describe('revoking', () => {
	it('deletes the bytes, not just a flag', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const { draftId, storageId } = await seedDraftWithAttachment(t, mailboxId);
		const created = await createShare(t, draftId, storageId);

		await t.mutation(api.mail.attachmentShares.revoke, { shareId: created.shareId });

		expect(await blobExists(t, storageId)).toBe(false);
		const row = await shareRow(t, created.shareId);
		expect(row?.storageId).toBeUndefined();
		expect(row?.revokedAt).toBeGreaterThan(0);
	});

	it('is idempotent, so a double-click cannot surface a failure', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const { draftId, storageId } = await seedDraftWithAttachment(t, mailboxId);
		const created = await createShare(t, draftId, storageId);

		expect(
			await t.mutation(api.mail.attachmentShares.revoke, { shareId: created.shareId })
		).toEqual({ ok: true, revoked: true });
		expect(
			await t.mutation(api.mail.attachmentShares.revoke, { shareId: created.shareId })
		).toEqual({ ok: true, revoked: false });
	});

	it('refuses a teammate who can read the mailbox but did not create the link', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { scope: 'shared' });
		const { draftId, storageId } = await seedDraftWithAttachment(t, mailboxId);
		const created = await createShare(t, draftId, storageId);

		// An org admin reaches every mailbox, but the link is user-A's promise to
		// someone outside the company.
		sessionMocks.userId = 'user-Z';
		sessionMocks.role = 'admin';
		await expect(
			t.mutation(api.mail.attachmentShares.revoke, { shareId: created.shareId })
		).rejects.toThrow();
		expect(await blobExists(t, storageId)).toBe(true);
	});

	it('will not re-widen a link whose bytes are already gone', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const { draftId, storageId } = await seedDraftWithAttachment(t, mailboxId);
		const created = await createShare(t, draftId, storageId);
		await t.mutation(api.mail.attachmentShares.revoke, { shareId: created.shareId });

		await expect(
			t.mutation(api.mail.attachmentShares.setScope, {
				shareId: created.shareId,
				scope: 'anyone',
			})
		).rejects.toThrow();
	});
});

describe('the management list', () => {
	it('shows this person their own links, live and dead, newest first', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const first = await seedDraftWithAttachment(t, mailboxId, { filename: 'old.zip' });
		const older = await createShare(t, first.draftId, first.storageId);
		await t.run(async (ctx) => {
			await ctx.db.patch(older.shareId, { createdAt: Date.now() - 5 * DAY });
		});
		const second = await seedDraftWithAttachment(t, mailboxId, { filename: 'new.zip' });
		await createShare(t, second.draftId, second.storageId, {
			token: 'secondtoken123456789abcdefghijkl',
		});
		await t.mutation(api.mail.attachmentShares.revoke, { shareId: older.shareId });

		const rows = await t.query(api.mail.attachmentShares.list, { mailboxId });

		expect(rows.map((r) => r.filename)).toEqual(['new.zip', 'old.zip']);
		expect(rows.map((r) => r.state)).toEqual(['live', 'revoked']);
		expect(rows[1]!.hasBytes).toBe(false);
	});

	it('hands out a copyable URL only while the link would actually resolve', async () => {
		vi.stubEnv('CONVEX_SITE_URL', 'https://deploy.convex.site');
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const seeded = await seedDraftWithAttachment(t, mailboxId);
		const created = await createShare(t, seeded.draftId, seeded.storageId);

		const [live] = await t.query(api.mail.attachmentShares.list, { mailboxId });
		expect(live?.publicUrl).toBe(`https://deploy.convex.site/attachment-share/${TOKEN}`);

		// Narrowing kills the public URL without touching the file.
		await t.mutation(api.mail.attachmentShares.setScope, {
			shareId: created.shareId,
			scope: 'mailbox',
		});
		const [narrowed] = await t.query(api.mail.attachmentShares.list, { mailboxId });
		expect(narrowed?.publicUrl).toBeNull();
		expect(narrowed?.hasBytes).toBe(true);
		vi.unstubAllEnvs();
	});

	it('never shows a teammate the links somebody else created', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { scope: 'shared' });
		const seeded = await seedDraftWithAttachment(t, mailboxId);
		await createShare(t, seeded.draftId, seeded.storageId);

		sessionMocks.userId = 'user-Z';
		sessionMocks.role = 'admin';
		expect(await t.query(api.mail.attachmentShares.list, { mailboxId })).toEqual([]);
	});
});

describe('the owner-side download', () => {
	it('still reaches a file whose public link was narrowed away', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const seeded = await seedDraftWithAttachment(t, mailboxId);
		const created = await createShare(t, seeded.draftId, seeded.storageId);

		// The partial revoke: the stranger loses the link, the owner does not
		// lose the file.
		await t.mutation(api.mail.attachmentShares.setScope, {
			shareId: created.shareId,
			scope: 'mailbox',
		});

		const url = await t.query(api.mail.attachmentShares.downloadUrl, {
			shareId: created.shareId,
		});
		expect(url).toBeTruthy();
	});

	it('has nothing to hand back once the bytes are reclaimed', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const seeded = await seedDraftWithAttachment(t, mailboxId);
		const created = await createShare(t, seeded.draftId, seeded.storageId);
		await t.mutation(api.mail.attachmentShares.revoke, { shareId: created.shareId });

		// The row outlives its file so the list can explain the dead link; asking
		// it for a download is normal, and the answer is "there is none".
		expect(
			await t.query(api.mail.attachmentShares.downloadUrl, { shareId: created.shareId })
		).toBeNull();
	});

	it('refuses a teammate who did not create the link', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { scope: 'shared' });
		const seeded = await seedDraftWithAttachment(t, mailboxId);
		const created = await createShare(t, seeded.draftId, seeded.storageId);

		sessionMocks.userId = 'user-Z';
		sessionMocks.role = 'admin';
		await expect(
			t.query(api.mail.attachmentShares.downloadUrl, { shareId: created.shareId })
		).rejects.toThrow();
	});
});

describe('the expiry sweep', () => {
	async function seedExpired(t: TestConvex<typeof schema>, expiresAt: number, token: string) {
		const mailboxId = await seedMailbox(t, { address: `${token}@hinterland.camp` });
		const { draftId, storageId } = await seedDraftWithAttachment(t, mailboxId);
		const created = await createShare(t, draftId, storageId, { token });
		await t.run(async (ctx) => {
			await ctx.db.patch(created.shareId, { expiresAt });
		});
		return { shareId: created.shareId, storageId };
	}

	it('reclaims the bytes of a lapsed link and leaves a live one alone', async () => {
		const t = convexTest(schema, modules);
		const dead = await seedExpired(t, Date.now() - DAY, 'deadtoken00123456789abcdefghijkl');
		const live = await seedExpired(t, Date.now() + DAY, 'livetoken00123456789abcdefghijkl');

		const result = await t.mutation(internal.mail.attachmentShareRetention.sweepExpiredShares, {});

		expect(result.released).toBe(1);
		expect(await blobExists(t, dead.storageId)).toBe(false);
		expect(await blobExists(t, live.storageId)).toBe(true);
	});

	it('keeps the record through the grace window, then deletes it', async () => {
		const t = convexTest(schema, modules);
		const { shareId } = await seedExpired(t, Date.now() - DAY, 'graced0000123456789abcdefghijkl1');

		// First pass releases the bytes; the row stays so the list can explain it.
		await t.mutation(internal.mail.attachmentShareRetention.sweepExpiredShares, {});
		expect(await shareRow(t, shareId)).not.toBeNull();
		await t.mutation(internal.mail.attachmentShareRetention.sweepExpiredShares, {});
		expect(await shareRow(t, shareId)).not.toBeNull();

		// Age it well past any grace window and sweep again. The exact window is
		// the shared module's business (and its own test's); what this asserts is
		// that the sweep eventually reclaims the record at all.
		await t.run(async (ctx) => {
			await ctx.db.patch(shareId, { expiresAt: Date.now() - 365 * DAY });
		});
		await t.mutation(internal.mail.attachmentShareRetention.sweepExpiredShares, {});
		expect(await shareRow(t, shareId)).toBeNull();
	});

	it('is safe to run when nothing has lapsed', async () => {
		const t = convexTest(schema, modules);
		await seedExpired(t, Date.now() + 10 * DAY, 'future0000123456789abcdefghijkl1');

		expect(
			await t.mutation(internal.mail.attachmentShareRetention.sweepExpiredShares, {})
		).toMatchObject({ examined: 0, released: 0, purged: 0 });
	});
});

describe('the stored lifetime preference', () => {
	/**
	 * Convex validators must be spelled with literals, so the closed set exists
	 * twice: once in `mailSettingsValidators` and once in the shared module both
	 * planes resolve against. A choice added to one and not the other is a
	 * control that saves a value the client will silently clamp away.
	 */
	it('offers exactly the lifetimes the shared module knows about', () => {
		const literals = mailShareLinkExpiryDaysValidator.members.map((m) => m.value);
		expect(literals.sort()).toEqual([...ATTACHMENT_SHARE_EXPIRY_DAY_CHOICES].sort());
	});
});
