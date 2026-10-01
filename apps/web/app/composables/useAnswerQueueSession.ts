/**
 * The Answer queue as a session over Answer mode (plan §07).
 *
 * Opening the queue opens Answer mode on its first item: a Postbox item on
 * `/dashboard/answer/m/<messageId>`, a team draft on `/dashboard/answer/t/<threadId>`.
 * The queue steps from item to item by replacing the route, so the browser's
 * Back and Esc both leave the queue for the page it was opened from. Items
 * that have no Answer mode (a chat mention, a follow-up reminder) stay cards on
 * the queue page itself, which also shows the loading, empty and done states.
 *
 * The flow (order, position, undo, the end summary) lives in the parent route
 * `pages/dashboard/answer.vue`, which stays mounted while the child route
 * changes, and reaches the pages through provide/inject. The session reads
 * nothing until it is used: an Answer mode page opened from the Postbox mounts
 * the same parent and never subscribes to the queue.
 *
 * An item is done ONLY when its reply is sent, or when it is archived, snoozed
 * or marked done. Opening the composer finishes nothing (the old queue card
 * completed on open, and closing the popup silently dropped the email).
 */
import { inject, provide, readonly, type InjectionKey } from 'vue';
import { api } from '@owlat/api';
import { useAnswerQueue, type AnswerItem } from '~/composables/useAnswerQueue';
import { useAnswerModeNav } from '~/composables/useAnswerMode';
import { useTaskFlow } from '~/composables/useTaskFlow';
import { mailAnswerKind, type AnswerCardControls } from '~/utils/answerCard';
import { isAnswerModePath, singleQueryValue } from '~/utils/answerMode';
import {
	answerItemMatches,
	answerModeTarget,
	answerQueueIndexHref,
	answerQueueItemHref,
	answerTargetMatchesRoute,
	opensInAnswerMode,
	parseAnswerFilter,
} from '~/utils/answerQueue';
import type { TaskFlowOrderKey } from '~/utils/taskFlow';
import { isEditableTarget } from '~/utils/postboxShortcuts';

const QUEUE_PAGE = '/dashboard/answer';
/** Where leaving the queue goes when nothing says where it was opened from. */
const QUEUE_FALLBACK_RETURN = '/dashboard';

function orderKey(item: AnswerItem): TaskFlowOrderKey {
	if (item.source === 'mail') {
		return {
			id: item.id,
			kind: mailAnswerKind(item.row),
			threadId: item.row.threadId,
			contactKey: item.row.fromAddress,
		};
	}
	if (item.source === 'team') {
		const hasDraft = !!item.entry.message.draftResponse?.trim();
		return {
			id: item.id,
			kind: hasDraft ? 'draft_review' : 'reply',
			threadId: item.entry.thread?._id,
			contactKey: item.entry.message.from,
		};
	}
	return { id: item.id, kind: 'reply', threadId: item.mention.roomId };
}

