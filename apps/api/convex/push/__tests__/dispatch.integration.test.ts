/**
 * Web Push decisions (push/dispatch): the same rules the desktop toasts apply,
 * evaluated server-side per device. Mail obeys mute, the reply alert, the
 * "Notify me about" scope and quiet hours (held back, then summarized once);
 * assignments obey "Nothing" only; chat mentions and DMs are treated as mail
 * from a person. Private notifications and sealed mail never carry content,
 * and a push service's 404/410 prunes the device.
 */

import type { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../_generated/api';
import { enableFeatures } from '../../__tests__/factories';
import { enqueuePush } from '../events';
import { runPostInsertInboundEffects } from '../../mail/deliveryPipeline/afterInsert';
import { insertRoomMessage } from '../../chat/messageInsert';
import {
	VAPID_ENV,
	pushHarness,
	quietWindowAroundNow,
	seedDevice,
	seedMailbox,
	seedMessage,
	setMemberRole,
} from './pushFixtures';

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

async function setSettings(t: T, fields: Record<string, unknown>) {
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('mailUserSettings', {
			userId: USER,
			autoAdvance: 'next',
			createdAt: now,
			updatedAt: now,
			...fields,
		});
	});
}

async function prepare(t: T, event: Parameters<typeof enqueuePush>[2], userId = USER) {
	const deliveries = await t.mutation(internal.push.dispatch.prepareDelivery, { userId, event });
	return deliveries.map((delivery) => ({ ...delivery, payload: JSON.parse(delivery.payload) }));
}

async function mailSetup(t: T, options: Partial<Parameters<typeof seedMessage>[1]> = {}) {
	await enableFeatures(t, ['postbox']);
	const { mailboxId, inboxId } = await seedMailbox(t, USER);
	const seeded = await seedMessage(t, { mailboxId, folderId: inboxId, ...options });
	const deviceId = await seedDevice(t, USER);
	return { ...seeded, mailboxId, inboxId, deviceId };
}

