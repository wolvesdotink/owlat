/**
 * #1285: where the composer shows a reopened draft's inline body images from.
 *
 * The draft body saves a pasted image as `<img data-inline-cid="X">` with no
 * usable src, so `mail.draftInlineImages.urls` hands the editor a storage URL
 * per inline image part on the row. It is gated like `drafts.get`: only a
 * caller who can open the draft gets URLs, and only for inline images.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { enableFeatures } from './factories';

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

async function draftWithParts(t: TestConvex<typeof schema>, mailboxId: Id<'mailboxes'>) {
	setUser('user-alice', 'editor');
	const { draftId } = await t.mutation(api.mail.drafts.create, { mailboxId });
	return t.run(async (ctx) => {
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
		return { draftId, imageUrl: await ctx.storage.getUrl(imageId) };
	});
}

describe('mail.draftInlineImages.urls', () => {
	it('gives the draft owner a storage URL for each inline image on the row', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const a = await seedMailbox(t, 'user-alice', 'alice@owlat.test');
		const { draftId, imageUrl } = await draftWithParts(t, a.mailboxId);

		const urls = await t.query(api.mail.draftInlineImages.urls, { draftId });

		expect(imageUrl).toBeTruthy();
		expect(urls).toEqual([{ contentId: 'chart@owlat.inline', url: imageUrl }]);
	});

	it('gives nothing to a member who cannot open the draft', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const a = await seedMailbox(t, 'user-alice', 'alice@owlat.test');
		const { draftId } = await draftWithParts(t, a.mailboxId);

		setUser('user-bob', 'editor');
		expect(await t.query(api.mail.drafts.get, { draftId })).toBeNull();
		expect(await t.query(api.mail.draftInlineImages.urls, { draftId })).toEqual([]);
	});

	it('answers [] once the draft is gone', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const a = await seedMailbox(t, 'user-alice', 'alice@owlat.test');
		const { draftId } = await draftWithParts(t, a.mailboxId);
		await t.run(async (ctx) => ctx.db.delete(draftId));

		expect(await t.query(api.mail.draftInlineImages.urls, { draftId })).toEqual([]);
	});
});