export function createAnswerQueueSession() {
	const route = useRoute();
	const answerNav = useAnswerModeNav();

	const onQueuePage = computed(() => route.path.replace(/\/+$/, '') === QUEUE_PAGE);
	/** `?queue=` on an Answer mode route: the queue drives this page. */
	const queueParam = computed(() => singleQueryValue(route.query['queue']));

	// Once the queue is in use it stays in use until the parent route unmounts.
	const engaged = ref(false);
	watch(
		[onQueuePage, queueParam],
		([page, param]) => {
			if (engaged.value || (!page && !param)) return;
			engaged.value = true;
			answerNav.setReturnPath(entryOrigin());
		},
		{ immediate: true }
	);

	/** The page the queue was opened from: the history entry before it. */
	function entryOrigin(): string {
		const back =
			typeof window === 'undefined'
				? null
				: (window.history.state?.back as string | null | undefined);
		if (!back || back.startsWith(QUEUE_PAGE)) return QUEUE_FALLBACK_RETURN;
		return back;
	}

	const filter = computed(() =>
		parseAnswerFilter(onQueuePage.value ? route.query['in'] : route.query['queue'])
	);

	const queue = useAnswerQueue({ enabled: () => engaged.value });
	const source = computed(() =>
		queue.items.value.filter((item) => answerItemMatches(item, filter.value))
	);
	const flow = useTaskFlow<AnswerItem>(source, { key: orderKey });

	/** The item the current Answer mode route answers, if the queue holds it. */
	const routeItemId = computed(() => {
		if (!isAnswerModePath(route.path)) return null;
		const match = source.value.find((item) => {
			const target = answerModeTarget(item);
			return target !== null && answerTargetMatchesRoute(target, route);
		});
		return match?.id ?? null;
	});

	/** The queue's current item is the one this Answer mode page answers. */
	const isCurrentRoute = computed(() => {
		const item = flow.current.value;
		const target = item ? answerModeTarget(item) : null;
		return (
			target !== null && isAnswerModePath(route.path) && answerTargetMatchesRoute(target, route)
		);
	});

	/**
	 * Show the current item where it is answered: its Answer mode route, or the
	 * queue page for a card and for the done state. A replace, never a push.
	 */
	function syncRoute() {
		if (!flow.active.value) return;
		const item = flow.current.value;
		if (item && opensInAnswerMode(item)) {
			const target = answerModeTarget(item)!;
			if (answerTargetMatchesRoute(target, route)) return;
			void navigateTo(answerQueueItemHref(target, filter.value), { replace: true });
			return;
		}
		if (!onQueuePage.value) {
			void navigateTo(answerQueueIndexHref(filter.value), { replace: true });
		}
	}

	function startFlow() {
		flow.start();
		const focus = singleQueryValue(route.query['focus']) ?? routeItemId.value;
		if (focus) {
			for (
				let i = 0;
				i < flow.total.value && flow.currentId.value !== focus && flow.canGoNext.value;
				i++
			) {
				flow.next();
			}
		}
		// A reload of an item that already left the queue stays where it is; the
		// queue bar offers the way back to the queue's current item.
		if (isAnswerModePath(route.path) && !isCurrentRoute.value) return;
		syncRoute();
	}

	watch(
		[engaged, queue.isLoading, () => source.value.length, filter],
		([on, loading, length], previous) => {
			if (!on) return;
			const filterChanged = previous && previous[3] !== filter.value;
			if (filterChanged) flow.exit();
			if (flow.active.value || loading || length === 0) return;
			startFlow();
		},
		{ immediate: true }
	);

	function complete(outcome: string, inverse?: () => Promise<void> | void) {
		const id = flow.currentId.value;
		if (!id) return;
		flow.complete(id, { outcome, ...(inverse ? { inverse } : {}) });
		syncRoute();
	}
	function back() {
		flow.back();
		syncRoute();
	}
	function next() {
		flow.next();
		syncRoute();
	}
	async function undo() {
		if (await flow.undo()) syncRoute();
	}

	function controlsFor(item: AnswerItem): AnswerCardControls {
		return {
			complete: (outcome, inverse) => {
				flow.complete(item.id, { outcome, ...(inverse ? { inverse } : {}) });
				syncRoute();
			},
			skip: () => {
				flow.skip(item.id);
				syncRoute();
			},
			undoSelf: () => {
				void flow.undoById(item.id).then((undone) => undone && syncRoute());
			},
			back,
			next,
			openAnswer: () => {
				const target = answerModeTarget(item);
				if (target) void navigateTo(answerQueueItemHref(target, filter.value), { replace: true });
			},
		};
	}

	/**
	 * The reply on this Answer mode page went out. True when the queue took it
	 * (the item is done and the queue moved on); false when the page is not
	 * part of a queue and should leave the way it always does.
	 */
	function handleSent(outcome = 'replied'): boolean {
		if (!engaged.value || !flow.active.value) return false;
		if (isCurrentRoute.value) complete(outcome);
		else syncRoute();
		return true;
	}

	// Cmd/Ctrl+Z outside a text field undoes the queue's last action.
	function onWindowKeydown(event: KeyboardEvent) {
		if (!flow.active.value || !flow.canUndo.value) return;
		if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
		if (event.key.toLowerCase() !== 'z' || isEditableTarget(event.target)) return;
		event.preventDefault();
		void undo();
	}
	onMounted(() => window.addEventListener('keydown', onWindowKeydown));
	onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown));

	// Finishing the queue is a natural "I've caught up": move Today's watermark.
	const { t } = useI18n();
	const { run: markSeen } = useBackendOperation(api.today.state.markSeen, {
		label: () => t('dashboard.today.operations.markSeen'),
	});
	watch(
		() => flow.isComplete.value,
		(done) => {
			if (done) void markSeen({});
		}
	);

	return {
		queue,
		flow,
		filter,
		source,
		engaged: readonly(engaged),
		isCurrentRoute,
		controlsFor,
		complete,
		back,
		next,
		undo,
		handleSent,
		/** Take the queue back to its current item (from a page it no longer holds). */
		goCurrent: syncRoute,
		/** Narrow the queue; it restarts on the queue page and opens its first item. */
		setFilter(next: string) {
			void navigateTo(answerQueueIndexHref(next), { replace: true });
		},
	};
}

export type AnswerQueueSession = ReturnType<typeof createAnswerQueueSession>;

const ANSWER_QUEUE_SESSION: InjectionKey<AnswerQueueSession> = Symbol('answer-queue-session');

/** The parent route creates the session once for every Answer page below it. */
export function provideAnswerQueueSession(): AnswerQueueSession {
	const session = createAnswerQueueSession();
	provide(ANSWER_QUEUE_SESSION, session);
	return session;
}

/** The session, or null outside the Answer routes (and in isolated tests). */
export function useAnswerQueueSession(): AnswerQueueSession | null {
	return inject(ANSWER_QUEUE_SESSION, null);
}
