import { api } from '@owlat/api';
import { badgeCount, type UnreadPeekMessage } from '~/lib/desktop/notificationRules';

/**
 * How many of the newest unread messages the peek carries. The exact unread
 * `total` never depends on it; only the people-only badge count and the
 * desktop toasts read the window.
 */
const UNREAD_PEEK_LIMIT = 5;

/**
 * The unread mail the app badges, read once for every surface that shows it.
 *
 * Subscribes to `mail.mailbox.queries.newestUnreadInbox` (the exact unread
 * `total` across the inboxes the user can read, plus a bounded newest-first
 * window) and derives the one number the browser tab and the desktop dock both
 * show. `count` is `null` until the first delivery, so nothing paints a stale
 * or premature zero.
 *
 * The count honours the per-user "count all mail in the badge" preference
 * through `badgeCount`, and it is a computed over both the delivery and the
 * preference: flipping the preference repaints every badge at once, without
 * waiting for the next unread change.
 */
export function useUnreadBadge() {
	const { badgeNonPeople } = usePostboxSettings();
	const { data } = useConvexQuery(api.mail.mailbox.queries.newestUnreadInbox, () => ({
		limit: UNREAD_PEEK_LIMIT,
	}));

	const count = computed<number | null>(() => {
		const peek = data.value;
		if (!peek) return null;
		return badgeCount(peek.total, peek.messages as UnreadPeekMessage[], badgeNonPeople.value);
	});

	return { data, count };
}

export type UnreadBadge = ReturnType<typeof useUnreadBadge>;
