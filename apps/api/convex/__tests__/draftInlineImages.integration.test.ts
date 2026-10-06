/**
 * #1285: where the composer shows a reopened draft's inline body images from.
 *
 * The draft body saves a pasted image as `<img data-inline-cid="X">` with no
 * usable src, so `mail.draftInlineImages.urls` hands the editor a URL per
 * inline image part on the row. It is gated like `drafts.get`, and the URLs are
 * the expiring `/sealed-blob` capability the reader gets for a message part,
 * never a raw storage URL (which would keep working until the blob is gone).
 *
 * What a URL guarantees: it serves the image until its token expires, one hour
 * after it was minted. Losing access to the mailbox stops any NEW URL at once;
 * one minted before keeps working until it expires, as for every other
 * `/sealed-blob` URL (the proxy checks the signature and the expiry only).
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { SEALED_BLOB_PATH } from '../lib/sealedBlob';
import { enableFeatures } from './factories';

const SITE = 'https://deploy.convex.site';
const HOUR = 60 * 60 * 1000;

// Mutable session — `setUser` flips who the request is acting as.
const sessionMock = vi.hoisted(() => ({
	user: {
		id: 'user-alice',
		role: 'editor' as 'owner' | 'admin' | 'editor',
		orgId: 'org-1',
	},
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		// `requireMailboxAccess` reads ownership through this.
		getBetterAuthSessionWithRole: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
			activeOrganizationId: sessionMock.user.orgId,
		})),
		// Wrapper floors (authedMutation / authedQuery). They only need a member;
		// route them through the same mutable session so a set user never trips
		// the floor while the in-handler ownership check does the real work.
		requireOrgMember: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
			activeOrganizationId: sessionMock.user.orgId,
		})),
		getMutationContext: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
			activeOrganizationId: sessionMock.user.orgId,
		})),
		requireOrgPermission: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
			activeOrganizationId: sessionMock.user.orgId,
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

beforeEach(() => {
	setUser('user-alice', 'editor');
});

// ── Seed helpers ────────────────────────────────────────────────────

type MailboxParts = {
	mailboxId: Id<'mailboxes'>;
	inboxId: Id<'mailFolders'>;
	archiveId: Id<'mailFolders'>;
	trashId: Id<'mailFolders'>;
};

async function seedMailbox(
	t: TestConvex<typeof schema>,
	ownerUserId: string,
	address: string
): Promise<MailboxParts> {
	return t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: ownerUserId,
			organizationId: 'org-1',
			address,
			domain: 'owlat.test',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		const folder = async (name: string, role: 'inbox' | 'archive' | 'trash') =>
			ctx.db.insert('mailFolders', {
				mailboxId,
				name,
				role,
				uidValidity: now,
				uidNext: 1,
				highestModseq: 1,
				totalCount: 0,
				unseenCount: 0,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
		const inboxId = await folder('INBOX', 'inbox');
		const archiveId = await folder('Archive', 'archive');
		const trashId = await folder('Trash', 'trash');
		return { mailboxId, inboxId, archiveId, trashId };
	});
}

beforeEach(() => {
	vi.stubEnv('INSTANCE_SECRET', 'draft-inline-images-test-secret-32-chars-min');
	vi.stubEnv('CONVEX_SITE_URL', SITE);
	vi.stubEnv('ALLOWED_ORIGINS', 'https://app.example.com');
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

async function draftWithParts(t: TestConvex<typeof schema>, mailboxId: Id<'mailboxes'>) {
	setUser('user-alice', 'editor');
	const { draftId } = await t.mutation(api.mail.drafts.create, { mailboxId });
	return t.run(async (ctx) => {
		// Draft uploads are stored as the client sent them, unsealed.
		const store = (text: string, type: string) => ctx.storage.store(new Blob([text], { type }));
		const imageId = await store('png-bytes', 'image/png');
		const pdfId = await store('pdf-bytes', 'application/pdf');
		const inlineTextId = await store('text-bytes', 'text/plain');
		await ctx.db.patch(draftId, {
			bodyHtml: '<p>Chart:</p><p><img data-inline-cid="chart@owlat.inline"></p>',
			attachments: [
				{
					storageId: pdfId,
					filename: 'contract.pdf',
					contentType: 'application/pdf',
					size: 9,
					isInline: false,
				},
				{
					storageId: imageId,
					filename: 'chart.png',
					contentType: 'image/png',
					size: 9,
					isInline: true,
					contentId: 'chart@owlat.inline',
				},
				// Inline, but nothing an <img> shows.
				{
					storageId: inlineTextId,
					filename: 'note.txt',
					contentType: 'text/plain',
					size: 10,
					isInline: true,
					contentId: 'note@owlat.inline',
				},
			],
		});
		return { draftId, storageUrl: await ctx.storage.getUrl(imageId) };
	});
}

/** Fetch a minted URL through the real `/sealed-blob` route. */
const fetchUrl = (t: TestConvex<typeof schema>, url: string) =>
	t.fetch(SEALED_BLOB_PATH + new URL(url).search);

