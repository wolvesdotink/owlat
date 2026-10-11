/**
 * Internal notes on Team Inbox threads: the pure parts of the composer and the
 * thread view.
 *
 *  - who the @-picker offers (Team Inbox readers, never yourself), with the
 *    handle the server resolves (`apps/api/convex/inbox/noteRules.ts`);
 *  - where an `@fragment` is being typed, and what picking a person writes.
 *
 * The `@handle` grammar is the chat one (`@owlat/shared/chatMentions`), so a
 * note mention reads and resolves the way a chat mention does.
 */

import { isMentionHandlePrefix } from '@owlat/shared/chatMentions';
import { hasPermission, type OrganizationRole } from '@owlat/shared/organizationPermissions';

/** Mirrors `NOTE_BODY_MAX_LENGTH` in apps/api/convex/inbox/noteRules.ts. */
export const NOTE_BODY_MAX_LENGTH = 5_000;

/** Most people the picker lists at once. */
const MAX_PICKER_CANDIDATES = 8;

/** A teammate as the picker shows them (the ChatMentionPicker shape). */
export interface NoteMentionCandidate {
	memberId: string;
	name: string | null;
	email: string | null;
	image: string | null;
	handle: string | null;
}

interface MemberLike {
	userId: string;
	role: OrganizationRole;
	user: { name?: string | null; email?: string | null; image?: string | null };
}

/** The handle a teammate is mentioned by: their email's local part, lowercased. */
export function mentionHandle(email: string | null | undefined): string | null {
	const local = (email ?? '').split('@')[0]?.toLowerCase() ?? '';
	return local || null;
}

/**
 * The teammates the @-picker offers for `query`: members who can read the Team
 * Inbox (the server would not resolve anyone else), minus the author, matched
 * on name or handle.
 */
export function noteMentionCandidates(
	members: readonly MemberLike[],
	currentUserId: string | null,
	query: string
): NoteMentionCandidate[] {
	const q = query.trim().toLowerCase();
	const out: NoteMentionCandidate[] = [];
	for (const member of members) {
		if (member.userId === currentUserId) continue;
		if (!hasPermission(member.role, 'organization:manage')) continue;
		const handle = mentionHandle(member.user.email);
		if (!handle) continue;
		const name = member.user.name?.trim() || null;
		if (q && !handle.includes(q) && !(name ?? '').toLowerCase().includes(q)) continue;
		out.push({
			memberId: member.userId,
			name,
			email: member.user.email ?? null,
			image: member.user.image ?? null,
			handle,
		});
		if (out.length >= MAX_PICKER_CANDIDATES) break;
	}
	return out;
}

/**
 * The `@fragment` being typed at `caret`, or null. The `@` must start the text
 * or follow whitespace, and the fragment must still be able to become a
 * handle (the same rule the chat composer applies).
 */
export function activeMentionQuery(
	text: string,
	caret: number
): { start: number; fragment: string } | null {
	const before = text.slice(0, caret);
	const at = before.lastIndexOf('@');
	if (at < 0) return null;
	const charBefore = at === 0 ? ' ' : before[at - 1];
	if (charBefore && !/\s/.test(charBefore)) return null;
	const fragment = before.slice(at + 1);
	if (!isMentionHandlePrefix(fragment)) return null;
	return { start: at, fragment };
}

/** The text after picking `handle` for the `@fragment` at `start`, and the new caret. */
export function insertMention(
	text: string,
	start: number,
	caret: number,
	handle: string
): { text: string; caret: number } {
	const before = `${text.slice(0, start)}@${handle} `;
	return { text: before + text.slice(caret), caret: before.length };
}
