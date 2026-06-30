/**
 * Direct message (DM) operations.
 *
 * DMs are `chatRooms` with `kind = 'dm'`. The participant list is the
 * canonical identity — `normalizedName` carries a sorted-comma key of all
 * participant memberIds so we can deduplicate "DM with the same people" via
 * the `by_kind_and_normalized_name` index.
 */

import { v } from 'convex/values';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import {
	getMutationContext,
	getUserIdFromSession,
	requirePermission,
	hasPermission,
} from '../lib/sessionOrganization';
import { assertFeatureEnabled } from '../lib/featureFlags';
import { throwInvalidInput } from '../_utils/errors';
import { assertChatTargetsAreOrgMembers, loadProfileSummary, normalizeDmKey } from './_helpers';

/**
 * Find or create a DM between the caller and `otherMemberIds`. Idempotent —
 * resolves to the same room every time for the same participant set.
 *
 * - The caller is always implicitly included.
 * - The caller + every other participant becomes a 'member' role row in
 *   chatRoomMembers (DMs have no 'admin' concept beyond who created them).
 * - For a 1:1 DM, `name` becomes a short label like "Alice Smith". For group
 *   DMs, "Alice, Bob, Carol" up to 3 names + a "+N more" suffix. This is
 *   denormalized and refreshed by the frontend if displayed.
 */
export const findOrCreateDm = authedMutation({
	args: { otherMemberIds: v.array(v.string()) },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'chat');
		const { userId, role } = await getMutationContext(ctx);
		requirePermission(hasPermission(role, 'chat:participate'), 'Chat is not available');

		if (args.otherMemberIds.length === 0) {
			throwInvalidInput('Pick at least one other person for a DM');
		}
		if (args.otherMemberIds.some((id) => id === userId)) {
			throwInvalidInput('Cannot start a DM with yourself');
		}
		await assertChatTargetsAreOrgMembers(ctx, args.otherMemberIds);

		const participantIds = [...new Set([userId, ...args.otherMemberIds])];
		const normalizedName = normalizeDmKey(participantIds);

		const existing = await ctx.db
			.query('chatRooms')
			.withIndex('by_kind_and_normalized_name', (q) =>
				q.eq('kind', 'dm').eq('normalizedName', normalizedName),
			)
			.first();
		if (existing) return existing._id;

		// Label assembly: small loop, profile table is bounded by org size.
		const names: string[] = [];
		for (const otherId of args.otherMemberIds) {
			const profile = await ctx.db
				.query('userProfiles')
				.withIndex('by_auth_user_id', (q) => q.eq('authUserId', otherId))
				.first();
			names.push(profile?.name ?? profile?.email ?? otherId);
		}
		const previewNames = names.slice(0, 3).join(', ');
		const label =
			names.length <= 3 ? previewNames : `${previewNames} +${names.length - 3} more`;

		const now = Date.now();
		const roomId = await ctx.db.insert('chatRooms', {
			kind: 'dm',
			name: label,
			normalizedName,
			visibility: 'private',
			createdBy: userId,
			createdAt: now,
			updatedAt: now,
			lastMessageAt: now,
			messageCount: 0,
		});

		for (const participantId of participantIds) {
			await ctx.db.insert('chatRoomMembers', {
				roomId,
				memberId: participantId,
				role: 'member',
				joinedAt: now,
				lastReadAt: now,
			});
		}

		return roomId;
	},
});

/**
 * List DMs the caller participates in, most recently active first.
 * Each row includes the other participants' names for the sidebar label.
 */
export const listMyDms = authedQuery({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'chat');
		const userId = await getUserIdFromSession(ctx);
		const limit = Math.max(1, Math.min(args.limit ?? 100, 500));

		const memberships = await ctx.db
			.query('chatRoomMembers')
			.withIndex('by_member', (q) => q.eq('memberId', userId))
			.collect(); // bounded: caller's chat rooms (~tens)

		const dms = [];
		for (const membership of memberships) {
			const room = await ctx.db.get(membership.roomId);
			if (!room || room.kind !== 'dm' || room.archivedAt) continue;

			// Other participants (excluding the caller) for the label.
			const allMembers = await ctx.db
				.query('chatRoomMembers')
				.withIndex('by_room', (q) => q.eq('roomId', room._id))
				.collect(); // bounded: members of a single DM (1:1 or small group, ~tens max)
			const otherMembers = allMembers.filter((m) => m.memberId !== userId);

			const otherProfiles = [];
			for (const m of otherMembers) {
				const profile = await loadProfileSummary(ctx, m.memberId);
				otherProfiles.push({
					memberId: m.memberId,
					...profile,
				});
			}

			dms.push({
				...room,
				otherParticipants: otherProfiles,
				myLastReadAt: membership.lastReadAt,
			});
		}

		dms.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
		return dms.slice(0, limit);
	},
});
