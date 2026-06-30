/**
 * Shared internal helpers for the chat module.
 *
 * - Membership / per-room admin checks
 * - Normalization helpers for channel names and DM identity keys
 * - Mention parsing
 *
 * Not exported as Convex functions; only imported by sibling chat/*.ts.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx, MutationCtx } from '../_generated/server';
import { throwForbidden, throwNotFound, throwInvalidInput } from '../_utils/errors';
import { hasPermission, type OrganizationRole } from '../lib/sessionOrganization';

export const CHANNEL_NAME_MAX = 80;
export const CHANNEL_DESC_MAX = 280;
export const MESSAGE_TEXT_MAX = 8000;
export const MENTION_PATTERN = /@([a-zA-Z0-9_\-.]{1,64})/g;

/**
 * Reserved author id for AI assistant replies (`@assistant`). It is NOT a valid
 * BetterAuth user id (the colon never appears in one), so it can never collide
 * with a real member, a real member can never author "as the assistant", and
 * `loadProfileSummary` simply returns null fields for it (the renderer labels
 * it "Assistant"). Only `assistant/runner.ts` inserts messages under this id,
 * via internal mutations that bypass the membership write floor.
 */
export const ASSISTANT_AUTHOR_ID = 'system:assistant';

/** The reserved @-handle that invokes the AI assistant in a room. */
export const ASSISTANT_MENTION_HANDLE = 'assistant';
/** Hard cap on how many people one membership-write call may touch. */
export const CHAT_MEMBER_BATCH_MAX = 50;

/**
 * Validate that every supplied auth-user id maps to a real instance user, and
 * that the batch isn't oversized. DM/channel membership-write mutations take
 * free-form id strings; without this a caller could seed a chat room with bogus
 * or foreign ids, or pass an unbounded array. We resolve against
 * `userProfiles.by_auth_user_id` — the same participant source of truth the
 * chat module already uses (loadProfileSummary, DM label assembly) — which a
 * bogus id can never satisfy. (Single-org: a profile row ⇒ a user of this
 * deployment; the caller's own membership floor is enforced upstream.)
 */
export async function assertChatTargetsAreOrgMembers(
	ctx: QueryCtx | MutationCtx,
	authUserIds: string[],
): Promise<void> {
	if (authUserIds.length > CHAT_MEMBER_BATCH_MAX) {
		throwInvalidInput(`Cannot add more than ${CHAT_MEMBER_BATCH_MAX} people at once`);
	}
	for (const id of new Set(authUserIds)) {
		const profile = await ctx.db
			.query('userProfiles')
			.withIndex('by_auth_user_id', (q) => q.eq('authUserId', id))
			.first();
		if (!profile) {
			throwInvalidInput('One or more selected people are not members of this organization');
		}
	}
}

/** Normalize a channel name for uniqueness/lookup. */
export function normalizeChannelName(name: string): string {
	return name.trim().toLowerCase();
}

/**
 * Sort + comma-join member IDs to produce a canonical identity key for a DM.
 * Two `findOrCreateDm` calls with the same participants resolve to the same
 * `chatRooms` row via the `by_kind_and_normalized_name` index.
 */
export function normalizeDmKey(memberIds: string[]): string {
	return [...new Set(memberIds)].sort().join(',');
}

/**
 * Load a chat room or throw NOT_FOUND. Does not check membership.
 */
export async function getRoomOrThrow(
	ctx: QueryCtx | MutationCtx,
	roomId: Id<'chatRooms'>,
): Promise<Doc<'chatRooms'>> {
	const room = await ctx.db.get(roomId);
	if (!room) {
		throwNotFound('Chat room');
	}
	return room;
}

/**
 * Fetch the caller's membership in a room (or undefined if not a member).
 */
export async function getMembership(
	ctx: QueryCtx | MutationCtx,
	roomId: Id<'chatRooms'>,
	memberId: string,
): Promise<Doc<'chatRoomMembers'> | null> {
	return await ctx.db
		.query('chatRoomMembers')
		.withIndex('by_room_and_member', (q) =>
			q.eq('roomId', roomId).eq('memberId', memberId),
		)
		.first();
}

