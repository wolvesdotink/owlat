/**
 * Campaign wizard, setup step — the pure pieces behind "never dead-end the
 * wizard" (#785): what is still missing before Next can work, who to ask for
 * a sender, and the single recipients picker's option values. No Vue, no
 * Convex: unit-tested directly.
 */

/** A setup requirement that is not met yet, in the order the form asks for it. */
export type MissingSetupItem = 'name' | 'sender' | 'recipients';

export function missingSetupItems(state: {
	hasName: boolean;
	senderReady: boolean;
	hasRecipients: boolean;
}): MissingSetupItem[] {
	const missing: MissingSetupItem[] = [];
	if (!state.hasName) missing.push('name');
	if (!state.senderReady) missing.push('sender');
	if (!state.hasRecipients) missing.push('recipients');
	return missing;
}

/** Join already-translated phrases into one list ("a, b and c"). */
export function joinList(
	items: readonly string[],
	locale: string,
	type: 'conjunction' | 'disjunction' = 'conjunction'
): string {
	try {
		return new Intl.ListFormat(locale, { style: 'long', type }).format(items);
	} catch {
		return items.join(', ');
	}
}

/** The member fields the admin lookup reads. */
interface MemberLike {
	role: string;
	user: { name?: string | null; email: string };
}

/** Name at most this many admins; the rest of the workspace knows who they are. */
const MAX_NAMED_ADMINS = 3;

/**
 * "Anna Weber or Ben Ito" — the owners and admins a member can ask to add a
 * campaign sender, owners first. Null when none are known (members still
 * loading, or the list failed), so the caller falls back to generic copy.
 */
export function adminDisplayNames(members: readonly MemberLike[], locale: string): string | null {
	const rank = (role: string) => (role === 'owner' ? 0 : 1);
	const names = members
		.filter((m) => m.role === 'owner' || m.role === 'admin')
		.sort((a, b) => rank(a.role) - rank(b.role))
		.map((m) => m.user.name?.trim() || m.user.email)
		.filter((name, index, all) => name && all.indexOf(name) === index)
		.slice(0, MAX_NAMED_ADMINS);
	if (names.length === 0) return null;
	return joinList(names, locale, 'disjunction');
}

/**
 * The recipients picker is ONE select holding topics and segments, so its
 * value carries the kind: `topic:<id>` / `segment:<id>`.
 */
export type AudienceKind = 'topic' | 'segment';

export function encodeAudienceValue(kind: AudienceKind, id: string): string {
	return `${kind}:${id}`;
}

export function decodeAudienceValue(value: string | null | undefined): {
	kind: AudienceKind;
	id: string;
} | null {
	if (!value) return null;
	const separator = value.indexOf(':');
	if (separator <= 0) return null;
	const kind = value.slice(0, separator);
	const id = value.slice(separator + 1);
	if ((kind !== 'topic' && kind !== 'segment') || !id) return null;
	return { kind, id };
}
