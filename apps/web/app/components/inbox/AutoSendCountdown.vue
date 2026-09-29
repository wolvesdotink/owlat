<script setup lang="ts">
import { useNow } from '~/composables/useNow';

/**
 * "Sending automatically in 9s — Undo" on a team-inbox message whose approved
 * reply waits out its hold before going out, and "Sending in 9s — Undo" on a
 * follow-up inside its undo window (InboxThreadOutbound). Owns its 250 ms
 * clock, so only this bar re-renders while it counts, and hides itself once
 * the window has run out; the parent runs the cancel.
 */
const props = withDefaults(
	defineProps<{
		/** Epoch ms the held reply goes out. */
		sendAt: number;
		busy?: boolean;
		/** i18n key for the line; gets `{ seconds }`. */
		labelKey?: string;
	}>(),
	{ busy: false, labelKey: 'dashboard.inbox.detail.sendingAutomatically' }
);

const emit = defineEmits<{
	(e: 'cancel'): void;
}>();

const { t } = useI18n();

const now = useNow({ intervalMs: 250 });
const secondsLeft = computed(() => Math.max(0, Math.ceil((props.sendAt - now.value) / 1000)));
</script>

<template>
	<div
		v-if="secondsLeft > 0"
		class="mt-4 flex items-center justify-between gap-3 rounded-lg border border-brand/20 bg-brand-subtle/30 p-3"
		data-testid="auto-send-countdown"
	>
		<div class="flex items-center gap-2 text-sm text-text-primary">
			<Icon name="lucide:send" class="h-4 w-4 text-brand" />
			{{ t(labelKey, { seconds: secondsLeft }) }}
		</div>
		<UiButton variant="secondary" size="sm" :loading="busy" @click="emit('cancel')">
			{{ t('dashboard.inbox.detail.undo') }}
		</UiButton>
	</div>
</template>
