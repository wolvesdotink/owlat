/**
 * Today's Upcoming band: the live page (`today.upcoming.list`) and the three
 * actions on a scheduled send.
 *
 *   - Send now sends it with the viewer's undo window and arms the app-wide
 *     undo-send toast, exactly as the composer's Send does.
 *   - Edit unschedules it first and opens the composer only once that
 *     succeeded, so the draft cannot go out while it is being edited.
 *   - Cancel unschedules it; it stays in Drafts.
 *
 * A send that is no longer scheduled (it went out, or another tab acted)
 * comes back `{ ok: false }`: the page says so and the live read drops the
 * row. "Show more" grows the page up to the server's cap.
 */
import { api } from '@owlat/api';
import { useAnswerModeNav } from '~/composables/useAnswerMode';
import { usePostboxUndoSend } from '~/composables/postbox/usePostboxUndoSend';
import {
	postboxUndoSendDelayMsArg,
	postboxUndoSendShowsToast,
} from '~/utils/postboxUndoSendWindow';
import type { UpcomingItem } from '~/utils/todayUpcoming';

/** The first page; the server's default page size. */
export const UPCOMING_FIRST_PAGE = 8;
const UPCOMING_STEP = 20;
/** The server's cap (`UPCOMING_MAX_LIMIT`). */
const UPCOMING_MAX = 50;

export type UpcomingSend = Extract<UpcomingItem, { kind: 'scheduled_send' }>;

export function useTodayUpcoming() {
	const { t } = useI18n();
	const { showToast } = useToast();

	const limit = ref(UPCOMING_FIRST_PAGE);
	const read = useOrganizationQuery(api.today.upcoming.list, () => ({ limit: limit.value }), {
		keepPreviousData: true,
	});
	const items = computed<UpcomingItem[]>(() => read.data.value?.items ?? []);
	const hasMore = computed(() => read.data.value?.hasMore === true);
	const canShowMore = computed(() => hasMore.value && limit.value < UPCOMING_MAX);
	function showMore() {
		limit.value = Math.min(limit.value + UPCOMING_STEP, UPCOMING_MAX);
	}

	/** The row an action is running on; its buttons wait. */
	const busyKey = ref<string | null>(null);

	const sendNowOp = useBackendOperation(api.mail.scheduledSends.sendNow, {
		label: () => t('components.today.upcoming.operations.sendNow'),
	});
	const unscheduleOp = useBackendOperation(api.mail.drafts.cancelScheduledSend, {
		label: () => t('components.today.upcoming.operations.cancel'),
	});
	const { undoSendSeconds } = usePostboxSettings();
	const undoWindow = usePostboxUndoSend();
	const answerNav = useAnswerModeNav();
	const composeNav = usePostboxComposeNav();

	async function withBusy(item: UpcomingSend, run: () => Promise<void>) {
		if (busyKey.value !== null) return;
		busyKey.value = item.key;
		try {
			await run();
		} finally {
			busyKey.value = null;
		}
	}

	function sayNoLongerScheduled() {
		showToast(t('components.today.upcoming.noLongerScheduled'), 'info');
	}

	/** Unschedule; true when the draft is back in Drafts. */
	async function unschedule(item: UpcomingSend): Promise<boolean> {
		const result = await unscheduleOp.run({ draftId: item.draftId });
		if (!result.ok) return false;
		if (!result.result.ok) {
			sayNoLongerScheduled();
			return false;
		}
		return true;
	}

	function sendNow(item: UpcomingSend) {
		return withBusy(item, async () => {
			const result = await sendNowOp.run({
				draftId: item.draftId,
				undoSendDelayMs: postboxUndoSendDelayMsArg(undoSendSeconds.value),
			});
			if (!result.ok) return;
			const sent = result.result;
			if (!sent.ok) {
				sayNoLongerScheduled();
				return;
			}
			if (postboxUndoSendShowsToast(undoSendSeconds.value)) {
				undoWindow.arm({
					undoToken: sent.undoToken,
					sendAt: sent.sendAt,
					mailboxId: item.mailboxId,
					...(item.inReplyToMessageId ? { replyToMessageId: item.inReplyToMessageId } : {}),
				});
			} else {
				showToast(t('components.today.upcoming.sent'), 'success');
			}
		});
	}

	function edit(item: UpcomingSend) {
		return withBusy(item, async () => {
			if (!(await unschedule(item))) return;
			// A reply is continued where replies are written (Answer mode, on the
			// message it answers); a new email reopens on the compose page.
			if (item.inReplyToMessageId) {
				void answerNav.open(item.inReplyToMessageId, { draftId: item.draftId });
				return;
			}
			void composeNav.open({ mailboxId: item.mailboxId, draftId: item.draftId });
		});
	}

	function cancel(item: UpcomingSend) {
		return withBusy(item, async () => {
			if (!(await unschedule(item))) return;
			showToast(t('components.today.upcoming.cancelled'), 'success');
		});
	}

	return {
		items,
		hasMore,
		canShowMore,
		showMore,
		isLoading: read.isLoading,
		error: read.error,
		refetch: read.refetch,
		busyKey,
		sendNow,
		edit,
		cancel,
	};
}
