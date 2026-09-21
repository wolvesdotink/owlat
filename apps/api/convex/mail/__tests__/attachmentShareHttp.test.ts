/**
 * The serving route for attachment share links, driven through `t.fetch` so it
 * exercises the real registration in `http.ts`.
 *
 * The backend rules (which tokens resolve, which refuse) are covered in
 * `attachmentShares.test.ts`; what is pinned here is the SHAPE of the answer.
 * A share link is a public token endpoint, and the public-endpoint reference
 * promises those return structured JSON for an invalid or expired token — the
 * refusal must stay a uniform 404 in the `{ error: { category, message } }`
 * envelope, never naming which gate closed.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { ATTACHMENT_SHARE_PATH } from '@owlat/shared/attachmentShares';
import { modules, seedMailbox } from './helpers.testlib';

const sessionMocks = vi.hoisted(() => ({ userId: 'user-A', role: 'owner' as const }));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({ ...sessionMocks })),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => ({ ...sessionMocks })),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			...sessionMocks,
			activeOrganizationId: 'org-1',
		})),
	};
});

const TOKEN = 'sharetoken0123456789abcdefghijkl'; // 32 chars, URL alphabet

function setupTest() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

beforeEach(() => {
	process.env['OWLAT_DEV_MODE'] = 'true';
});

/** A live, `anyone`-scoped share over real stored bytes. */
async function seedLiveShare(t: TestConvex<typeof schema>): Promise<Id<'mailAttachmentShares'>> {
	const mailboxId = await seedMailbox(t);
	const { draftId, storageId } = await t.run(async (ctx) => {
		const now = Date.now();
		const storageId = await ctx.storage.store(new Blob([new Uint8Array([1, 2, 3, 4])]));
		const draftId = await ctx.db.insert('mailDrafts', {
			mailboxId,
			toAddresses: ['b@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			fromAddress: 'a@owlat.test',
			subject: 'Here is the file',
			bodyHtml: '<p>hi</p>',
			attachments: [
				{
					storageId,
					filename: 'huge.zip',
					contentType: 'application/zip',
					size: 4,
					isInline: false,
				},
			],
			state: 'draft' as const,
			lastEditedAt: now,
			createdAt: now,
		});
		return { draftId, storageId };
	});
	const created = await t.mutation(internal.mail.attachmentShares.createShare, {
		draftId,
		storageId,
		token: TOKEN,
		expiryDays: 14,
		scanVerdict: 'clean',
	});
	return created.shareId;
}

describe('GET /attachment-share/{token}', () => {
	it('streams the bytes as a forced download for a live token', async () => {
		const t = setupTest();
		await seedLiveShare(t);

		const res = await t.fetch(`${ATTACHMENT_SHARE_PATH}${TOKEN}`, { method: 'GET' });

		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="huge.zip"');
		expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
	});

	it('refuses an unknown token with the structured error envelope, not text/plain', async () => {
		const t = setupTest();
		await seedLiveShare(t);

		const res = await t.fetch(`${ATTACHMENT_SHARE_PATH}nosuchtoken0123456789abcdefghijk`, {
			method: 'GET',
		});

		expect(res.status).toBe(404);
		expect(res.headers.get('Content-Type')).toBe('application/json');
		expect(res.headers.get('Cache-Control')).toBe('no-store');
		expect(await res.json()).toEqual({
			error: { category: 'not_found', message: 'Not found' },
		});
	});

	it('answers a revoked token identically to a malformed one', async () => {
		const t = setupTest();
		const shareId = await seedLiveShare(t);
		await t.run(async (ctx) => {
			await ctx.db.patch(shareId, { revokedAt: Date.now() });
		});

		const revoked = await t.fetch(`${ATTACHMENT_SHARE_PATH}${TOKEN}`, { method: 'GET' });
		const malformed = await t.fetch(`${ATTACHMENT_SHARE_PATH}%E0%A4%A`, { method: 'GET' });

		expect(revoked.status).toBe(404);
		expect(malformed.status).toBe(404);
		expect(await revoked.json()).toEqual(await malformed.json());
	});
});
