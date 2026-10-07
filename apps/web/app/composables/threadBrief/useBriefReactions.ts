/**
 * Runs what a person does to a brief item (plan §5). Replying reactions
 * (reply, attach, propose times, nudge, decline) hand over to the host, which
 * opens Answer mode: nothing here sends anything. The rest are the viewer's
 * statements about the item and go to `mail/interpret/reactions.ts`; Mark done
 * says it can be undone, right away, in its toast.
 */
import type { BriefItemView } from '../../../../api/convex/mail/interpret/briefShape';
import { interpretApi } from '~/composables/threadBrief/briefApi';
import { isReplyReaction, type BriefAction } from '~/utils/threadBriefItems';

/** "Remind me": tomorrow at 9:00 local time. */
export function nextMorning(now: Date = new Date()): number {
	const at = new Date(now);
	at.setDate(at.getDate() + 1);
	at.setHours(9, 0, 0, 0);
	return at.getTime();
}

export function useBriefReactions(opts: {
	/** Open Answer mode for this item (the replying reactions). */
	onReply: (item: BriefItemView, action: BriefAction) => void;
}) {
	const { t } = useI18n();
	const { showToast } = useToast();
	const label = () => t('components.brief.operations.react');

	const markDone = useBackendOperation(interpretApi.reactions.markDone, { label });
	const undo = useBackendOperation(interpretApi.reactions.undo, { label });
	const untrack = useBackendOperation(interpretApi.reactions.untrack, { label });
	const notARequest = useBackendOperation(interpretApi.reactions.notARequest, { label });
	const remind = useBackendOperation(interpretApi.reactions.remind, { label });
	const confirm = useBackendOperation(interpretApi.reactions.confirmProposal, { label });
	const markReceived = useBackendOperation(interpretApi.reactions.markReceived, { label });

	async function run(item: BriefItemView, action: BriefAction): Promise<void> {
		if (action !== 'undo' && action !== 'confirmProposal' && isReplyReaction(action)) {
			opts.onReply(item, action);
			return;
		}
		const itemId = item.id;
		switch (action) {
			case 'markDone':
			case 'markPaid': {
				const result = await markDone.run({ itemId });
				if (result.ok) {
					showToast(t('components.brief.toast.markedDone'), 'success', {
						action: { label: t('common.undo'), onAction: () => void undo.run({ itemId }) },
					});
				}
				return;
			}
			case 'markReceived':
				await markReceived.run({ itemId });
				return;
			case 'untrack':
				await untrack.run({ itemId });
				return;
			case 'notARequest':
				await notARequest.run({ itemId });
				return;
			case 'remind': {
				const result = await remind.run({ itemId, remindAt: nextMorning() });
				if (result.ok) showToast(t('components.brief.toast.reminder'), 'success');
				return;
			}
			case 'undo':
				await undo.run({ itemId });
				return;
			case 'confirmProposal':
				await confirm.run({ itemId });
				return;
			default:
				// `assign` is a team verb; personal mailboxes never offer it.
				return;
		}
	}

	return { run };
}
