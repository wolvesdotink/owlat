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