describe('push.dispatch mail', () => {
	it('notifies every device with the sender and subject, collapsing per thread', async () => {
		const t = await pushHarness(modules);
		const { messageId, threadId, mailboxId } = await mailSetup(t);
		await seedDevice(t, USER);
		const deliveries = await prepare(t, { kind: 'mail', messageId });
		expect(deliveries).toHaveLength(2);
		expect(deliveries[0]!.payload).toEqual({
			title: 'Alice Example',
			body: 'Lunch on Friday?',
			tag: `mail:${threadId}`,
			url: `/dashboard/postbox/inbox/${messageId}?mailbox=${mailboxId}`,
		});
		expect(deliveries[0]!.topic).toBe(`mail:${threadId}`);
		expect(deliveries[0]!.p256dh).toBeTruthy();
	});

	it('says only "New mail" when notifications are private, and in the person’s language', async () => {
		const t = await pushHarness(modules);
		const { messageId } = await mailSetup(t);
		await setSettings(t, { isHidePreviewOn: true });
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('userProfiles', {
				authUserId: USER,
				email: 'ada@example.com',
				locale: 'de',
				createdAt: now,
				updatedAt: now,
			});
		});
		const [delivery] = await prepare(t, { kind: 'mail', messageId });
		expect(delivery!.payload.title).toBe('Neue E-Mail');
		expect(delivery!.payload.body).toBe('Neue Nachricht');
		expect(JSON.stringify(delivery!.payload)).not.toContain('Alice');
	});

	it('never shows anything from a sealed message', async () => {
		const t = await pushHarness(modules);
		const { messageId } = await mailSetup(t, {
			message: { inboundEncryptionInfo: { isSealed: true, isDecrypted: false } },
		});
		const [delivery] = await prepare(t, { kind: 'mail', messageId });
		expect(delivery!.payload).toMatchObject({ title: 'New mail', body: 'New encrypted message' });
	});

	it('stays silent for read mail, muted threads, "Nothing" and out-of-scope categories', async () => {
		const read = await pushHarness(modules);
		const seen = await mailSetup(read, { message: { flagSeen: true } });
		expect(await prepare(read, { kind: 'mail', messageId: seen.messageId })).toEqual([]);

		const muted = await pushHarness(modules);
		const mutedMail = await mailSetup(muted, { thread: { mutedAt: Date.now() } });
		expect(await prepare(muted, { kind: 'mail', messageId: mutedMail.messageId })).toEqual([]);

		const nothing = await pushHarness(modules);
		const quietMail = await mailSetup(nothing);
		await setSettings(nothing, { notifyAbout: 'nothing' });
		expect(await prepare(nothing, { kind: 'mail', messageId: quietMail.messageId })).toEqual([]);

		const people = await pushHarness(modules);
		const newsletter = await mailSetup(people, { category: 'newsletter' });
		await setSettings(people, { notifyAbout: 'people-important' });
		expect(await prepare(people, { kind: 'mail', messageId: newsletter.messageId })).toEqual([]);
	});

	it('lets a "notify me when they reply" thread through the people-only scope', async () => {
		const t = await pushHarness(modules);
		const { messageId } = await mailSetup(t, {
			category: 'newsletter',
			thread: { notifyOnReplyAt: Date.now() },
		});
		await setSettings(t, { notifyAbout: 'people-important' });
		expect(await prepare(t, { kind: 'mail', messageId })).toHaveLength(1);
	});

	it('ignores shared mailboxes, other people’s mailboxes and a disabled mail feature', async () => {
		const t = await pushHarness(modules);
		await enableFeatures(t, ['postbox']);
		await seedDevice(t, USER);
		const shared = await seedMailbox(t, USER, 'shared');
		const sharedMail = await seedMessage(t, {
			mailboxId: shared.mailboxId,
			folderId: shared.inboxId,
		});
		expect(await prepare(t, { kind: 'mail', messageId: sharedMail.messageId })).toEqual([]);
		const other = await seedMailbox(t, 'user-b');
		const otherMail = await seedMessage(t, { mailboxId: other.mailboxId, folderId: other.inboxId });
		expect(await prepare(t, { kind: 'mail', messageId: otherMail.messageId })).toEqual([]);

		const off = await pushHarness(modules);
		const { mailboxId, inboxId } = await seedMailbox(off, USER);
		const mail = await seedMessage(off, { mailboxId, folderId: inboxId });
		await seedDevice(off, USER);
		expect(await prepare(off, { kind: 'mail', messageId: mail.messageId })).toEqual([]);
	});

	it('holds mail back in quiet hours and sends one summary when they end', async () => {
		const t = await pushHarness(modules);
		const { messageId, deviceId } = await mailSetup(t);
		await setSettings(t, { quietHours: quietWindowAroundNow() });
		expect(await prepare(t, { kind: 'mail', messageId })).toEqual([]);
		expect(await prepare(t, { kind: 'mail', messageId })).toEqual([]);

		const device = await t.run((ctx) => ctx.db.get(deviceId));
		expect(device?.quietDeferredCount).toBe(2);
		expect(device?.quietSummaryAt).toBeGreaterThan(Date.now());
		const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
		// One summary per window, not one per held-back message.
		expect(scheduled.filter((job) => job.name === 'push/send:deliverQuietSummary')).toHaveLength(1);

		// Still quiet: the summary moves to the window's end instead of firing.
		expect(
			await t.mutation(internal.push.dispatch.takeQuietSummary, { subscriptionId: deviceId })
		).toBeNull();

		await t.run(async (ctx) => {
			const row = await ctx.db.query('mailUserSettings').first();
			await ctx.db.patch(row!._id, { quietHours: { ...quietWindowAroundNow(), enabled: false } });
		});
		const summary = await t.mutation(internal.push.dispatch.takeQuietSummary, {
			subscriptionId: deviceId,
		});
		expect(JSON.parse(summary!.payload)).toMatchObject({
			title: 'While you were away',
			body: '2 notifications arrived during quiet hours',
		});
		const cleared = await t.run((ctx) => ctx.db.get(deviceId));
		expect(cleared?.quietDeferredCount).toBeUndefined();
		expect(cleared?.quietSummaryAt).toBeUndefined();
		// Taken once: a retried job finds nothing left to say.
		expect(
			await t.mutation(internal.push.dispatch.takeQuietSummary, { subscriptionId: deviceId })
		).toBeNull();
	});

	it('evaluates quiet hours on each device’s own clock', async () => {
		const t = await pushHarness(modules);
		const { messageId } = await mailSetup(t, {});
		await setSettings(t, { quietHours: quietWindowAroundNow() });
		// The fixture device is on UTC (inside the window); this one is 14 hours ahead.
		await seedDevice(t, USER, { timeZone: 'Pacific/Kiritimati' });
		const deliveries = await prepare(t, { kind: 'mail', messageId });
		expect(deliveries).toHaveLength(1);
	});

	it('stops notifying someone removed from the organization, summary included', async () => {
		const t = await pushHarness(modules);
		const { messageId, deviceId } = await mailSetup(t);
		await setSettings(t, { quietHours: quietWindowAroundNow() });
		expect(await prepare(t, { kind: 'mail', messageId })).toEqual([]);
		await t.run(async (ctx) => {
			const row = await ctx.db.query('mailUserSettings').first();
			await ctx.db.patch(row!._id, { quietHours: { ...quietWindowAroundNow(), enabled: false } });
		});
		await setMemberRole(t, USER, null);
		expect(await prepare(t, { kind: 'mail', messageId })).toEqual([]);
		expect(
			await t.mutation(internal.push.dispatch.takeQuietSummary, { subscriptionId: deviceId })
		).toBeNull();
		const cleared = await t.run((ctx) => ctx.db.get(deviceId));
		expect(cleared?.quietDeferredCount).toBeUndefined();
	});
});

