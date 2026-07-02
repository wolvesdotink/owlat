<script setup lang="ts">
import { trackerPixelLabel, type TrackerDetection } from '@owlat/shared/postboxTrackers';

/**
 * Quiet shield badge for the reader header: shows that probable tracking
 * pixels were detected in a message, with a popover naming the tracker
 * hosts. Purely informational — blocking/stripping happens in
 * PostboxMessageBody; this badge only surfaces what was found.
 */
const props = defineProps<{
	detection: TrackerDetection;
}>();

const open = ref(false);
const rootRef = ref<HTMLElement | null>(null);

const label = computed(() => `${trackerPixelLabel(props.detection.pixelCount)} detected`);

// Close on outside click (shared composable owns the listener lifecycle)
// and on Escape.
useClickOutside(rootRef, () => {
	if (open.value) open.value = false;
});
const handleEscape = (event: KeyboardEvent) => {
	if (event.key === 'Escape') open.value = false;
};
watch(open, (isOpen) => {
	if (isOpen) document.addEventListener('keydown', handleEscape);
	else document.removeEventListener('keydown', handleEscape);
});
onUnmounted(() => document.removeEventListener('keydown', handleEscape));
</script>

<template>
	<span ref="rootRef" class="relative inline-flex">
		<button
			type="button"
			class="inline-flex items-center text-text-tertiary hover:text-text-primary"
			:title="label"
			:aria-label="label"
			:aria-expanded="open"
			@click="open = !open"
		>
			<Icon name="lucide:shield" class="w-3.5 h-3.5" />
		</button>
		<div
			v-if="open"
			class="absolute right-0 top-full mt-1 z-20 w-64 rounded border border-border-subtle bg-bg-elevated shadow-lg p-3 text-left"
			role="dialog"
			:aria-label="label"
		>
			<p class="text-xs font-medium text-text-primary flex items-center gap-1.5">
				<Icon name="lucide:shield" class="w-3.5 h-3.5 flex-shrink-0" />
				{{ label }}
			</p>
			<p class="mt-1 text-xs text-text-secondary">
				This message contains hidden images that would report when and where
				you open it. They stay blocked even when you show images.
			</p>
			<template v-if="detection.trackerHosts.length > 0">
				<p class="mt-2 text-[11px] uppercase tracking-wide text-text-tertiary">
					Tracker hosts
				</p>
				<ul class="mt-1 space-y-0.5">
					<li
						v-for="host in detection.trackerHosts"
						:key="host"
						class="text-xs font-mono text-text-secondary truncate"
						:title="host"
					>
						{{ host }}
					</li>
				</ul>
			</template>
		</div>
	</span>
</template>
