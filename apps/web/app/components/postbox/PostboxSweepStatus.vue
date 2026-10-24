<script setup lang="ts">
import type { PostboxSweepMark } from '~/utils/postboxSweep';

/**
 * The count pill a sweep shows while the button is down: what releasing will
 * do, to how many rows, and that Esc backs out. Without it a sweep over rows
 * scrolled out of view, or an Archive sweep's dimmed rows, would not say how
 * much is about to happen.
 */
const props = defineProps<{
	status: { mark: PostboxSweepMark; count: number } | null;
	/**
	 * The plural message for the count, when the rows are not messages (the
	 * all-inboxes list sweeps conversations). Default: the mark's own key.
	 */
	labelKey?: string;
}>();
const { t } = useI18n();
</script>

<template>
	<div
		v-if="status"
		role="status"
		data-testid="postbox-sweep-status"
		class="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-text-primary px-3 py-1.5 text-xs text-text-inverse shadow-lg"
	>
		<span class="font-medium">{{
			t(
				props.labelKey ?? `components.postbox.postboxSweepStatus.${status.mark}`,
				{ count: status.count },
				status.count
			)
		}}</span>
		<span class="opacity-70"> · {{ t('components.postbox.postboxSweepStatus.escHint') }}</span>
	</div>
</template>
