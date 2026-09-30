/**
 * What Answer mode adds around the Team inbox reply (plan §03 to §06), the
 * team counterpart of `useAnswerModeAssist`:
 *
 *  - the catch-up card of the thread (`inbox.catchUp*`), and the asks it ticks
 *    as the reply covers them;
 *  - which conversation view opens: Summary when there is a card; with no card
 *    a short thread opens in full;
 *  - "Draft with AI" on the thread (`composeDraft` with a `teamThread` target)
 *    and its ask card. The draft streams into the reply; the files it found or
 *    was given come back as `attachedFiles`, which the reply attaches through
 *    `inbox.replyAttachments` (the server does not, for a team thread).
 *
 * The ask session lives on the Postbox side of the backend (`postboxQuery`), so
 * "Draft with AI" needs the `ai` flag and the Postbox (or external mail) on.
 */
import type { Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { CATCH_UP_MIN_MESSAGES } from '@owlat/shared/answerMode';
import type { AnswerComposerApi } from '~/composables/postbox/usePostboxComposerAnswerApi';
import { useAnswerAskSession, type AskSession } from '~/composables/useAnswerAskSession';
import { useAnswerCatchUp } from '~/composables/useAnswerCatchUp';
import type { AnswerConversationView } from '~/components/answer/AnswerConversation.vue';

export function useAnswerTeamAssist(opts: {
	threadId: () => Id<'conversationThreads'> | null;
	composer: () => AnswerComposerApi | null;
	messageCount: () => number | undefined;
	view: Ref<AnswerConversationView>;
	/** Attach a file the ask session found or was given. */
	attachFile: (file: AskSession['attachedFiles'][number]) => void;
}) {
	const { t } = useI18n();
	const { isEnabled } = useFeatureFlag();
	const aiEnabled = computed(() => isEnabled('ai'));
	const draftWithAi = computed(
		() => aiEnabled.value && (isEnabled('postbox') || isEnabled('mail.external'))
	);

	const catchUp = useAnswerCatchUp({
		target: () => {
			const threadId = opts.threadId();
			return threadId ? { kind: 'team', threadId } : null;
		},
		draftText: () => opts.composer()?.draftText.value ?? '',
	});

	const statusNote = computed(() => {
		const total = catchUp.catchUp.value?.asks.length ?? 0;
		if (total === 0) return undefined;
		return t(
			'components.answer.catchUp.covered',
			{ covered: catchUp.covered.value.length, total },
			total
		);
	});

	// Summary when there is a card; a short thread without one opens in full.
	// Decided once, so it never flips under someone who already toggled.
	let viewDecided = false;
	watch(
		() => [catchUp.loading.value, catchUp.catchUp.value, opts.messageCount()] as const,
		([loading, card, count]) => {
			if (viewDecided || loading || count === undefined) return;
			viewDecided = true;
			if (!card && count < CATCH_UP_MIN_MESSAGES) opts.view.value = 'full';
		},
		{ immediate: true }
	);

	const ask = useAnswerAskSession({
		target: () => {
			const threadId = opts.threadId();
			return draftWithAi.value && threadId ? { kind: 'teamThread', threadId } : null;
		},
		composer: opts.composer,
		onSettled: () => void catchUp.checkCoverage(),
		onAttachedFiles: (files) => {
			for (const file of files) opts.attachFile(file);
		},
	});

	return { aiEnabled, draftWithAi, catchUp, statusNote, ask };
}