async function addMember(t: TestConvex<typeof schema>, mailboxId: Id<'mailboxes'>, userId: string) {
	return t.run(async (ctx) =>
		ctx.db.insert('mailboxMembers', {
			mailboxId,
			authUserId: userId,
			role: 'member',
			addedBy: 'user-alice',
			createdAt: Date.now(),
		})
	);
}

describe('mail.draftInlineImages.urls', () => {
	it('gives the draft owner an expiring proxy URL for each inline image, never a storage URL', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const a = await seedMailbox(t, 'user-alice', 'alice@owlat.test');
		const { draftId, storageUrl } = await draftWithParts(t, a.mailboxId);

		const urls = await t.action(api.mail.draftInlineImages.urls, { draftId });

		expect(urls.map((u) => u.contentId)).toEqual(['chart@owlat.inline']);
		const url = new URL(urls[0]!.url);
		expect(`${url.origin}${url.pathname}`).toBe(`${SITE}${SEALED_BLOB_PATH}`);
		expect(urls[0]!.url).not.toBe(storageUrl);
		expect(Number(url.searchParams.get('exp'))).toBeGreaterThan(Date.now());
		expect(Number(url.searchParams.get('exp'))).toBeLessThanOrEqual(Date.now() + HOUR);
		// The lifetime on the server's clock, which the client schedules renewal from.
		expect(urls[0]!.expiresInMs).toBeGreaterThan(HOUR - 60_000);
		expect(urls[0]!.expiresInMs).toBeLessThanOrEqual(HOUR);

		const res = await fetchUrl(t, urls[0]!.url);
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('image/png');
		expect(await res.text()).toBe('png-bytes');
	});

	it('refuses a URL once its capability has expired', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const a = await seedMailbox(t, 'user-alice', 'alice@owlat.test');
		const { draftId } = await draftWithParts(t, a.mailboxId);
		const [minted] = await t.action(api.mail.draftInlineImages.urls, { draftId });

		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.now() + HOUR + 1000);
		expect((await fetchUrl(t, minted!.url)).status).toBe(403);
	});

	it('stops a member removed from a shared mailbox: no new URL, and the old one ends at expiry', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const team = await seedMailbox(t, 'user-alice', 'team@owlat.test');
		const { draftId } = await draftWithParts(t, team.mailboxId);
		const membershipId = await addMember(t, team.mailboxId, 'user-bob');

		setUser('user-bob', 'editor');
		const [minted] = await t.action(api.mail.draftInlineImages.urls, { draftId });
		expect(minted).toBeDefined();

		await t.run(async (ctx) => ctx.db.delete(membershipId));
		expect(await t.action(api.mail.draftInlineImages.urls, { draftId })).toEqual([]);
		// Minted while Bob could open the draft: it lives out its hour, no longer.
		expect((await fetchUrl(t, minted!.url)).status).toBe(200);
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.now() + HOUR + 1000);
		expect((await fetchUrl(t, minted!.url)).status).toBe(403);
	});

	it('gives nothing to a member who cannot open the draft', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const a = await seedMailbox(t, 'user-alice', 'alice@owlat.test');
		const { draftId } = await draftWithParts(t, a.mailboxId);

		setUser('user-bob', 'editor');
		expect(await t.query(api.mail.drafts.get, { draftId })).toBeNull();
		expect(await t.action(api.mail.draftInlineImages.urls, { draftId })).toEqual([]);
	});

	it('answers [] once the draft is gone', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const a = await seedMailbox(t, 'user-alice', 'alice@owlat.test');
		const { draftId } = await draftWithParts(t, a.mailboxId);
		await t.run(async (ctx) => ctx.db.delete(draftId));

		expect(await t.action(api.mail.draftInlineImages.urls, { draftId })).toEqual([]);
	});
});