describe('push.dispatch assignment', () => {
	async function seedNotice(t: T, kind?: 'clarification') {
		return t.run(async (ctx) => {
			const now = Date.now();
			const threadId = await ctx.db.insert('conversationThreads', {
				subject: 'Invoice 42',
				normalizedSubject: 'invoice 42',
				contactIdentifier: 'customer@example.com',
				status: 'open',
				messageCount: 1,
				lastMessageAt: now,
				firstMessageAt: now,
				createdAt: now,
			});
			const noticeId = await ctx.db.insert('inboxAssignmentNotices', {
				userId: USER,
				threadId,
				subject: 'Invoice 42',
				assignedByName: 'Grace',
				createdAt: Date.now(),
				...(kind ? { kind } : {}),
			});
			return { threadId, noticeId };
		});
	}

	it('notifies the assignee, outside quiet hours too, as the desktop does', async () => {
		const t = await pushHarness(modules);
		await enableFeatures(t, ['inbox']);
		await seedDevice(t, USER);
		await setSettings(t, { quietHours: quietWindowAroundNow() });
		const { threadId, noticeId } = await seedNotice(t);
		const [delivery] = await prepare(t, { kind: 'assignment', noticeId });
		expect(delivery!.payload).toEqual({
			title: 'Assigned to you',
			body: 'Invoice 42 · from Grace',
			tag: `inbox:${threadId}`,
			url: `/dashboard/inbox/${threadId}`,
		});
	});

	it('words a clarification ask as a question, and respects "Nothing"', async () => {
		const t = await pushHarness(modules);
		await enableFeatures(t, ['inbox']);
		await seedDevice(t, USER);
		const { noticeId } = await seedNotice(t, 'clarification');
		const [delivery] = await prepare(t, { kind: 'assignment', noticeId });
		expect(delivery!.payload.title).toBe('Your input is needed');
		await setSettings(t, { notifyAbout: 'nothing' });
		expect(await prepare(t, { kind: 'assignment', noticeId })).toEqual([]);
	});

	it('stays silent when the shared inbox is switched off or the notice is someone else’s', async () => {
		const t = await pushHarness(modules);
		await seedDevice(t, USER);
		const { noticeId } = await seedNotice(t);
		expect(await prepare(t, { kind: 'assignment', noticeId })).toEqual([]);
		await enableFeatures(t, ['inbox']);
		await seedDevice(t, 'user-b');
		expect(await prepare(t, { kind: 'assignment', noticeId }, 'user-b')).toEqual([]);
	});

	it('rechecks the assignee’s access: a demoted or removed member gets nothing', async () => {
		const t = await pushHarness(modules);
		await enableFeatures(t, ['inbox']);
		await seedDevice(t, USER);
		const { noticeId } = await seedNotice(t);
		expect(await prepare(t, { kind: 'assignment', noticeId })).toHaveLength(1);
		// An editor does not read the shared inbox, as `pendingAssignments` says.
		await setMemberRole(t, USER, 'editor');
		expect(await prepare(t, { kind: 'assignment', noticeId })).toEqual([]);
		await setMemberRole(t, USER, 'owner');
		expect(await prepare(t, { kind: 'assignment', noticeId })).toHaveLength(1);
		await setMemberRole(t, USER, null);
		expect(await prepare(t, { kind: 'assignment', noticeId })).toEqual([]);
	});
});

