/**
 * Pure helpers for the member-group admin UI on the Team page: the name rules
 * the backend enforces (apps/api/convex/tasks/groups.ts), checked here first
 * so a refusal reads in the viewer's language, and the roster lookups the
 * group cards and the member picker share.
 */

/** Mirrors `MAX_NAME_LENGTH` in tasks/groups.ts; the server refuses longer names. */
export const GROUP_NAME_MAX_LENGTH = 60;

export type GroupNameProblem = 'empty' | 'tooLong' | 'taken';

/** The roster fields these helpers read; `OrganizationMember` satisfies it. */
export interface GroupRosterMember {
	userId: string;
	user: { name: string; email: string; image?: string | null };
}

/** The same cleanup the server applies before it stores a name. */
export function normalizeGroupName(raw: string): string {
	return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Why `raw` cannot be saved as a group name, or null when it can. Names are
 * unique case-insensitively; `exceptId` is the group being renamed, which may
 * keep its own name.
 */
export function groupNameProblem(
	raw: string,
	groups: readonly { _id: string; name: string }[],
	exceptId?: string | null
): GroupNameProblem | null {
	const name = normalizeGroupName(raw);
	if (!name) return 'empty';
	if (name.length > GROUP_NAME_MAX_LENGTH) return 'tooLong';
	const lower = name.toLowerCase();
	if (groups.some((group) => group._id !== exceptId && group.name.toLowerCase() === lower)) {
		return 'taken';
	}
	return null;
}

/** Who joins and who leaves when a group's members change from `before` to `after`. */
export function memberDiff(
	before: readonly string[],
	after: readonly string[]
): { added: string[]; removed: string[] } {
	const was = new Set(before);
	const now = new Set(after);
	return {
		added: [...now].filter((id) => !was.has(id)),
		removed: [...was].filter((id) => !now.has(id)),
	};
}

/**
 * A group's members as roster entries, in roster order. A member id the roster
 * no longer holds (someone who left the workspace) is counted in `unknown`
 * rather than dropped, so the count on a card matches who the server lists.
 */
export function groupMembersFromRoster<M extends GroupRosterMember>(
	memberUserIds: readonly string[],
	roster: readonly M[]
): { members: M[]; unknown: number } {
	const ids = new Set(memberUserIds);
	const members = roster.filter((member) => ids.has(member.userId));
	return { members, unknown: ids.size - members.length };
}

/** Roster entries whose name or email contains `query`, case-insensitively. */
export function filterRoster<M extends GroupRosterMember>(
	roster: readonly M[],
	query: string
): M[] {
	const q = query.trim().toLowerCase();
	if (!q) return [...roster];
	return roster.filter(
		(member) =>
			member.user.name.toLowerCase().includes(q) || member.user.email.toLowerCase().includes(q)
	);
}
