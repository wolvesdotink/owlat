/**
 * When an opened conversation loses its unread flags (Postbox reader).
 *
 *   - 'immediate'   → mark on render. The behaviour the reader has always had,
 *                     and what an unset preference resolves to.
 *   - 'after-dwell' → mark once the thread has been visibly open for
 *                     {@link POSTBOX_MARK_READ_DWELL_MS}; navigating away or
 *                     closing the reader first cancels it, so a mis-click or a
 *                     j/k skim past a row never burns the unread flag.
 *   - 'manual'      → never automatic. The reader shows an explicit mark-read
 *                     affordance instead.
 *
 * Pure derivations only — the timer itself lives in the reader, which owns the
 * lifecycle hooks. Everything decidable without a component is decided here so
 * the policy is unit-testable without mounting a Convex-backed reader.
 */

export type PostboxMarkReadPolicy = 'immediate' | 'after-dwell' | 'manual';

export const POSTBOX_MARK_READ_POLICY_DEFAULT: PostboxMarkReadPolicy = 'immediate';

/** How long 'after-dwell' waits before marking the open thread read. */
export const POSTBOX_MARK_READ_DWELL_MS = 2000;

/** Normalise a stored/unknown value to a valid policy, defaulting safely. */
export function resolvePostboxMarkReadPolicy(
	value: string | undefined | null
): PostboxMarkReadPolicy {
	return value === 'after-dwell' || value === 'manual' ? value : POSTBOX_MARK_READ_POLICY_DEFAULT;
}

/**
 * The picker options. Module scope never calls `useI18n`, so `label` is the
 * catalog key the settings screen renders through `t()`.
 */
export const POSTBOX_MARK_READ_POLICY_OPTIONS: Array<{
	value: PostboxMarkReadPolicy;
	label: string;
}> = [
	{ value: 'immediate', label: 'shared.postboxMarkReadPolicy.immediate' },
	{ value: 'after-dwell', label: 'shared.postboxMarkReadPolicy.afterDwell' },
	{ value: 'manual', label: 'shared.postboxMarkReadPolicy.manual' },
];

/**
 * What the reader should do the moment an unread thread renders.
 *
 *   - 'now'    → fire the mark-read mutation immediately ('immediate')
 *   - 'defer'  → arm the dwell timer, cancelling it on navigate-away
 *                ('after-dwell')
 *   - 'never'  → do nothing; the user marks it read themselves ('manual')
 */
export function markReadOnOpen(policy: PostboxMarkReadPolicy): 'now' | 'defer' | 'never' {
	if (policy === 'manual') return 'never';
	return policy === 'after-dwell' ? 'defer' : 'now';
}

/** True when the reader header should offer an explicit "Mark read" button. */
export function showsManualMarkRead(policy: PostboxMarkReadPolicy, hasUnread: boolean): boolean {
	return policy === 'manual' && hasUnread;
}
