/**
 * Web Push for a mention in a team discussion of an email (push/dispatch): the
 * click opens the email, the title names its subject, and a sealed (E2EE)
 * email's subject never reaches the payload, since it was restored from inside
 * the ciphertext.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { enableFeatures } from '../../__tests__/factories';
import { VAPID_ENV, seedDevice, seedMailbox, seedMessage } from './pushFixtures';

// Sibling `push/*` modules glob in as `../foo.ts`; convex-test resolves function
// paths from the convex root, so re-root them to `../../push/foo.ts`.
const modules = Object.fromEntries(
	Object.entries(import.meta.glob('../../**/*.*s')).map(([key, load]) =>
		key.startsWith('../') && !key.startsWith('../../')
			? ['../../push/' + key.slice(3), load]
			: [key, load]
	)
);

const USER = 'user-a';

beforeEach(() => {
	for (const [key, value] of Object.entries(VAPID_ENV)) vi.stubEnv(key, value);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

type T = ReturnType<typeof convexTest>;

async function seedDiscussion(t: T, options: { sealed: boolean }) {
	await enableFeatures(t, ['postbox', 'chat']);
	const { mailboxId, inboxId } = await seedMailbox(t, USER);
	const { messageId, threadId } = await seedMessage(t, {
		mailboxId,
		folderId: inboxId,
		subject: 'Quarterly numbers',
		message: options.sealed
			? {
					inboundEncryptionInfo: {
						isSealed: true,
						isDecrypted: true,
						cipherSuite: 'pgp-mime',
						isSignatureValid: false,
					},
				}
			: {},
	});
	await t.run((ctx) => ctx.db.patch(threadId, { latestMessageId: messageId }));
	await seedDevice(t, USER);
	return t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('userProfiles', {
			authUserId: 'user-b',
			email: 'grace@example.com',
			name: 'Grace Hopper',
			createdAt: now,
			updatedAt: now,
		});
		const roomId = await ctx.db.insert('chatRooms', {
			kind: 'channel',
			name: 'Quarterly numbers',
			normalizedName: `mail-thread-${threadId}`,
			visibility: 'private',
			createdBy: 'user-b',
			purpose: 'mail_thread_discussion',
			linkedMailThreadId: threadId,
			createdAt: now,
			updatedAt: now,
			lastMessageAt: now,
			messageCount: 1,
		});
		const chatMessageId = await ctx.db.insert('chatMessages', {
			roomId,
			authorId: 'user-b',
			text: '@ada can you check these?',
			createdAt: now,
		});
		return { roomId, chatMessageId, messageId, mailboxId };
	});
}

async function prepareMention(t: T, messageId: Id<'chatMessages'>) {
	const deliveries = await t.mutation(internal.push.dispatch.prepareDelivery, {
		userId: USER,
		event: { kind: 'chat', messageId, reason: 'mention' },
	});
	return deliveries.map((delivery) => JSON.parse(delivery.payload));
}

describe('push.dispatch chat in an email discussion', () => {
	it('names the email and opens it on click', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedDiscussion(t, { sealed: false });
		const [payload] = await prepareMention(t, seeded.chatMessageId);
		expect(payload).toEqual({
			title: 'Grace Hopper in Quarterly numbers',
			body: '@ada can you check these?',
			tag: `chat:${seeded.roomId}`,
			url: `/dashboard/postbox/inbox/${seeded.messageId}?mailbox=${seeded.mailboxId}`,
		});
	});

	it('never shows the subject of a sealed email', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seedDiscussion(t, { sealed: true });
		const [payload] = await prepareMention(t, seeded.chatMessageId);
		expect(payload.title).toBe('Grace Hopper in an encrypted conversation');
		expect(JSON.stringify(payload)).not.toContain('Quarterly numbers');
	});
});
