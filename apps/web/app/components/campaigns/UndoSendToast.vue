<script setup lang="ts">
/**
 * The "Sending in 58s — Undo" toast for a campaign send.
 *
 * Mirrors PostboxUndoSendToast: a singleton state machine (useCampaignUndoSend)
 * armed by whichever surface pressed send, a live countdown to the held send's
 * `sendAt`, and an Undo button that reverses it. Auto-dismisses when the window
 * elapses — the send is on its way and there is nothing left to offer.
 *
 * The held send is a REAL scheduled campaign (the send button schedules ~60s
 * out instead of firing `sendNow`), so undo is
 * `campaigns.scheduling.unschedule` — the existing scheduled-campaign reversal
 * that puts the campaign back to `draft`. Deliberately not `scheduling.cancel`:
 * `cancelled` is a terminal lifecycle state, so cancelling would answer "I
 * didn't mean to press that" by destroying the campaign. Undo has to leave the
 * operator exactly where they were, which is an editable draft.
 */
import { api } from '@owlat/api';

const { t } = useI18n();
const router = useRouter();
const { showToast } = useToast();

const { state, dismiss } = useCampaignUndoSend();

const { run: unscheduleCampaign } = useBackendOperation(api.campaigns.scheduling.unschedule, {
	label: () => t('components.campaigns.undoSendToast.undoOperation'),
});

const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
	timer = setInterval(() => {
		now.value = Date.now();
	}, 250);
});
onUnmounted(() => {
	if (timer) clearInterval(timer);
});

const remainingMs = computed(() => Math.max(0, state.value.sendAt - now.value));
const remainingSec = computed(() => Math.ceil(remainingMs.value / 1000));

watch(remainingMs, (ms) => {
	if (state.value.visible && ms <= 0) {
		dismiss();
	}
});

const busy = ref(false);

async function handleUndo() {
	const campaignId = state.value.campaignId;
	if (busy.value || !campaignId) {
		dismiss();
		return;
	}
	busy.value = true;
	try {
		const result = await unscheduleCampaign({ campaignId });
		if (!result.ok) return;
		dismiss();
		showToast(t('components.campaigns.undoSendToast.undone'));
		// Back to the editor the send was launched from: the campaign is a draft
		// again, and the report of a send that never happened is not a place to
		// leave anyone standing.
		router.push(`/dashboard/campaigns/${campaignId}/edit`);
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<Transition name="pbx-toast">
		<div
			v-if="state.visible && remainingSec > 0"
			role="status"
			class="fixed bottom-4 left-4 bg-text-primary text-text-inverse rounded-md shadow-lg px-4 py-3 flex items-center gap-3 z-50"
		>
			<Icon name="lucide:send" class="w-4 h-4" />
			<span class="text-sm">{{
				t('components.campaigns.undoSendToast.sending', {
					name: state.campaignName,
					seconds: remainingSec,
				})
			}}</span>
			<button
				type="button"
				class="text-sm font-semibold text-brand hover:underline"
				:disabled="busy"
				@click="handleUndo"
			>
				{{ t('components.campaigns.undoSendToast.undo') }}
			</button>
		</div>
	</Transition>
</template>
