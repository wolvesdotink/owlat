/**
 * Shared avatar helpers used by <UiAvatar> and any call site that needs to
 * render a person's avatar (chat member lists, mention pickers, DM sidebar,
 * message rows, …).
 *
 * Keeping the initials + size-class logic here means the presentational
 * component stays trivial and the behaviour is unit-testable without mounting
 * an SFC.
 */

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg';
export type AvatarBg = 'surface' | 'elevated';

/**
 * Canonical avatar initials: the first two characters of the first available
 * identity string (name, then email), upper-cased. Falls back to `?` when no
 * identity is available.
 */
export function avatarInitials(name?: string | null, email?: string | null): string {
	return (name ?? email ?? '?').slice(0, 2).toUpperCase();
}

/** Diameter + text-size + text-colour classes per named size. */
export const AVATAR_SIZE_CLASSES: Record<AvatarSize, string> = {
	xs: 'w-5 h-5 text-[10px] text-text-tertiary',
	sm: 'w-6 h-6 text-[10px] text-text-tertiary',
	md: 'w-7 h-7 text-[10px] text-text-tertiary',
	lg: 'w-9 h-9 text-xs text-text-secondary',
};

/** Background class for the avatar circle. */
export const AVATAR_BG_CLASSES: Record<AvatarBg, string> = {
	surface: 'bg-bg-surface',
	elevated: 'bg-bg-elevated',
};

// ---------------------------------------------------------------------------
// Deterministic identity avatars (Postbox sender/recipient chips)
// ---------------------------------------------------------------------------

export type AvatarColorToken =
	| 'clay'
	| 'rust'
	| 'gold'
	| 'moss'
	| 'sage'
	| 'teal'
	| 'slate'
	| 'indigo'
	| 'plum'
	| 'mauve';

/**
 * Fixed accessible palette for deterministic identity avatars. Every token is
 * a self-contained chip (fixed background + fixed light foreground) so the
 * WCAG-AA contrast (all pairs >= 5.4:1) holds identically in the light and
 * dark themes. Rendered via inline style rather than utility classes so the
 * hex pairs stay a single source of truth here.
 */
export const AVATAR_COLOR_STYLES: Record<AvatarColorToken, { background: string; color: string }> = {
	clay: { background: '#8a4630', color: '#f5f1ea' },
	rust: { background: '#93412c', color: '#f5f1ea' },
	gold: { background: '#7a5a1e', color: '#f5f1ea' },
	moss: { background: '#4e6337', color: '#f5f1ea' },
	sage: { background: '#3f6b4f', color: '#f5f1ea' },
	teal: { background: '#2f6b66', color: '#f5f1ea' },
	slate: { background: '#3f6480', color: '#f5f1ea' },
	indigo: { background: '#4d5a8c', color: '#f5f1ea' },
	plum: { background: '#7a4a6d', color: '#f5f1ea' },
	mauve: { background: '#8c4a52', color: '#f5f1ea' },
};

export const AVATAR_COLOR_TOKENS = Object.keys(AVATAR_COLOR_STYLES) as AvatarColorToken[];

/** djb2-xor string hash — tiny, stable, good spread for short ASCII keys. */
function hashString(input: string): number {
	let hash = 5381;
	for (let i = 0; i < input.length; i++) {
		hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
	}
	return hash >>> 0;
}

/**
 * Initials for a mail identity: two letters from the display name's first two
 * words ("Ada Lovelace" -> "AL"), or — for a bare address — from the email
 * local part split on common separators ("jane.doe@x" -> "JD"). Single-word
 * identities fall back to the first two characters.
 */
function identityInitials(nameOrEmail: string): string {
	const trimmed = nameOrEmail.trim();
	if (!trimmed) return '?';
	// Bare email address: derive from the local part.
	const source = trimmed.includes('@') && !trimmed.includes(' ')
		? (trimmed.split('@')[0] ?? trimmed)
		: trimmed;
	const words = source.split(/[\s._+-]+/).filter((w) => w.length > 0);
	if (words.length === 0) return '?';
	if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
	return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
}

/**
 * Deterministic initials + palette color for a mail identity.
 *
 * - `initials` come from `nameOrEmail` (display name preferred by callers).
 * - `colorToken` hashes `opts.colorKey` when given (pass the EMAIL ADDRESS so
 *   the color stays stable when a sender's display name varies), otherwise
 *   `nameOrEmail`. Hash input is trimmed + lower-cased.
 */
export function initialsAndColorForAddress(
	nameOrEmail: string,
	opts?: { colorKey?: string }
): { initials: string; colorToken: AvatarColorToken } {
	const key = (opts?.colorKey ?? nameOrEmail).trim().toLowerCase();
	const token = AVATAR_COLOR_TOKENS[hashString(key) % AVATAR_COLOR_TOKENS.length]!;
	return { initials: identityInitials(nameOrEmail), colorToken: token };
}
