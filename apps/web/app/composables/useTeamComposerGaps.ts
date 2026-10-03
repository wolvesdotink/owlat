/**
 * The `[[...]]` gaps of a Team inbox reply the AI drafted: they hold Send until
 * filled, as in the Postbox composer (usePostboxComposerAnswerApi), and the
 * server refuses that send too (DRAFT_HAS_GAPS). A gap only holds while the AI
 * wrote into this reply, the thread has a Draft with AI session, or a saved
 * reply left gaps (`guarded`); brackets a person typed are their own text. The
 * note beside Send then says how many are left, in place of the host's note.
 * Only the written part counts, as on the server (`authoredDraftHasGaps`): a
 * `[[...]]` in the quoted original belongs to the mail being answered.
 */
import type { Ref } from 'vue';
import { findDraftGaps } from '@owlat/shared/answerMode';
import { splitQuotedText } from '@owlat/shared/quotedText';

export function useTeamComposerGaps(
	body: Readonly<Ref<string>>,
	answer: { aiDraft: Readonly<Ref<string | null>> },
	props: { askSession?: boolean; statusNote?: string },
	guarded: () => boolean = () => false
) {
	const { t } = useI18n();
	const gapCount = computed(() => findDraftGaps(splitQuotedText(body.value).fresh).length);
	const hold = computed(
		() =>
			gapCount.value > 0 &&
			(answer.aiDraft.value !== null || props.askSession === true || guarded())
	);
	const note = computed(() =>
		hold.value
			? t(
					'components.postbox.postboxComposerFooter.gapsLeft',
					{ count: gapCount.value },
					gapCount.value
				)
			: props.statusNote
	);
	return { hold, note };
}
