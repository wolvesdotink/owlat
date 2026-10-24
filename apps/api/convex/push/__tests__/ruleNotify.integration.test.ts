/**
 * A rule's `notify` action (read on arrival): it pushes for its
 * message even when "Notify me about" says Nothing or the category is out of
 * scope, and wherever the rule filed the mail, but never past a muted thread,
 * quiet hours or the preview-privacy setting, and never from Trash or Spam.
 */

import type { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { enableFeatures } from '../../__tests__/factories';
import {
	VAPID_ENV,
	pushHarness,
	quietWindowAroundNow,
	seedDevice,
	seedMailbox,
	seedMessage,
} from './pushFixtures';

const modules = Object.fromEntries(
	Object.entries(import.meta.glob('../../**/*.*s')).map(([key, load]) =>
		key.startsWith('../') && !key.startsWith('../../')
			? ['../../push/' + key.slice(3), load]
			: [key, load]
	)
);

const USER = 'user-a';
type T = ReturnType<typeof convexTest>;

beforeEach(() => {
	for (const [key, value] of Object.entries(VAPID_ENV)) vi.stubEnv(key, value);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

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

async function setup(t: T, options: Partial<Parameters<typeof seedMessage>[1]> = {}) {
	await enableFeatures(t, ['postbox']);
	const { mailboxId, inboxId } = await seedMailbox(t, USER);
	const seeded = await seedMessage(t, { mailboxId, folderId: inboxId, ...options });
	const deviceId = await seedDevice(t, USER);
	return { ...seeded, mailboxId, inboxId, deviceId };
}

async function prepareRuleNotify(t: T, messageId: Id<'mailMessages'>) {
	const deliveries = await t.mutation(internal.push.dispatch.prepareDelivery, {
		userId: USER,
		event: { kind: 'mail', messageId, isRuleNotify: true },
	});
	return deliveries.map((delivery) => ({ ...delivery, payload: JSON.parse(delivery.payload) }));
}

async function folderOf(t: T, mailboxId: Id<'mailboxes'>, role?: 'trash') {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert('mailFolders', {
			mailboxId,
			name: role ? 'TRASH' : 'Finance',
			...(role ? { role } : {}),
			uidValidity: now,
			uidNext: 1,
			highestModseq: 1,
			totalCount: 0,
			unseenCount: 0,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
	});
}

describe('push.dispatch rule notify', () => {
	it('notifies past "Nothing" and an out-of-scope category', async () => {
		const t = await pushHarness(modules);
		const { messageId } = await setup(t, { category: 'newsletter' });
		await setSettings(t, { notifyAbout: 'nothing' });
		expect(await prepareRuleNotify(t, messageId)).toHaveLength(1);
		const plain = await t.mutation(internal.push.dispatch.prepareDelivery, {
			userId: USER,
			event: { kind: 'mail', messageId },
		});
		expect(plain).toEqual([]);
	});

	it('notifies from the folder a rule filed into, never from Trash', async () => {
		const t = await pushHarness(modules);
		const { messageId, mailboxId } = await setup(t);
		const finance = await folderOf(t, mailboxId);
		await t.run(async (ctx) => await ctx.db.patch(messageId, { folderId: finance }));
		expect(await prepareRuleNotify(t, messageId)).toHaveLength(1);
		const trash = await folderOf(t, mailboxId, 'trash');
		await t.run(async (ctx) => await ctx.db.patch(messageId, { folderId: trash }));
		expect(await prepareRuleNotify(t, messageId)).toEqual([]);
	});

	it('stays silent for a muted thread and holds back in quiet hours', async () => {
		const muted = await pushHarness(modules);
		const mutedMail = await setup(muted, { thread: { mutedAt: Date.now() } });
		expect(await prepareRuleNotify(muted, mutedMail.messageId)).toEqual([]);

		const quiet = await pushHarness(modules);
		const quietMail = await setup(quiet);
		await setSettings(quiet, { quietHours: quietWindowAroundNow(), notifyAbout: 'nothing' });
		expect(await prepareRuleNotify(quiet, quietMail.messageId)).toEqual([]);
		const device = await quiet.run((ctx) => ctx.db.get(quietMail.deviceId));
		expect(device?.quietDeferredCount).toBe(1);
	});

	it('keeps notifications private when previews are hidden', async () => {
		const t = await pushHarness(modules);
		const { messageId } = await setup(t);
		await setSettings(t, { isHidePreviewOn: true });
		const [delivery] = await prepareRuleNotify(t, messageId);
		expect(delivery!.payload.title).toBe('New mail');
		expect(JSON.stringify(delivery!.payload)).not.toContain('Alice');
	});
});
