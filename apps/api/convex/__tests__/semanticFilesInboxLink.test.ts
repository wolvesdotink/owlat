import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

/**
 * The file library is readable by every org member; the shared inbox is not
 * (`organization:manage`). So the conversation link `semanticFiles.get` carries
 * — the thread id and, worse, its SUBJECT, which is customer text from a
 * mailbox a non-admin cannot open — must not ride along on a file read.
 */

/** Who is reading — flipped per test. Hoisted so the mock factory can see it. */
const role = vi.hoisted(() => ({ current: 'editor' as 'editor' | 'owner' }));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	const adminSession = { userId: 'admin-user', role: 'owner', activeOrganizationId: 'org-1' };
	const sessionFor = () =>
		role.current === 'owner'
			? adminSession
			: { userId: 'member-user', role: 'editor', activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => sessionFor()),
		getMutationContext: vi.fn(async () => sessionFor()),
		// The setup write below stays admin-only regardless of who is reading.
		requireAdminContext: vi.fn(async () => adminSession),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn(async () => sessionFor().userId),
	};
});

const modules = import.meta.glob('../**/*.*s');

type Harness = ReturnType<typeof convexTest>;

/** A file linked to an inbox conversation, created through the real mutations. */
async function linkedFile(t: Harness): Promise<{
	fileId: Id<'semanticFiles'>;
	threadId: Id<'conversationThreads'>;
}> {
	const threadId = await t.run((ctx) =>
		ctx.db.insert('conversationThreads', {
			subject: 'Refund for order 4417',
			normalizedSubject: 'refund for order 4417',
			contactIdentifier: 'customer@example.com',
			status: 'open',
			messageCount: 1,
			firstMessageAt: 1,
			lastMessageAt: 1,
			createdAt: 1,
		})
	);
	const storageId = await t.run((ctx) => ctx.storage.store(new Blob(['body'])));
	const fileId = await t.mutation(api.semanticFiles.create, {
		storageId,
		filename: 'receipt.txt',
		mimeType: 'text/plain',
		fileSize: 4,
		sourceType: 'upload',
		threadId,
	});
	return { fileId, threadId };
}

describe('semanticFiles.get — inbox link exposure', () => {
	it('gives a non-admin member the file but neither the thread nor its subject', async () => {
		role.current = 'editor';
		const t = convexTest(schema, modules);
		const { fileId } = await linkedFile(t);

		const file = await t.query(api.semanticFiles.get, { fileId });
		expect(file?.filename).toBe('receipt.txt');
		expect(file?.threadId).toBeUndefined();
		expect(file?.threadSubject).toBeUndefined();
		// Nothing else in the payload may carry the subject either.
		expect(JSON.stringify(file)).not.toContain('Refund for order 4417');
	});

	it('gives an admin the link and the subject that labels it', async () => {
		role.current = 'owner';
		const t = convexTest(schema, modules);
		const { fileId, threadId } = await linkedFile(t);

		const file = await t.query(api.semanticFiles.get, { fileId });
		expect(file?.threadId).toBe(threadId);
		expect(file?.threadSubject).toBe('Refund for order 4417');
	});
});
