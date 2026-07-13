/**
 * Shared chip/icon tone classes for the Sealed-Mail trust surfaces (E5). ONE
 * table keyed by tone so the composer seal-lock and the reader's sealed badge
 * render identical `ok`/`warn` chips — they used to carry duplicate maps that
 * could drift apart. FF tokens only (no hardcoded hex/shadow), so both light and
 * dark themes track the token system.
 */

/**
 * Visual tones a seal surface renders in:
 *   - `ok`    — a positive, verified/sealed state (success token);
 *   - `warn`  — attention needed (a key change, an unverified signature);
 *   - `muted` — neutral / won't-seal (the composer's cannotSeal state).
 */
export type SealTone = 'ok' | 'warn' | 'muted';

/** Chip border/text + icon classes for each tone. */
export const SEAL_TONE_CLASSES: Record<SealTone, { chip: string; icon: string }> = {
	ok: { chip: 'border-success/40 text-success', icon: 'text-success' },
	warn: { chip: 'border-warning/40 text-warning', icon: 'text-warning' },
	muted: { chip: 'border-border-subtle text-text-secondary', icon: 'text-text-tertiary' },
};
