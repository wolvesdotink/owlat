/**
 * What sending a reply does to its conversation: keep it in the Inbox, or mark
 * it done (archive it once the reply is sent). One setting picks the default
 * for Send and Cmd/Ctrl+Enter; Cmd/Ctrl+Alt+Enter and the Send menu's other
 * entry do the opposite for that one send.
 *
 * Pure, so the default/opposite matrix is unit-tested without the composer.
 */

export type PostboxAfterReply = 'keep' | 'done';

/** Keep: what a reply did before the setting existed. */
export const POSTBOX_AFTER_REPLY_DEFAULT: PostboxAfterReply = 'keep';

/**
 * The picker options. Module scope never calls `useI18n`, so `label` is the
 * catalog key the settings screen renders through `t()`.
 */
export const POSTBOX_AFTER_REPLY_OPTIONS: ReadonlyArray<{
	value: PostboxAfterReply;
	label: string;
}> = [
	{ value: 'keep', label: 'shared.postboxAfterReply.keep' },
	{ value: 'done', label: 'shared.postboxAfterReply.done' },
];

/** The catalog key naming a send that takes each action ("Send and mark done"). */
export const POSTBOX_SEND_AND_LABELS: Readonly<Record<PostboxAfterReply, string>> = {
	keep: 'components.postbox.postboxComposerFooter.sendAndKeep',
	done: 'components.postbox.postboxComposerFooter.sendAndDone',
};

/** A stored value read defensively: anything unknown is the default. */
export function resolvePostboxAfterReply(value: unknown): PostboxAfterReply {
	return value === 'done' || value === 'keep' ? value : POSTBOX_AFTER_REPLY_DEFAULT;
}

/** The other action: what the opposite-action chord does. */
export function oppositeAfterReply(action: PostboxAfterReply): PostboxAfterReply {
	return action === 'done' ? 'keep' : 'done';
}

/**
 * The action one send of a reply takes: an explicit choice (a Send menu entry)
 * wins, `'opposite'` (the chord) flips the setting, nothing is the setting.
 */
export function afterReplyFor(
	setting: PostboxAfterReply,
	choice?: PostboxAfterReply | 'opposite'
): PostboxAfterReply {
	if (choice === 'opposite') return oppositeAfterReply(setting);
	return choice ?? setting;
}

/** What the composer footer's Send menu needs to offer a reply's two ways to send. */
export interface ComposerSendActions {
	/** What Send and Cmd/Ctrl+Enter do: the setting. */
	primary: PostboxAfterReply;
	/** The chord that takes each action, as this machine spells it. */
	chords: Record<PostboxAfterReply, string>;
	/** The same chords for `aria-keyshortcuts`. */
	aria: Record<PostboxAfterReply, string | undefined>;
}
