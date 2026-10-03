/**
 * Web Push devices, as the person managing them sees them: Preferences → This
 * device lists every browser and installed app that notifies them, turns this
 * one on or off, sends a test, and holds the "private notifications" switch.
 *
 * Every function is self-scoped to the session user. The device keys never
 * leave the backend: `status` returns labels and timestamps only, and tells the
 * caller which row is the browser asking by comparing the endpoint it sends
 * rather than by returning any endpoint.
 *
 * The private switch is the same `mailUserSettings.isHidePreviewOn` the
 * desktop's "Hide message preview" writes, so one preference governs both.
 */

import { v } from 'convex/values';
import { isValidTimeZone } from '@owlat/shared/notificationRules';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { authedMutation, authedQuery } from '../lib/authedFunctions';
import { base64UrlToBytes } from '../lib/bytes';
import { validateOutboundUrl } from '../lib/outboundUrlValidation';
import { rateLimiter } from '../lib/rateLimiter';
import {
	throwInvalidInput,
	throwInvalidState,
	throwNotFound,
	throwRateLimited,
} from '../_utils/errors';
import { vapidPublicKey } from './config';
import { MAX_DEVICES_PER_USER } from './dispatch';

/** Push service URLs are a few hundred characters; anything far beyond is not one. */
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_LABEL_LENGTH = 80;
const MAX_TIME_ZONE_LENGTH = 64;

