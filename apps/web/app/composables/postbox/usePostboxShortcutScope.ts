/**
 * Claims the `postbox` scope of the shortcut registry while a Postbox surface
 * is on screen, and binds the mailbox's own `g` chords.
 *
 * Scoping is the point: `g s` is "go to Admin" across the app and "go to
 * Starred" here, `g d` is the dashboard out there and Drafts in here, and `n`
 * is "new item" on a list page and "next unread" in the mailbox. None of those
 * surfaces know about each other — the registry resolves the innermost claim
 * first and the app-wide map keeps working the moment the mailbox unmounts.
 *
 * Ref-counted like the help-overlay claim: two Postbox surfaces overlap for a
 * tick during a route change, and the first unmount must not take the chords
 * away from the second.
 */

import { pushShortcutScope } from '~/utils/shortcutScope';

/**
 * Where each mailbox `g` chord goes. Starred is a saved query rather than a
 * folder (there is no /starred route), so it lands on search with the same
 * `is:starred` token the filter chips use.
 */
const POSTBOX_CHORD_TARGETS: Readonly<Record<string, string>> = {
	'postbox.goInbox': '/dashboard/postbox/inbox',
	'postbox.goSent': '/dashboard/postbox/sent',
	'postbox.goDrafts': '/dashboard/postbox/drafts',
	'postbox.goStarred': `/dashboard/postbox/search?q=${encodeURIComponent('is:starred')}`,
};

let mounted = 0;

export function usePostboxShortcutScope() {
	const { registerShortcut, unregisterShortcut } = useKeyboardShortcuts();
	let release: (() => void) | null = null;

	onMounted(() => {
		release = pushShortcutScope('postbox');
		mounted += 1;
		for (const [id, path] of Object.entries(POSTBOX_CHORD_TARGETS)) {
			registerShortcut({ id, handler: () => void navigateTo(path), ignoreInputs: true });
		}
	});

	onBeforeUnmount(() => {
		release?.();
		release = null;
		mounted = Math.max(0, mounted - 1);
		if (mounted > 0) return;
		for (const id of Object.keys(POSTBOX_CHORD_TARGETS)) unregisterShortcut(id);
	});
}