describe('push.dispatch chat', () => {
	async function seedDm(t: T, membership: { mutedUntil?: number } = {}) {
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
				kind: 'dm',
				name: 'Ada, Grace',
				normalizedName: `${USER},user-b`,
				visibility: 'private',
				createdBy: 'user-b',
				createdAt: now,
				updatedAt: now,
				lastMessageAt: now,
				messageCount: 1,
			});
			for (const memberId of [USER, 'user-b']) {
				await ctx.db.insert('chatRoomMembers', {
					roomId,
					memberId,
					role: 'member',
					joinedAt: now,
					lastReadAt: now,
					...(memberId === USER ? membership : {}),
				});
			}
			const messageId = await ctx.db.insert('chatMessages', {
				roomId,
				authorId: 'user-b',
				text: 'Can you look at the deploy?',
				createdAt: now,
			});
			return { roomId, messageId };
		});
	}

	it('notifies a DM with the author and text, and links the room', async () => {
		const t = await pushHarness(modules);
		await enableFeatures(t, ['chat']);
		await seedDevice(t, USER);
		const { roomId, messageId } = await seedDm(t);
		const [delivery] = await prepare(t, { kind: 'chat', messageId, reason: 'dm' });
		expect(delivery!.payload).toEqual({
			title: 'Grace Hopper',
			body: 'Can you look at the deploy?',
			tag: `chat:${roomId}`,
			url: `/dashboard/chat/${roomId}`,
		});
		// Never to the author.
		await seedDevice(t, 'user-b');
		expect(await prepare(t, { kind: 'chat', messageId, reason: 'dm' }, 'user-b')).toEqual([]);
	});

	it('stays silent for a DM partner who has left the organization', async () => {
		const t = await pushHarness(modules);
		await enableFeatures(t, ['chat']);
		await seedDevice(t, USER);
		const { messageId } = await seedDm(t);
		await setMemberRole(t, USER, null);
		expect(await prepare(t, { kind: 'chat', messageId, reason: 'dm' })).toEqual([]);
	});

	it('honours a muted room, private notifications and the chat flag', async () => {
		const muted = await pushHarness(modules);
		await enableFeatures(muted, ['chat']);
		await seedDevice(muted, USER);
		const mutedDm = await seedDm(muted, { mutedUntil: Date.now() + 3_600_000 });
		expect(
			await prepare(muted, { kind: 'chat', messageId: mutedDm.messageId, reason: 'dm' })
		).toEqual([]);

		const quiet = await pushHarness(modules);
		await enableFeatures(quiet, ['chat']);
		await seedDevice(quiet, USER);
		await setSettings(quiet, { isHidePreviewOn: true });
		const dm = await seedDm(quiet);
		const [delivery] = await prepare(quiet, {
			kind: 'chat',
			messageId: dm.messageId,
			reason: 'dm',
		});
		expect(delivery!.payload).toMatchObject({
			title: 'New chat message',
			body: 'You have a new chat message',
		});

		const off = await pushHarness(modules);
		await seedDevice(off, USER);
		const offDm = await seedDm(off);
		expect(await prepare(off, { kind: 'chat', messageId: offDm.messageId, reason: 'dm' })).toEqual(
			[]
		);
	});
});