/** Decoded length of a base64url value, or -1 when it is not base64url at all. */
function decodedLength(value: string): number {
	if (value.length > 200 || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return -1;
	try {
		return base64UrlToBytes(value.replace(/=+$/, '')).length;
	} catch {
		return -1;
	}
}

function validateSubscription(args: { endpoint: string; p256dh: string; auth: string }): void {
	if (args.endpoint.length > MAX_ENDPOINT_LENGTH) throwInvalidInput('Push endpoint is too long');
	// The endpoint is fetched server-side later, so it gets the same write-time
	// shape check as any outbound URL a member supplies: https, no credentials,
	// no literal private address. The sender re-checks DNS at connect time.
	const check = validateOutboundUrl(args.endpoint, { requirePublic: true });
	if (!check.ok) throwInvalidInput(`Push endpoint ${check.error}`);
	if (decodedLength(args.p256dh) !== 65) throwInvalidInput('Push key is not a P-256 public key');
	if (decodedLength(args.auth) !== 16) throwInvalidInput('Push auth secret must be 16 bytes');
}

async function loadDevices(ctx: { db: MutationCtx['db'] }, userId: string) {
	return ctx.db
		.query('pushSubscriptions')
		.withIndex('by_user', (q) => q.eq('userId', userId))
		.take(MAX_DEVICES_PER_USER + 1);
}

/**
 * Whether push is set up here, the key the browser subscribes with, the
 * private switch, and this person's devices. `endpoint` is the asking
 * browser's own subscription endpoint, when it has one, so its row can be
 * marked "this device".
 */
// all-members: every member reads only their own devices (keyed by session.userId).
export const status = authedQuery({
	args: { endpoint: v.optional(v.string()) },
	handler: async (ctx, args, session) => {
		const publicKey = vapidPublicKey();
		if (!publicKey) {
			return { isConfigured: false as const, publicKey: null, isPrivate: false, devices: [] };
		}
		const rows = await ctx.db
			.query('pushSubscriptions')
			.withIndex('by_user', (q) => q.eq('userId', session.userId))
			.take(MAX_DEVICES_PER_USER);
		const settings = await ctx.db
			.query('mailUserSettings')
			.withIndex('by_user', (q) => q.eq('userId', session.userId))
			.first();
		return {
			isConfigured: true as const,
			publicKey,
			isPrivate: settings?.isHidePreviewOn === true,
			devices: rows
				.map((row) => ({
					id: row._id,
					label: row.label,
					createdAt: row.createdAt,
					lastSuccessAt: row.lastSuccessAt ?? null,
					isCurrent: args.endpoint !== undefined && row.endpoint === args.endpoint,
				}))
				.sort((a, b) => b.createdAt - a.createdAt),
		};
	},
});

/**
 * Register (or refresh) this browser's subscription. An endpoint already on
 * file is updated in place and moves to the caller: a browser profile shared
 * by two people notifies whoever turned it on last. At the device cap the
 * longest-silent device is dropped to make room — those are browsers that were
 * reinstalled or cleared and never told us.
 */
// all-members: a member registers only their own device (self-scoped by session.userId).
export const subscribe = authedMutation({
	args: {
		endpoint: v.string(),
		p256dh: v.string(),
		auth: v.string(),
		label: v.string(),
		timeZone: v.optional(v.string()),
	},
	handler: async (ctx, args, session): Promise<Id<'pushSubscriptions'>> => {
		if (!vapidPublicKey()) throwInvalidState('Push notifications are not set up on this server');
		validateSubscription(args);
		const label = args.label.trim().slice(0, MAX_LABEL_LENGTH) || 'Browser';
		const timeZone =
			args.timeZone &&
			args.timeZone.length <= MAX_TIME_ZONE_LENGTH &&
			isValidTimeZone(args.timeZone)
				? args.timeZone
				: undefined;
		const fields = { p256dh: args.p256dh, auth: args.auth, label, timeZone };

		const existing = await ctx.db
			.query('pushSubscriptions')
			.withIndex('by_endpoint', (q) => q.eq('endpoint', args.endpoint))
			.first();
		if (existing) {
			const changedOwner = existing.userId !== session.userId;
			await ctx.db.patch(existing._id, {
				...fields,
				userId: session.userId,
				// A quiet-hours count belongs to the person it was held for.
				...(changedOwner ? { quietDeferredCount: undefined, quietSummaryAt: undefined } : {}),
			});
			return existing._id;
		}

		const devices = await loadDevices(ctx, session.userId);
		if (devices.length >= MAX_DEVICES_PER_USER) {
			const stalest = devices.reduce((a: Doc<'pushSubscriptions'>, b) =>
				(b.lastSuccessAt ?? b.createdAt) < (a.lastSuccessAt ?? a.createdAt) ? b : a
			);
			await ctx.db.delete(stalest._id);
		}
		return ctx.db.insert('pushSubscriptions', {
			...fields,
			userId: session.userId,
			endpoint: args.endpoint,
			createdAt: Date.now(),
		});
	},
});

/**
 * Forget a device: by id from the device list, or by endpoint when this
 * browser turns its own notifications off. Unknown or someone else's → no-op.
 */
// all-members: a member removes only their own devices (row.userId must equal session.userId).
export const remove = authedMutation({
	args: {
		subscriptionId: v.optional(v.id('pushSubscriptions')),
		endpoint: v.optional(v.string()),
	},
	handler: async (ctx, args, session): Promise<{ removed: boolean }> => {
		const row = args.subscriptionId
			? await ctx.db.get(args.subscriptionId)
			: args.endpoint && args.endpoint.length <= MAX_ENDPOINT_LENGTH
				? await ctx.db
						.query('pushSubscriptions')
						.withIndex('by_endpoint', (q) => q.eq('endpoint', args.endpoint as string))
						.first()
				: null;
		if (!row || row.userId !== session.userId) return { removed: false };
		await ctx.db.delete(row._id);
		return { removed: true };
	},
});

/**
 * "Private notifications": pushes say only "New mail" / "New chat message".
 * Writes the shared hide-preview preference, creating the settings row with
 * its one required default when this person never had one.
 */
// all-members: a member sets only their own preference (self-scoped by session.userId).
export const setPrivate = authedMutation({
	args: { isPrivate: v.boolean() },
	handler: async (ctx, args, session) => {
		const now = Date.now();
		const row = await ctx.db
			.query('mailUserSettings')
			.withIndex('by_user', (q) => q.eq('userId', session.userId))
			.first();
		if (row) {
			await ctx.db.patch(row._id, { isHidePreviewOn: args.isPrivate, updatedAt: now });
			return;
		}
		await ctx.db.insert('mailUserSettings', {
			userId: session.userId,
			autoAdvance: 'next',
			isHidePreviewOn: args.isPrivate,
			createdAt: now,
			updatedAt: now,
		});
	},
});

/** Push a test notification to one of the caller's devices. */
// all-members: a member tests only their own device (row.userId must equal session.userId).
export const sendTest = authedMutation({
	args: { subscriptionId: v.id('pushSubscriptions') },
	handler: async (ctx, args, session) => {
		if (!vapidPublicKey()) throwInvalidState('Push notifications are not set up on this server');
		const row = await ctx.db.get(args.subscriptionId);
		if (!row || row.userId !== session.userId) throwNotFound('Device');
		const limit = await rateLimiter.limit(ctx, 'pushTestPerUser', { key: session.userId });
		if (!limit.ok) throwRateLimited('Too many test notifications', limit.retryAfter);
		await ctx.scheduler.runAfter(0, internal.push.send.deliver, {
			userId: session.userId,
			event: { kind: 'test', subscriptionId: args.subscriptionId },
		});
	},
});
