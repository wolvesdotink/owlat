<script setup lang="ts">
import { useBackendStatus } from '~/composables/useBackendStatus';

/**
 * The backend connection dot for the shell chrome (sidebar footer, desktop
 * titlebar). Renders nothing while connected: a healthy connection is the
 * normal state and needs no ink. Shown only once a drop has outlasted the grace
 * period (`~/lib/backendConnection`), so a blip never flickers it.
 *
 * Not a live region: both surfaces can be on screen at once, and two regions
 * would read every change twice. `BackendStatusHost` announces the changes once.
 */
const props = defineProps<{
	/** Dot only, the label kept for screen readers (the collapsed rail). */
	compact?: boolean;
	/**
	 * Inside the desktop titlebar: Tauri starts a window drag only when the
	 * mousedown target itself carries the attribute, so every element here does.
	 */
	dragRegion?: boolean;
}>();

const { phase, label, hint } = useBackendStatus();
const dotClass = computed(() => (phase.value === 'updating' ? 'bg-info' : 'bg-warning'));
const drag = computed(() => (props.dragRegion ? '' : undefined));
</script>

<template>
	<span
		v-if="phase"
		class="inline-flex min-w-0 shrink-0 items-center gap-1.5 text-xs text-text-secondary"
		:title="hint"
		:data-phase="phase"
		:data-tauri-drag-region="drag"
		data-testid="connection-indicator"
	>
		<span
			class="relative flex size-2.5 shrink-0 items-center justify-center"
			aria-hidden="true"
			:data-tauri-drag-region="drag"
		>
			<span
				class="absolute inline-flex size-full rounded-full opacity-50 motion-safe:animate-ping"
				:class="dotClass"
				:data-tauri-drag-region="drag"
			/>
			<span
				class="relative inline-flex size-2 rounded-full"
				:class="dotClass"
				:data-tauri-drag-region="drag"
			/>
		</span>
		<span :class="props.compact ? 'sr-only' : 'truncate'" :data-tauri-drag-region="drag">{{
			label
		}}</span>
	</span>
</template>
