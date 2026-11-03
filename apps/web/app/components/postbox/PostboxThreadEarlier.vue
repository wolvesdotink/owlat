<script setup lang="ts">
/**
 * "Load earlier messages" at the top of a long conversation (plan 3.3). The
 * reader loads a thread's newest page; this control asks for the page before
 * the loaded ones. When a page fails, the same control retries it.
 */
import { ChevronDoubleUpIcon } from '@coolicons/vue';

const props = defineProps<{
	/** Messages of the thread not loaded yet; 0 when the thread doesn't say. */
	remaining: number;
	loading: boolean;
	failed: boolean;
}>();

const emit = defineEmits<{ load: [] }>();

const { t } = useI18n();

const label = computed(() =>
	props.remaining > 0
		? t(
				'components.postbox.postboxThreadEarlier.loadCount',
				{ count: props.remaining },
				props.remaining
			)
		: t('components.postbox.postboxThreadEarlier.load')
);
</script>

<template>
	<div class="flex flex-col items-center gap-1 py-1">
		<UiButton variant="ghost" size="sm" :loading="loading" @click="emit('load')">
			<ChevronDoubleUpIcon class="w-4 h-4 mr-1.5" aria-hidden="true" />
			{{ label }}
		</UiButton>
		<p v-if="failed" role="alert" class="text-xs text-error">
			{{ t('components.postbox.postboxThreadEarlier.failed') }}
		</p>
	</div>
</template>