describe('push.dispatch outcomes and producers', () => {
	it('prunes a device the push service no longer knows and stamps a delivered one', async () => {
		const t = await pushHarness(modules);
		const gone = await seedDevice(t, USER);
		const fine = await seedDevice(t, USER);
		const flaky = await seedDevice(t, USER);
		await t.mutation(internal.push.dispatch.recordOutcomes, {
			outcomes: [
				{ subscriptionId: gone, outcome: 'gone' },
				{ subscriptionId: fine, outcome: 'delivered' },
				{ subscriptionId: flaky, outcome: 'failed' },
			],
		});
		const rows = await t.run((ctx) => ctx.db.query('pushSubscriptions').collect());
		expect(rows.map((row) => row._id).sort()).toEqual([fine, flaky].sort());
		expect(rows.find((row) => row._id === fine)?.lastSuccessAt).toBeTypeOf('number');
		expect(rows.find((row) => row._id === flaky)?.lastSuccessAt).toBeUndefined();
	});

	it('only schedules a push when keys are set and the person has a device', async () => {
		const t = await pushHarness(modules);
		const { mailboxId, inboxId } = await seedMailbox(t, USER);
		const { messageId } = await seedMessage(t, { mailboxId, folderId: inboxId });
		await t.run((ctx) => enqueuePush(ctx, USER, { kind: 'mail', messageId }));
		await seedDevice(t, USER);
		vi.stubEnv('VAPID_PRIVATE_KEY', '');
		await t.run((ctx) => enqueuePush(ctx, USER, { kind: 'mail', messageId }));
		vi.stubEnv('VAPID_PRIVATE_KEY', VAPID_ENV.VAPID_PRIVATE_KEY);
		await t.run((ctx) => enqueuePush(ctx, USER, { kind: 'mail', messageId }));
		const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
		expect(scheduled.map((job) => job.name)).toEqual(['push/send:deliver']);
	});

	async function scheduledPushes(t: T) {
		const jobs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
		return jobs.filter((job) => job.name === 'push/send:deliver').map((job) => job.args[0]);
	}

	it('mail delivery asks for a push for live inbox mail in a personal mailbox', async () => {
		const t = await pushHarness(modules);
		await seedDevice(t, USER);
		const { mailboxId, inboxId } = await seedMailbox(t, USER);
		const { messageId } = await seedMessage(t, { mailboxId, folderId: inboxId });
		await t.run(async (ctx) => {
			const folder = await ctx.db.get(inboxId);
			await runPostInsertInboundEffects(ctx, { messageId, folder: folder!, origin: 'mx' });
		});
		expect(await scheduledPushes(t)).toEqual([
			{ userId: USER, event: { kind: 'mail', messageId } },
		]);

		// A backfill is history, not news.
		const history = await pushHarness(modules);
		await seedDevice(history, USER);
		const box = await seedMailbox(history, USER);
		const old = await seedMessage(history, { mailboxId: box.mailboxId, folderId: box.inboxId });
		await history.run(async (ctx) => {
			const folder = await ctx.db.get(box.inboxId);
			await runPostInsertInboundEffects(ctx, {
				messageId: old.messageId,
				folder: folder!,
				origin: 'backfill',
			});
		});
		expect(await scheduledPushes(history)).toEqual([]);
	});

	it('a direct message asks for a push for every other participant', async () => {
		const t = await pushHarness(modules);
		await seedDevice(t, USER);
		await seedDevice(t, 'user-b');
		const { room, membership } = await t.run(async (ctx) => {
			const now = Date.now();
			const roomId = await ctx.db.insert('chatRooms', {
				kind: 'dm',
				name: 'Ada, Grace',
				normalizedName: `${USER},user-b`,
				visibility: 'private',
				createdBy: 'user-b',
				createdAt: now,
				updatedAt: now,
				lastMessageAt: now,
				messageCount: 0,
			});
			let authorMembership = null;
			for (const memberId of [USER, 'user-b']) {
				const id = await ctx.db.insert('chatRoomMembers', {
					roomId,
					memberId,
					role: 'member',
					joinedAt: now,
					lastReadAt: now,
				});
				if (memberId === 'user-b') authorMembership = await ctx.db.get(id);
			}
			return { room: (await ctx.db.get(roomId))!, membership: authorMembership };
		});
		const messageId = await t.run((ctx) =>
			insertRoomMessage(ctx, {
				room,
				authorId: 'user-b',
				text: 'Ping',
				authorMembership: membership,
			})
		);
		expect(await scheduledPushes(t)).toEqual([
			{ userId: USER, event: { kind: 'chat', messageId, reason: 'dm' } },
		]);
	});
});
