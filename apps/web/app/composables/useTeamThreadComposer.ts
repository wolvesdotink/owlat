/**
 * The Team inbox thread as a composer target: where a reply's text is kept and
 * how it goes out. The mailbox target's counterpart is `usePostboxCompose`
 * (a `mailDrafts` row, `mail.drafts.send`); this one answers an inbound
 * message.
 *
 *  - Save keeps the text as a draft revision on the message. It stays waiting
 *    for review, and no autonomy feedback is recorded.
 *  - Send picks the path from the message's state. An answered message takes a
 *    follow-up (its own send and undo window). A message no agent will answer
 *    is taken over first. Then an unchanged agent draft is approved as is (the
 *    fast path, which the autonomy signal counts as unedited), and anything the
 *    person typed is saved as the working draft and approved.
 *
 * A refusal the server returns as a value (a teammate just replied, or someone
 * handled the message first) is toasted here and reads as "not sent", so the
 * caller only has to clear its box on a real send. Failed operations have
 * already toasted themselves (`useBackendOperation`).
 */

import { readonly, ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import type { BackendOperationResult } from '~/composables/useBackendOperation';
import { isApproveAlreadyHandled } from '~/composables/useReviewApproveUndo';
import type { TeamThreadComposerTarget } from '~/utils/composerTarget';
import {
	GENERIC_TEAMMATE_NAME,
	isReplyCollision,
	replyCollisionToast,
} from '~/utils/replyCollision';
import { isFollowUp, needsTakeOver, type TeamThreadReply } from '~/utils/teamThreadReply';

type OperationResult = BackendOperationResult<unknown>;

/** The mutations a reply rides, bound by the page (see `useThreadDetail`). */
interface TeamThreadComposerOps {
	approve: (messageId: Id<'inboundMessages'>) => Promise<OperationResult>;
	saveAndApprove: (
		messageId: Id<'inboundMessages'>,
		reply: TeamThreadReply
	) => Promise<OperationResult>;
	saveRevision: (
		messageId: Id<'inboundMessages'>,
		reply: TeamThreadReply
	) => Promise<OperationResult>;
	sendFollowUp: (reply: TeamThreadReply) => Promise<OperationResult>;
	takeOver: (messageId: Id<'inboundMessages'>) => Promise<OperationResult>;
}

interface TeamThreadComposerSources {
	/** The message the reply answers; `null` while the thread loads. */
	target: () => TeamThreadComposerTarget | null;
	/** That message's live `processingStatus`, which picks the send path. */
	processingStatus: () => string | undefined;
	/** A teammate is replying right now: sending waits, saving does not. */
	held: () => boolean;
}

/** How a send went out; `null` = nothing was sent. */
type TeamThreadSendOutcome = 'reply' | 'followUp' | null;

export function useTeamThreadComposer(
	sources: TeamThreadComposerSources,
	ops: TeamThreadComposerOps
) {
	const { t } = useI18n();
	const { showToast } = useToast();
	const busy = ref(false);

	/** A value-shaped refusal: toast it and report "not sent". */
	function refused(result: unknown): boolean {
		if (isReplyCollision(result)) {
			const message = replyCollisionToast(result.heldByName ?? t(GENERIC_TEAMMATE_NAME));
			showToast(t(message.key, message.params ?? {}), 'error');
			return true;
		}
		if (isApproveAlreadyHandled(result)) {
			showToast(t('shared.reviewApprove.alreadyHandled'), 'info');
			return true;
		}
		return false;
	}

	async function sendTo(
		messageId: Id<'inboundMessages'>,
		status: string,
		reply: TeamThreadReply,
		fromDraft: boolean
	): Promise<TeamThreadSendOutcome> {
		if (isFollowUp(status)) {
			const sent = await ops.sendFollowUp(reply);
			if (!sent.ok || refused(sent.result)) return null;
			showToast(t('dashboard.inbox.detail.followUpSentToast'));
			return 'followUp';
		}
		if (needsTakeOver(status)) {
			const takenOver = await ops.takeOver(messageId);
			if (!takenOver.ok) return null;
		}
		const result = fromDraft
			? await ops.approve(messageId)
			: await ops.saveAndApprove(messageId, reply);
		if (!result.ok || refused(result.result)) return null;
		showToast(t('dashboard.inbox.detail.replySentToast'));
		return 'reply';
	}

	/**
	 * Send `reply`. `fromDraft` = the agent's draft, unchanged. Resolves to how
	 * it went out, or `null` when it did not (held, busy, refused, failed).
	 */
	async function send(reply: TeamThreadReply, fromDraft: boolean): Promise<TeamThreadSendOutcome> {
		const target = sources.target();
		const status = sources.processingStatus();
		if (!target || status === undefined || sources.held() || busy.value) return null;
		busy.value = true;
		try {
			return await sendTo(target.inboundMessageId, status, reply, fromDraft);
		} finally {
			busy.value = false;
		}
	}

	/** Keep `reply` as the working draft without sending it. */
	async function save(reply: TeamThreadReply): Promise<boolean> {
		const target = sources.target();
		if (!target || busy.value) return false;
		busy.value = true;
		try {
			const result = await ops.saveRevision(target.inboundMessageId, reply);
			if (result.ok) showToast(t('dashboard.inbox.detail.toasts.draftSavedNotApproved'));
			return result.ok;
		} finally {
			busy.value = false;
		}
	}

	return { busy: readonly(busy), send, save };
}
