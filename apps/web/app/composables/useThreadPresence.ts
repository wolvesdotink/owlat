import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { Ref } from 'vue';

/** Client heartbeat cadence. Two beats fit inside the 60s server active window. */
const HEARTBEAT_INTERVAL_MS = 20_000;

export interface ThreadPresencePerson {
	userId: string;
	mode: 'viewing' | 'replying';
}

/**
 * Live "who is here" for a shared-inbox thread.
 *
 * Drives the Convex-native presence backend (inbox/presence.ts):
 *  - heartbeats every ~20s while the thread is open, flipping `mode` to
 *    `replying` whenever the reply/review editor is focused (the `replying` ref);
 *  - PAUSES the heartbeat while the tab is hidden (document.hidden) so a
 *    backgrounded tab doesn't keep a stale "viewing" ring alive on teammates'
 *    screens — it resumes with an immediate beat when the tab is shown again;
 *  - subscribes to the active-presence list and exposes `others` (everyone but
 *    the current user), plus `viewers` and `repliers` split by mode.
 *
 * Read surfaces (pulsing viewer ring + "… is replying" banner) live in
 * components/inbox/InboxThreadPresence.vue.
 */
export function useThreadPresence(
	threadId: Ref<Id<'conversationThreads'>>,
	options: { replying: Ref<boolean>; enabled?: Ref<boolean> }
) {
	const client = useConvex();
	const { user } = useAuth();
	const currentUserId = computed(() => user.value?.id ?? null);

	const enabled = computed(() => options.enabled?.value ?? true);
	const mode = computed<'viewing' | 'replying'>(() =>
		options.replying.value ? 'replying' : 'viewing'
	);

	// Live list of active presence rows for this thread.
	const { data } = useConvexQuery(api.inbox.presence.list, () =>
		enabled.value ? { threadId: threadId.value } : 'skip'
	);

	const rows = computed<ThreadPresencePerson[]>(() =>
		(data.value ?? []).map((r) => ({ userId: r.userId, mode: r.mode }))
	);
	/** Everyone present on the thread except the current user. */
	const others = computed(() => rows.value.filter((r) => r.userId !== currentUserId.value));
	const viewers = computed(() => others.value.filter((r) => r.mode === 'viewing'));
	const repliers = computed(() => others.value.filter((r) => r.mode === 'replying'));

	let timer: ReturnType<typeof setInterval> | null = null;

	const isHidden = () => typeof document !== 'undefined' && document.hidden;

	const beat = async () => {
		if (!enabled.value || isHidden()) return;
		try {
			await client.mutation(api.inbox.presence.heartbeat, {
				threadId: threadId.value,
				mode: mode.value,
			});
		} catch {
			// Best-effort presence signal — a dropped beat self-heals on the next
			// tick (and the server sweeps a stale row within a minute).
		}
	};

	const leave = async (id: Id<'conversationThreads'>) => {
		try {
			await client.mutation(api.inbox.presence.leave, { threadId: id });
		} catch {
			// Best-effort — the sweep cron reconciles a lost leave.
		}
	};

	const stopTimer = () => {
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
	};

	const startTimer = () => {
		stopTimer();
		if (!enabled.value || isHidden()) return;
		void beat();
		timer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);
	};

	const onVisibilityChange = () => {
		if (isHidden()) {
			// Pause: stop beating so a backgrounded tab stops advertising presence;
			// the existing row ages out of the active window server-side.
			stopTimer();
		} else {
			// Resume with an immediate beat so the ring reappears promptly.
			startTimer();
		}
	};

	// Re-beat immediately when the mode flips (editor focus/blur) so teammates see
	// "replying" within a beat rather than up to 20s later.
	watch(mode, () => void beat());

	// Moving to another thread: leave the old one, then start beating the new one.
	watch(threadId, (next, prev) => {
		if (prev && prev !== next) void leave(prev);
		startTimer();
	});

	watch(enabled, (on) => {
		if (on) startTimer();
		else {
			stopTimer();
			void leave(threadId.value);
		}
	});

	onMounted(() => {
		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', onVisibilityChange);
		}
		startTimer();
	});

	onUnmounted(() => {
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', onVisibilityChange);
		}
		stopTimer();
		void leave(threadId.value);
	});

	return { others, viewers, repliers };
}
