/**
 * `inbox.rawMessage` — who may be handed a signed URL to a received message's
 * raw `.eml`, and for which messages one exists at all.
 *
 * The reader hides the download control on a quarantined message, but the
 * public action is callable directly from any signed-in admin's console or
 * browser extension, so the refusal has to live on the SERVER too — otherwise
 * the client-side hide is the whole gate and an admin can be handed a URL to
 * malware bytes with no signal that is what they are.
 *
 * Proven here:
 *   · an owner/admin gets the storage id of a normal message;
 *   · an INFECTED message yields null, whatever the caller's role;
 *   · a swept message (no `rawStorageId`) yields null rather than throwing;
 *   · an editor — a real signed-in member, not an anonymous caller — gets null;
 *   · an anonymous caller gets null.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import type { OrganizationRole } from '../../lib/sessionOrganization';

let mockSession: { userId: string; role: OrganizationRole } | null = {
	userId: 'test-user',
	role: 'owner',
};

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		getBetterAuthSessionWithRole: vi.fn(async () => mockSession),
	};
});

const rootGlob = import.meta.glob('../../**/*.*s');
const inboxGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../inbox/'),
		mod,
	])
);
const modules = { ...rootGlob, ...inboxGlob };

beforeEach(() => {
	mockSession = { userId: 'test-user', role: 'owner' };
});

async function seedMessage(
	t: ReturnType<typeof convexTest>,
	options: { virusVerdict?: 'clean' | 'infected' | 'skipped'; withBlob?: boolean } = {}
): Promise<Id<'inboundMessages'>> {
	return await t.run(async (ctx) => {
		const storageId =
			options.withBlob === false
				? undefined
				: await ctx.storage.store(new Blob(['raw bytes'], { type: 'message/rfc822' }));
		return await ctx.db.insert('inboundMessages', {
			messageId: '<raw-1@example.com>',
			from: 'bob@example.com',
			to: 'inbox@example.com',
			subject: 'with a blob',
			processingStatus: options.virusVerdict === 'infected' ? 'quarantined' : 'received',
			receivedAt: Date.now(),
			rawStorageId: storageId,
			rawSize: 9,
			isRawRetained: storageId ? (true as const) : undefined,
			virusVerdict: options.virusVerdict,
		});
	});
}

describe('inbox.rawMessage.getInboundMessageRawStorageId', () => {
	it('hands an owner the storage id of a normal message', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seedMessage(t, { virusVerdict: 'clean' });

		const storageId = await t.query(internal.inbox.rawMessage.getInboundMessageRawStorageId, {
			messageId,
		});

		expect(storageId).not.toBeNull();
	});

	it('refuses a quarantined message even for an admin', async () => {
		const t = convexTest(schema, modules);
		mockSession = { userId: 'test-user', role: 'admin' };
		const messageId = await seedMessage(t, { virusVerdict: 'infected' });

		const storageId = await t.query(internal.inbox.rawMessage.getInboundMessageRawStorageId, {
			messageId,
		});

		// The blob is deliberately still in storage — an operator investigating
		// what was sent reads it there, not through a browser-facing signed URL.
		expect(storageId).toBeNull();
		const row = await t.run(async (ctx) => await ctx.db.get(messageId));
		expect(row!.rawStorageId).toBeTruthy();
	});

	it('returns null for a message whose bytes the retention sweep released', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seedMessage(t, { virusVerdict: 'clean', withBlob: false });

		await expect(
			t.query(internal.inbox.rawMessage.getInboundMessageRawStorageId, { messageId })
		).resolves.toBeNull();
	});

	it('refuses an editor and an anonymous caller alike', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seedMessage(t, { virusVerdict: 'clean' });

		mockSession = { userId: 'test-user', role: 'editor' };
		await expect(
			t.query(internal.inbox.rawMessage.getInboundMessageRawStorageId, { messageId })
		).resolves.toBeNull();

		mockSession = null;
		await expect(
			t.query(internal.inbox.rawMessage.getInboundMessageRawStorageId, { messageId })
		).resolves.toBeNull();
	});
});