/**
 * Assert the caller can READ a room.
 *
 * Public channels: any authenticated org member can browse.
 * Private channels + DMs: must be a member.
 */
export async function assertCanReadRoom(
	ctx: QueryCtx | MutationCtx,
	room: Doc<'chatRooms'>,
	memberId: string,
): Promise<void> {
	if (room.kind === 'channel' && room.visibility === 'public') {
		return;
	}
	const membership = await getMembership(ctx, room._id, memberId);
	if (!membership) {
		throwForbidden('You do not have access to this room');
	}
}

/**
 * Assert the caller can WRITE in a room (post messages, mark read).
 *
 * Even public channels require membership to write — readers have to join
 * first. DMs and private channels require participation.
 */
export async function assertCanWriteRoom(
	ctx: QueryCtx | MutationCtx,
	roomId: Id<'chatRooms'>,
	memberId: string,
): Promise<Doc<'chatRoomMembers'>> {
	const membership = await getMembership(ctx, roomId, memberId);
	if (!membership) {
		throwForbidden('Join the room before posting');
	}
	return membership;
}

/**
 * Assert the caller can ADMINISTER a room (rename, archive, manage members,
 * link/unlink email thread).
 *
 * Path 1: the caller is a per-room admin (`chatRoomMembers.role === 'admin'`).
 * Path 2: the caller has the org-level `chat:manage` permission (escape hatch
 * for owners/admins to govern channels they didn't create).
 */
export async function assertCanAdministerRoom(
	ctx: QueryCtx | MutationCtx,
	room: Doc<'chatRooms'>,
	memberId: string,
	orgRole: OrganizationRole,
): Promise<void> {
	if (hasPermission(orgRole, 'chat:manage')) {
		return;
	}
	const membership = await getMembership(ctx, room._id, memberId);
	if (membership?.role === 'admin') {
		return;
	}
	throwForbidden('Only room admins can perform this action');
}

/**
 * Projection of a chat participant's `userProfiles` row used by message,
 * member, and DM listings. All fields default to `null` when the profile
 * row is missing.
 */
export type ProfileSummary = {
	name: string | null;
	email: string | null;
	image: string | null;
};

/**
 * Load the `{ name, email, image }` summary for a chat participant via the
 * `userProfiles.by_auth_user_id` index. Returns null-filled fields when no
 * profile row exists for the given auth user.
 */
export async function loadProfileSummary(
	ctx: QueryCtx | MutationCtx,
	authUserId: string,
): Promise<ProfileSummary> {
	const row = await ctx.db
		.query('userProfiles')
		.withIndex('by_auth_user_id', (q) => q.eq('authUserId', authUserId))
		.first();
	return {
		name: row?.name ?? null,
		email: row?.email ?? null,
		image: row?.image ?? null,
	};
}

/**
 * Parse `@handle` mentions from message text.
 *
 * Returns unique handles (no leading `@`). Resolution to memberIds happens
 * downstream in `mentions.ts::resolveMentionsToMemberIds`.
 */
export function parseMentionHandles(text: string): string[] {
	const found = new Set<string>();
	for (const match of text.matchAll(MENTION_PATTERN)) {
		const handle = match[1]?.trim();
		if (handle) found.add(handle.toLowerCase());
	}
	return [...found];
}

/** Whether a message invokes the AI assistant via the reserved `@assistant` handle. */
export function isAssistantInvoked(text: string): boolean {
	return parseMentionHandles(text).includes(ASSISTANT_MENTION_HANDLE);
}

/** Validate and trim a channel name; throws on empty / oversize. */
export function requireChannelName(raw: string): string {
	const name = raw.trim();
	if (!name) throwInvalidInput('Channel name cannot be empty');
	if (name.length > CHANNEL_NAME_MAX) {
		throwInvalidInput(`Channel name must be ${CHANNEL_NAME_MAX} characters or fewer`);
	}
	return name;
}

/** Validate and trim message text; throws on empty / oversize. */
export function requireMessageText(raw: string): string {
	const text = raw.trim();
	if (!text) throwInvalidInput('Message cannot be empty');
	if (text.length > MESSAGE_TEXT_MAX) {
		throwInvalidInput(`Message exceeds maximum length of ${MESSAGE_TEXT_MAX} characters`);
	}
	return text;
}
