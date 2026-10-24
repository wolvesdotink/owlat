import { api } from '@owlat/api';
import {
	alertKindsOf,
	noticeAlertKind,
	shouldPlayAlertSound,
	unreadAlertKind,
	type AlertSoundKind,
} from '~/lib/alertSoundRules';
import type { AssignmentNotice } from '~/lib/inbox/assignmentNoticeRules';
import {
	isWithinQuietHours,
	newlyArrived,
	type UnreadPeekMessage,
} from '~/lib/desktop/notificationRules';
import { playAlertSound, primeAlertSound } from '~/composables/postbox/useUiSound';
import type { UnreadBadge } from '~/composables/useUnreadBadge';

/** Remembered ids per source before the set is re-seeded from the current answer. */
const MAX_SEEN = 1000;

/**
 * The opt-in alert sounds: a soft chime when a reply lands on a thread the
 * user armed with "notify me when they reply", when a conversation is assigned
 * to them, or when the agent asks them a question. Each has its own switch,
 * all default off; `lib/alertSoundRules` decides, this only watches and plays.
 *
 * Runs in every session, browser and desktop alike, and needs neither Web
 * Push nor the desktop notification permission: a sound is its own channel.
 * It reads the same two subscriptions the notifiers already hold (the shared
 * unread peek and the "assigned to you" notices, with the same arguments, so
 * the Convex client serves both from one subscription).
 *
 * The first answer of each source is seeded silently and every id is
 * remembered afterwards, whether or not a sound was on, so opening the app,
 * reconnecting, a query re-delivery or switching a sound on later never turns
 * a backlog into a chime. The unread peek is a bounded newest-first window, so
 * a reply that arrives behind a flood of newer mail can go unheard: the sound
 * is a courtesy, never the record (the notification and the inbox are).
 *
 * On the desktop app the device switches apply as for notifications: the
 * notification master switch off, or this workspace muted, means no sound.
 */
export function useAlertSounds(unread: UnreadBadge) {
	const { isDesktop } = useDesktopContext();
	const { alertSounds, quietHours } = usePostboxSettings();
	const { settings: appSettings, workspaceLocal } = useDesktopAppSettings();
	const { activeId } = useDesktopWorkspaces();

	const silenced = computed(
		() =>
			isDesktop.value &&
			(!appSettings.value.global.notificationsEnabled ||
				(activeId.value ? workspaceLocal(activeId.value).muteNotifications : false))
	);
	const anySoundOn = computed(() => Object.values(alertSounds.value).some(Boolean));

	// Same arguments as the notifier's subscription, so this is not a second one.
	const { data: noticeData } = useConvexQuery(api.inbox.queries.pendingAssignments, () => ({
		includeMentions: true,
		includeSlaBreaches: true,
	}));

	function sound(kinds: readonly AlertSoundKind[]): void {
		if (kinds.length === 0) return;
		const play = shouldPlayAlertSound({
			kinds,
			prefs: alertSounds.value,
			quiet: isWithinQuietHours(quietHours.value, new Date()),
			silenced: silenced.value,
		});
		if (play) playAlertSound();
	}

	/** Mark `ids` as seen, re-seeding from them when the set has grown too large. */
	function remember(seen: Set<string>, ids: readonly string[]): void {
		for (const id of ids) seen.add(id);
		if (seen.size <= MAX_SEEN) return;
		seen.clear();
		for (const id of ids) seen.add(id);
	}

	const seenMessages = new Set<string>();
	let messagesLoaded = false;
	// Watched by identity: a delivery that changes anything is a new object.
	watch(
		() => unread.data.value,
		(data) => {
			if (!data) return;
			const messages = data.messages as UnreadPeekMessage[];
			const fresh = messagesLoaded ? newlyArrived(messages, seenMessages) : [];
			remember(
				seenMessages,
				messages.map((m) => m.messageId)
			);
			messagesLoaded = true;
			sound(alertKindsOf(fresh, unreadAlertKind));
		},
		{ immediate: true }
	);

	const seenNotices = new Set<string>();
	let noticesLoaded = false;
	watch(
		() => noticeData.value,
		(rows) => {
			if (!rows) return;
			const notices = rows as AssignmentNotice[];
			const fresh = noticesLoaded ? notices.filter((n) => !seenNotices.has(n.id)) : [];
			remember(
				seenNotices,
				notices.map((n) => n.id)
			);
			noticesLoaded = true;
			sound(alertKindsOf(fresh, noticeAlertKind));
		},
		{ immediate: true }
	);

	// An alert never arrives inside a user gesture, and WebKit only lets an
	// element play on its own after it has played inside one. So while any
	// sound is on, the next click or key press unlocks the chime (muted).
	const prime = () => primeAlertSound();
	let listening = false;
	function listen(on: boolean): void {
		if (typeof window === 'undefined' || on === listening) return;
		listening = on;
		if (on) {
			window.addEventListener('pointerdown', prime, true);
			window.addEventListener('keydown', prime, true);
		} else {
			window.removeEventListener('pointerdown', prime, true);
			window.removeEventListener('keydown', prime, true);
		}
	}
	watch(anySoundOn, (on) => listen(on));
	onMounted(() => listen(anySoundOn.value));
	onUnmounted(() => listen(false));
}
