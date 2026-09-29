<script setup lang="ts">
/**
 * The "Sending in 58s — Undo" toast for a campaign send.
 *
 * An undo window (useCampaignUndoSend) armed by whichever surface pressed
 * send, shown through the shared countdown toast (UiUndoCountdownToast), and an
 * Undo button that reverses it. Auto-dismisses when the window elapses — the
 * send is on its way and there is nothing left to offer.
 *
 * The held send is a REAL scheduled campaign (the send button schedules ~60s
 * out instead of firing `sendNow`), so undo is
 * `campaigns.scheduling.unschedule` — the existing scheduled-campaign reversal
 * that puts the campaign back to `draft`. Deliberately not `scheduling.cancel`:
 * `cancelled` is a terminal lifecycle state, so cancelling would answer "I
 * didn't mean to press that" by destroying the campaign. Undo has to leave the
 * operator exactly where they were, which is an editable draft.
 *
 * Unlike the other undo toasts this one closes only once the reversal
 * succeeded: a refused unschedule means the send is still coming, so the
 * window stays open. The shared toast's busy guard keeps a double click from
 * unscheduling twice.
 */
import { api } from '@owlat/api';
import UiUndoCountdownToast from '~/components/ui/UndoCountdownToast.vue';

const { t } = useI18n();
const router = useRouter();
const { showToast } = useToast();

const { state, dismiss } = useCampaignUndoSend();

const { run: unscheduleCampaign } = useBackendOperation(api.campaigns.scheduling.unschedule, {
	label: () => t('components.campaigns.undoSendToast.undoOperation'),
});

function message(seconds: number): string {
	return t('components.campaigns.undoSendToast.sending', {
		name: state.value.campaignName,
		seconds,
	});
}

async function undoCampaignSend() {
	const campaignId = state.value.campaignId;
	if (!campaignId) {
		dismiss();
		return;
	}
	const result = await unscheduleCampaign({ campaignId });
	if (!result.ok) return;
	dismiss();
	showToast(t('components.campaigns.undoSendToast.undone'));
	// Back to the editor the send was launched from: the campaign is a draft
	// again, and the report of a send that never happened is not a place to
	// leave anyone standing.
	router.push(`/dashboard/campaigns/${campaignId}/edit`);
}
</script>

<template>
	<UiUndoCountdownToast
		:visible="state.visible"
		:send-at="state.sendAt"
		icon="lucide:send"
		:message="message"
		:undo-label="t('components.campaigns.undoSendToast.undo')"
		:on-undo="undoCampaignSend"
		@expire="dismiss"
	/>
</template>
