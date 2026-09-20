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
 *   · an anonymous caller gets null;
 *   · a MISCONFIGURED instance — a key with nowhere to proxy through — answers
 *     null AND says so in the log, because the client's only copy for a null
 *     is "try again" and this one never comes true.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import type { OrganizationRole } from '../../lib/sessionOrganization';
import * as runtimeLog from '../../lib/runtimeLog';

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

describe('inbox.rawMessage.getInboundMessageRawUrl', () => {
	const SAVED_ENV = { ...process.env };

	afterEach(() => {
		process.env = { ...SAVED_ENV };
		vi.restoreAllMocks();
	});

	it('logs when a configuration gap is what makes the URL unmintable', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seedMessage(t, { virusVerdict: 'clean' });
		// A key to seal with and no site URL to serve the decrypt proxy from:
		// every attachment download on every message fails, forever, and
		// `sealedBlobUrl` returns its null without a word.
		process.env['INSTANCE_SECRET'] = 'a'.repeat(64);
		delete process.env['CONVEX_SITE_URL'];
		const warn = vi.spyOn(runtimeLog, 'logWarn').mockImplementation(() => {});

		await expect(
			t.action(api.inbox.rawMessage.getInboundMessageRawUrl, { messageId })
		).resolves.toBeNull();

		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('could not mint a sealed-blob URL'),
			expect.objectContaining({ messageId })
		);
	});

	it('says nothing for the states the reader already explains', async () => {
		const t = convexTest(schema, modules);
		// Swept bytes: the thread view disables the control and names the reason,
		// so this null is expected and a log line would be noise on every render.
		const messageId = await seedMessage(t, { virusVerdict: 'clean', withBlob: false });
		const warn = vi.spyOn(runtimeLog, 'logWarn').mockImplementation(() => {});

		await expect(
			t.action(api.inbox.rawMessage.getInboundMessageRawUrl, { messageId })
		).resolves.toBeNull();

		expect(warn).not.toHaveBeenCalled();
	});
});
