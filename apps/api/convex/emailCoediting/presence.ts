/**
 * Email editor presence and edit leases (docs/adr/0071-email-coediting.md).
 *
 * Every open editor tab heartbeats here with a random `clientId`, the root
 * block it has selected (others see a coloured outline with the name) and,
 * while it is editing a block, a lease on that block. Others cannot select or
 * edit a leased block until the lease runs out (`COEDIT_LEASE_TTL_MS` after
 * the last heartbeat) or the tab lets go. Leases are advisory: the server
 * still accepts a write to a leased block (an offline tab, a race), and
 * last-writer-wins with a notice covers that (`sessions.ts`).
 *
 * Modelled on shared-inbox thread presence (inbox/presence.ts). Like it, a
 * heartbeat records no audit-log entry. The sweep (`sweep.ts`) deletes rows
 * past the active window.
 */

import { v } from 'convex/values';
import { throwForbidden, throwInvalidInput } from '../_utils/errors';
import { authedMutation, authedQuery } from '../lib/authedFunctions';
import { assertFeatureEnabled } from '../lib/featureFlags';
import { hasPermission } from '../lib/sessionOrganization';
import { coeditTargetValidator } from '../lib/validators/coediting';
import { MAX_COEDIT_ID_LENGTH } from './sessionOps';
import { COEDIT_LEASE_TTL_MS, activePresence, loadTarget, targetFields } from './target';

const optionalBlockId = v.optional(v.union(v.string(), v.null()));

function checkLength(value: string | null | undefined, what: string): void {
	if (value && value.length > MAX_COEDIT_ID_LENGTH) throwInvalidInput(`The ${what} is not valid.`);
}

/**
 * Record that this tab has the email open, what it has selected, and the
 * block it wants to edit. Returns whether the lease is held; when someone
 * else holds that block, their user id.
 *
 * Only members who may edit emails (`templates:manage`) get a lease; any
 * member may show as present.
 */
// all-members: presence is a signal every member with the email open sends; the lease is gated below
export const heartbeat = authedMutation({
	args: {
		target: coeditTargetValidator,
		clientId: v.string(),
		selectedBlockId: optionalBlockId,
		leaseBlockId: optionalBlockId,
	},
	handler: async (ctx, args, session) => {
		if (args.clientId.length === 0) throwInvalidInput('The editor id is not valid.');
		checkLength(args.clientId, 'editor id');
		checkLength(args.selectedBlockId, 'block id');
		checkLength(args.leaseBlockId, 'block id');
		await loadTarget(ctx, args.target);

		const now = Date.now();
		const own = await ctx.db
			.query('emailEditorPresence')
			.withIndex('by_client', (q) => q.eq('clientId', args.clientId))
			.first();
		if (own && own.userId !== session.userId)
			throwForbidden('This editor belongs to someone else.');

		let leaseBlockId: string | undefined =
			hasPermission(session.role, 'templates:manage') && args.leaseBlockId
				? args.leaseBlockId
				: undefined;
		let heldBy: string | null = null;
		if (leaseBlockId) {
			const holder = (await activePresence(ctx, args.target, now)).find(
				(row) =>
					row.clientId !== args.clientId &&
					row.leaseBlockId === leaseBlockId &&
					(row.leaseExpiresAt ?? 0) > now
			);
			if (holder) {
				heldBy = holder.userId;
				leaseBlockId = undefined;
			}
		}

		const row = {
			...targetFields(args.target),
			userId: session.userId,
			clientId: args.clientId,
			heartbeatAt: now,
			selectedBlockId: args.selectedBlockId ?? undefined,
			leaseBlockId,
			leaseExpiresAt: leaseBlockId ? now + COEDIT_LEASE_TTL_MS : undefined,
		};
		if (own) {
			// `replace` drops the other target's id when the tab moved emails.
			await ctx.db.replace(own._id, row);
		} else {
			await ctx.db.insert('emailEditorPresence', row);
		}
		return { isLeaseHeld: leaseBlockId !== undefined, heldBy };
	},
});

/** The tab closed the editor: drop its presence and any lease at once. */
// authz: a tab can only remove its own row (user id checked below)
export const leave = authedMutation({
	args: { clientId: v.string() },
	handler: async (ctx, args, session) => {
		checkLength(args.clientId, 'editor id');
		const own = await ctx.db
			.query('emailEditorPresence')
			.withIndex('by_client', (q) => q.eq('clientId', args.clientId))
			.first();
		if (own && own.userId === session.userId) await ctx.db.delete(own._id);
		return null;
	},
});

/**
 * Everyone with the email open, including the caller's own tabs (the client
 * filters itself out by `clientId`). `now` is the server clock, so a client
 * can tell when a lease or a heartbeat has run out without trusting its own.
 */
// all-members: who is editing an email is visible to every member who can open it
export const list = authedQuery({
	args: { target: coeditTargetValidator },
	handler: async (ctx, args) => {
		if (args.target.type === 'transactionalEmail') {
			await assertFeatureEnabled(ctx, 'transactional');
		}
		const now = Date.now();
		const rows = await activePresence(ctx, args.target, now);
		return {
			now,
			people: rows.map((row) => ({
				clientId: row.clientId,
				userId: row.userId,
				heartbeatAt: row.heartbeatAt,
				selectedBlockId: row.selectedBlockId ?? null,
				leaseBlockId: row.leaseBlockId ?? null,
				leaseExpiresAt: row.leaseExpiresAt ?? null,
			})),
		};
	},
});
