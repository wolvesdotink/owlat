/**
 * The reply side of a Team inbox thread in Answer mode (`/dashboard/answer/t/<threadId>`):
 * which message the reply answers, whether it can go out now, what the editor
 * starts with, and how it is sent, saved, rejected or asked for.
 *
 * The reply answers one message: the one the URL names (`?message=`, unless it
 * was already answered), otherwise the newest message still waiting,
 * otherwise the newest message (whose state then says why nothing can go
 * out). The named message wins whatever it is waiting on: "Answer in reply"
 * on a message whose agent is asking must open on that message's questions,
 * not on a newer message's draft. Sending rides `useTeamThreadComposer` (take over, edit + approve, or a
 * follow-up); the refusals it can come back with are toasted there.
 *
 * The agent's questions (`awaiting_clarification`) are answered here too,
 * through the same mutation the thread page used; the answers resume the
 * agent's draft, which then opens in the editor.
 */
import type { Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { AskAnswer } from '~/composables/useAnswerAskSession';
import { backgroundAskAnswers } from '~/utils/backgroundAskAnswers';
import type { TeamThreadComposerTarget } from '~/utils/composerTarget';
import {
	hasAgentDraft,
	isChannelMessage,
	isFollowUp,
	pickReplyTarget,
	replyBlocker,
	replyNotice,
	replySubject,
} from '~/utils/teamThreadReply';
import { useNow } from '~/composables/useNow';
import type { useThreadDetail } from '~/composables/useThreadDetail';
import { useTeamThreadComposer } from '~/composables/useTeamThreadComposer';
import { useReviewApproveUndo } from '~/composables/useReviewApproveUndo';

type ThreadDetail = ReturnType<typeof useThreadDetail>;
type ThreadMessage = ThreadDetail['messages']['value'][number];

export function useAnswerTeamReply(opts: {
	threadId: Ref<Id<'conversationThreads'>>;
	detail: ThreadDetail;
	/** `?message=`: the message the reply should answer, unless already answered. */
	chosenMessageId: () => string | null;
	/** A teammate is replying: sending waits. */
	held: () => boolean;
}) {
	const { t } = useI18n();
	const { showToast } = useToast();
	const { isEnabled: isFeatureEnabled } = useFeatureFlag();
	const { isAdmin } = usePermissions();
	const { messages, takeOver, contact } = opts.detail;

	// Drives the reply blocker's received-wait (minutes long, so a second is plenty).
	const now = useNow({ intervalMs: 1_000 });

	const target = computed<ThreadMessage | null>(() => {
		const chosenId = opts.chosenMessageId();
		// A message already answered (`sent`) has nothing left to reply to here;
		// the thread's own pick then says what does.
		const chosen = chosenId
			? messages.value.find((m) => m._id === chosenId && !isFollowUp(m.processingStatus))
			: undefined;
		return chosen ?? pickReplyTarget(messages.value);
	});

	const blocker = computed(() => {
		const message = target.value;
		if (!message) return null;
		// The server's own takeover facts (getThread), so the composer never opens
		// on a message `takeOverReply` would refuse.
		const facts = takeOver.value?.messages.find((m) => m.messageId === message._id);
		return replyBlocker(message.processingStatus, {
			agentEnabled: isFeatureEnabled('ai.agent'),
			scanFinished: facts?.scanFinished,
			pipelineStarted: facts?.pipelineStarted,
			receivedWaitMs: takeOver.value?.receivedWaitMs,
			receivedAt: message._creationTime,
			now: now.value,
			isChannel: isChannelMessage(message),
		});
	});
	const notice = computed(() => (target.value ? replyNotice(target.value.processingStatus) : null));

	// A rejected draft was thrown out on purpose: the person starts from an empty
	// editor. So does a follow-up: the message's draft is the reply that already
	// went out.
	const draft = computed(() =>
		target.value &&
		target.value.processingStatus !== 'rejected' &&
		!isFollowUp(target.value.processingStatus) &&
		hasAgentDraft(target.value)
			? (target.value.draftResponse ?? null)
			: null
	);
	const subject = computed(() => (target.value ? replySubject(target.value) : null));
	// The diff's "before" side is the AGENT's original draft (revision 0), not the
	// latest saved text, so the first save does not destroy the agent-vs-human
	// diff. Falls back to the working draft for messages never saved.
	const originalDraft = computed(() => {
		const message = target.value;
		if (!message || !draft.value) return null;
		const original = message.draftRevisions?.[0];
		return original?.savedBy === 'agent' ? original.text : (message.draftResponse ?? '');
	});
	const senderLabel = computed(() => {
		const c = contact.value;
		if (c) {
			const name = `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim();
			return name || c.email || '';
		}
		return target.value?.from ?? '';
	});

	const composerTarget = computed<TeamThreadComposerTarget | null>(() =>
		target.value
			? {
					kind: 'teamThread',
					threadId: opts.threadId.value,
					inboundMessageId: target.value._id,
				}
			: null
	);

	// A message no agent will answer is taken over first, so the normal edit →
	// approve path can send a person's reply.
	const { run: takeOverReply } = useBackendOperation(api.inbox.manualReply.takeOverReply, {
		label: () => t('dashboard.inbox.detail.takeOverOperation'),
	});
	// A held approve gets the "Approved · Undo" countdown. Its toast lives in the
	// dashboard layout, so it stays up on the page the reply leaves to.
	const approveUndo = useReviewApproveUndo();
	const { run: undoAutoSend } = useBackendOperation(api.inbox.mutations.undoAutoSend, {
		label: () => t('shared.useReviewQueue.undoApproval'),
	});
	function armApproveUndo(messageId: Id<'inboundMessages'>, sendAt: number) {
		approveUndo.arm({
			inboundMessageId: messageId,
			sendAt,
			onUndo: async () => {
				const result = await undoAutoSend({ inboundMessageId: messageId });
				if (!result.ok) return;
				if (result.result.cancelled) showToast(t('shared.reviewBulkSummary.undoneOne'));
				else if (result.result.reason === 'already_sent') {
					showToast(t('shared.reviewBulkSummary.tooLateOne'), 'warning');
				}
			},
		});
	}
	const composer = useTeamThreadComposer(
		{
			target: () => composerTarget.value,
			processingStatus: () => target.value?.processingStatus,
			held: opts.held,
		},
		{
			approve: opts.detail.handleApprove,
			saveAndApprove: opts.detail.saveEditedDraft,
			saveRevision: opts.detail.saveDraftOnly,
			sendFollowUp: opts.detail.sendFollowUp,
			takeOver: (inboundMessageId) => takeOverReply({ inboundMessageId }),
			armApproveUndo,
		}
	);

	// An update the classifier filed as needing no reply can be sent to drafting
	// after all; the draft then opens in the editor.
	const { run: requestReplyOp, isLoading: isRequestingReply } = useBackendOperation(
		api.inbox.updates.requestReply,
		{ label: () => t('dashboard.inbox.detail.requestReplyOperation') }
	);
	async function requestReply() {
		const message = target.value;
		if (!message || !isAdmin.value) return;
		const result = await requestReplyOp({ inboundMessageId: message._id });
		if (result.ok) showToast(t('dashboard.inbox.detail.replyRequestedToast'));
	}

	// ── The agent's questions ──
	const clarification = computed(() => {
		const message = target.value;
		return message?.processingStatus === 'awaiting_clarification' && message.pendingClarification
			? { messageId: message._id, questions: message.pendingClarification.questions }
			: null;
	});
	const { run: answerClarification, isLoading: isAnsweringClarification } = useBackendOperation(
		api.inbox.clarification.answerClarification,
		{ label: () => t('dashboard.inbox.detail.answerClarificationOperation') }
	);
	// The ask card leaves a kept remembered answer out; it goes back as
	// `memory`, so the agent has every answer and the fact is not captured again.
	// Resolves to the answers sent, or null when nothing was saved.
	async function submitClarification(answers: AskAnswer[]) {
		const current = clarification.value;
		if (!current || !isAdmin.value) return null;
		const sent = backgroundAskAnswers(current.questions, answers);
		const result = await answerClarification({
			inboundMessageId: current.messageId,
			answers: sent,
		});
		if (!result.ok) return null;
		showToast(t('dashboard.inbox.detail.clarificationSavedToast'));
		return sent;
	}

	/** Answers the agent reused from memory for the draft in the editor. */
	const reusedAnswers = computed(() => {
		const message = target.value;
		if (!message || message.processingStatus !== 'draft_ready') return [];
		return (message.pendingClarification?.questions ?? []).filter(
			(q) => q.answer?.source === 'memory'
		);
	});

	// ── Rejecting the agent's draft ──
	const rejectOpen = ref(false);
	const rejectReason = ref('');
	const isRejecting = ref(false);
	function openReject() {
		rejectReason.value = '';
		rejectOpen.value = true;
	}
	async function confirmReject(): Promise<boolean> {
		const message = target.value;
		if (!message || isRejecting.value) return false;
		isRejecting.value = true;
		try {
			const result = await opts.detail.handleReject(message._id, rejectReason.value || undefined);
			if (!result.ok) return false;
			rejectOpen.value = false;
			showToast(t('dashboard.inbox.detail.draftRejectedToast'));
			return true;
		} finally {
			isRejecting.value = false;
		}
	}

	return {
		target,
		blocker,
		notice,
		draft,
		subject,
		originalDraft,
		senderLabel,
		composerTarget,
		busy: composer.busy,
		send: composer.send,
		save: composer.save,
		requestReply,
		isRequestingReply,
		clarification,
		submitClarification,
		isAnsweringClarification,
		reusedAnswers,
		reject: { open: rejectOpen, reason: rejectReason, isRejecting, openReject, confirmReject },
	};
}
