/**
 * Shared seeding for the Web Push integration tests: the organization the
 * recipients belong to, a personal mailbox with an inbox, an unread message in
 * its own thread, and a registered device.
 */

import { convexTest } from 'convex-test';
import schema from '../../schema';
import betterAuthSchema from '../../betterAuth/schema';
import { components } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import { betterAuthModules } from '../../__tests__/testModules';
import { _resetSingletonOrgCacheForTests } from '../../lib/sessionOrganization';

type T = ReturnType<typeof convexTest>;
type Role = 'owner' | 'admin' | 'editor';

/**
 * A harness whose organization has these members, so the sender's
 * current-access check sees them. `user-a` and `user-b` are admins by default.
 */
export async function pushHarness(
	modules: Record<string, () => Promise<unknown>>,
	members: Record<string, Role> = { 'user-a': 'admin', 'user-b': 'admin' }
): Promise<T> {
	_resetSingletonOrgCacheForTests();
	const t = convexTest(schema, modules);
	t.registerComponent('betterAuth', betterAuthSchema, betterAuthModules);
	const org = (await t.mutation(components.betterAuth.adapter.create, {
		input: { model: 'organization', data: { name: 'Acme', slug: 'acme', createdAt: Date.now() } },
	} as never)) as { _id: string };
	for (const [userId, role] of Object.entries(members)) {
		await t.mutation(components.betterAuth.adapter.create, {
			input: {
				model: 'member',
				data: { organizationId: org._id, userId, role, createdAt: Date.now() },
			},
		} as never);
	}
	return t;
}

/** Change a member's role, or remove them from the organization (`null`). */
export async function setMemberRole(t: T, userId: string, role: Role | null): Promise<void> {
	const where = [{ field: 'userId', value: userId }];
	if (role === null) {
		await t.mutation(components.betterAuth.adapter.deleteOne, {
			input: { model: 'member', where },
		} as never);
		return;
	}
	await t.mutation(components.betterAuth.adapter.updateOne, {
		input: { model: 'member', where, update: { role } },
	} as never);
}

/** A real RFC 8291 user-agent key pair, so the sender could actually encrypt to it. */
export const DEVICE_KEYS = {
	p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
	auth: 'BTBZMqHH6r4Tts7J_aSIgg',
};

export const VAPID_ENV = {
	VAPID_PUBLIC_KEY:
		'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
	VAPID_PRIVATE_KEY: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
};

export async function seedDevice(
	t: T,
	userId: string,
	overrides: Partial<Doc<'pushSubscriptions'>> = {}
): Promise<Id<'pushSubscriptions'>> {
	return t.run((ctx) =>
		ctx.db.insert('pushSubscriptions', {
			userId,
			endpoint: `https://push.example.com/${userId}/${Math.random().toString(36).slice(2)}`,
			...DEVICE_KEYS,
			label: 'Firefox on Linux',
			timeZone: 'UTC',
			createdAt: Date.now(),
			...overrides,
		})
	);
}

export async function seedMailbox(
	t: T,
	userId: string,
	scope: 'personal' | 'shared' = 'personal'
): Promise<{ mailboxId: Id<'mailboxes'>; inboxId: Id<'mailFolders'> }> {
	return t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId,
			organizationId: 'test-org',
			address: `${userId}@example.com`,
			domain: 'example.com',
			status: 'active',
			scope,
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		const inboxId = await ctx.db.insert('mailFolders', {
			mailboxId,
			name: 'INBOX',
			role: 'inbox',
			uidValidity: now,
			uidNext: 1,
			highestModseq: 1,
			totalCount: 0,
			unseenCount: 0,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
		return { mailboxId, inboxId };
	});
}

export async function seedMessage(
	t: T,
	opts: {
		mailboxId: Id<'mailboxes'>;
		folderId: Id<'mailFolders'>;
		subject?: string;
		category?: 'person' | 'newsletter';
		thread?: Partial<Doc<'mailThreads'>>;
		message?: Partial<Doc<'mailMessages'>>;
	}
): Promise<{ messageId: Id<'mailMessages'>; threadId: Id<'mailThreads'> }> {
	return t.run(async (ctx) => {
		const now = Date.now();
		const subject = opts.subject ?? 'Lunch on Friday?';
		const storageId = await ctx.storage.store(new Blob([subject]));
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId: opts.mailboxId,
			normalizedSubject: subject.toLowerCase(),
			participants: ['alice@example.com'],
			messageCount: 1,
			unreadCount: 1,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: subject,
			latestFromAddress: 'alice@example.com',
			latestSubject: subject,
			folderRoles: ['inbox'],
			labelIds: [],
			category: opts.category
				? { label: opts.category, source: 'heuristic', classifiedAt: now }
				: undefined,
			createdAt: now,
			updatedAt: now,
			...opts.thread,
		});
		const messageId = await ctx.db.insert('mailMessages', {
			mailboxId: opts.mailboxId,
			folderId: opts.folderId,
			uid: 1,
			modseq: 1,
			rfc822MessageId: `<${Math.random()}@example.com>`,
			threadId,
			fromName: 'Alice Example',
			fromAddress: 'alice@example.com',
			toAddresses: ['me@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			subject,
			normalizedSubject: subject.toLowerCase(),
			snippet: subject,
			rawStorageId: storageId,
			rawSize: subject.length,
			attachments: [],
			hasAttachments: false,
			flagSeen: false,
			flagFlagged: false,
			flagAnswered: false,
			flagDraft: false,
			flagDeleted: false,
			customFlags: [],
			labelIds: [],
			receivedAt: now,
			internalDate: now,
			createdAt: now,
			updatedAt: now,
			...opts.message,
		});
		return { messageId, threadId };
	});
}

/** A quiet-hours window that is open right now in UTC, whatever the time of day. */
export function quietWindowAroundNow(): {
	enabled: boolean;
	startMinute: number;
	endMinute: number;
	days: number[];
} {
	const now = new Date();
	const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
	return {
		enabled: true,
		startMinute: (minute - 10 + 1440) % 1440,
		endMinute: (minute + 30) % 1440,
		days: [0, 1, 2, 3, 4, 5, 6],
	};
}
