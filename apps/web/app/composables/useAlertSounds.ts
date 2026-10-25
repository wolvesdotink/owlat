import { api } from '@owlat/api';
import {
	alertKindsOf,
	noticeAlertKind,
	shouldPlayAlertSound,
	takeArrivals,
	unreadAlertKind,
	type AlertSoundKind,
	type ArrivalMemory,
} from '~/lib/alertSoundRules';
import type { AssignmentNotice } from '~/lib/inbox/assignmentNoticeRules';
import { isWithinQuietHours, type UnreadPeekMessage } from '~/lib/desktop/notificationRules';
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
 * a backlog into a chime. Both sources are bounded newest-first windows, so an
 * item only counts as an arrival when it is also newer than anything seen
 * before (`takeArrivals`): reading the newest unread message lets an older one
 * slide into the peek, and that is no new mail. The flip side: a reply that
 * arrives behind a flood of newer mail, or with an arrival time older than
 * mail already shown, goes unheard. The sound is a courtesy, never the record
 * (the notification and the inbox are).
 *
 * On the desktop app the device switches apply as for notifications: the
 * notification master switch off, or this workspace muted, means no sound.
 */
export function useAlertSounds(unread: UnreadBadge) {
	const { isDesktop } = useDesktopContext();
	const { quietHours } = usePostboxSettings();
	const { alertSounds } = useAlertSoundPreferences();
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

	/**
	 * Watch one source: the first answer only seeds `memory`, every later one
	 * sounds for what actually arrived. Watched by identity: a delivery that
	 * changes anything is a new object.
	 */
	function watchArrivals<T>(
		source: () => readonly T[] | null | undefined,
		idOf: (item: T) => string,
		timeOf: (item: T) => number,
		kindOf: (item: T) => AlertSoundKind | null
	): void {
		const memory: ArrivalMemory = { seen: new Set(), newestAt: null };
		let loaded = false;
		watch(
			source,
			(items) => {
				if (!items) return;
				const fresh = takeArrivals(memory, items, idOf, timeOf);
				// Bounded: re-seed from the current window. The watermark stays, so
				// nothing older than what was already seen can come back as new.
				if (memory.seen.size > MAX_SEEN) {
					memory.seen.clear();
					for (const item of items) memory.seen.add(idOf(item));
				}
				if (loaded) sound(alertKindsOf(fresh, kindOf));
				loaded = true;
			},
			{ immediate: true }
		);
	}

	watchArrivals(
		() => unread.data.value?.messages as UnreadPeekMessage[] | undefined,
		(m) => m.messageId,
		(m) => m.receivedAt,
		unreadAlertKind
	);
	watchArrivals(
		() => noticeData.value as AssignmentNotice[] | undefined,
		(n) => n.id,
		(n) => n.createdAt,
		noticeAlertKind
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
			// oxlint-disable-next-line owlat/no-raw-keydown-listener -- any key press unlocks audio; it is not a shortcut
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
