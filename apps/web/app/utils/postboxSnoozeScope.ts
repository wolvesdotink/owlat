/**
 * What a snooze applies to: the whole conversation or just the one message.
 *
 * THREAD is the default — deferring a message and having its siblings (or the
 * next reply arriving on the same conversation) stay in the inbox is the
 * failure mode message-scope snooze has always had. "Just this message" stays
 * available as the secondary choice for the case where a single mail in a long
 * thread is what needs to come back later.
 *
 * Pure so the dialog's scope contract is unit-testable without mounting it, and
 * so the label keys stay resolvable at the render boundary (module scope never
 * calls `useI18n`).
 */

export type PostboxSnoozeScope = 'thread' | 'message';

export const POSTBOX_SNOOZE_SCOPE_DEFAULT: PostboxSnoozeScope = 'thread';

/** Normalise an unknown value to a valid scope, defaulting to the thread. */
export function resolvePostboxSnoozeScope(value: string | undefined | null): PostboxSnoozeScope {
	return value === 'message' ? value : POSTBOX_SNOOZE_SCOPE_DEFAULT;
}

/**
 * The scope toggle's options, in display order (primary first). `label` is a
 * catalog key the dialog runs through `t()`.
 */
export const POSTBOX_SNOOZE_SCOPE_OPTIONS: Array<{
	value: PostboxSnoozeScope;
	label: string;
}> = [
	{ value: 'thread', label: 'shared.postboxSnoozeScope.thread' },
	{ value: 'message', label: 'shared.postboxSnoozeScope.message' },
];
