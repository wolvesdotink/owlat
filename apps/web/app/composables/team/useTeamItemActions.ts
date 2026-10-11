/**
 * What a teammate does to an item in the "Open for the team" strip (SPEC §5
 * reactions, §7 "Team"): the brief's reactions (`useBriefReactions`), plus
 * Claim (take it yourself, atomically; a teammate who already holds it keeps
 * it) and Assign (hand it to someone, or back to Unassigned). Neither changes
 * who is responsible or whether it is done.
 */
import type { BriefItemView } from '../../../../api/convex/mail/interpret/briefShape';
import { interpretApi } from '~/composables/threadBrief/briefApi';
import { useBriefReactions } from '~/composables/threadBrief/useBriefReactions';
import type { BriefAction } from '~/utils/threadBriefItems';

export function useTeamItemActions(opts: {
	/** Open Answer mode for this item (the replying reactions). */
	onReply: (item: BriefItemView, action: BriefAction) => void;
}) {
	const { t } = useI18n();
	const { showToast } = useToast();
	const label = () => t('components.team.items.operation');
	const reactions = useBriefReactions({ onReply: opts.onReply });
	const claimOp = useBackendOperation(interpretApi.reactions.claimItem, { label });
	const assignOp = useBackendOperation(interpretApi.reactions.assignItem, { label });

	async function claim(item: BriefItemView): Promise<boolean> {
		const result = await claimOp.run({ itemId: item.id });
		if (result.ok) showToast(t('components.team.items.claimed'), 'success');
		return result.ok;
	}

	async function assign(item: BriefItemView, assigneeUserId: string | null): Promise<boolean> {
		return (await assignOp.run({ itemId: item.id, assigneeUserId })).ok;
	}

	return { react: reactions.run, claim, assign, isClaiming: claimOp.isLoading };
}
