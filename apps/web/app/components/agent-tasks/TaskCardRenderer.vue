<script setup lang="ts">
/**
 * The task-card dispatcher — the ONE place a focused flow (Reply Queue / Review
 * Queue) hands off a card whose kind it does not render natively. It resolves
 * the kind through the task-card registry and:
 *   - a registered, feature-enabled plugin kind → lazily mounts that plugin's
 *     card component (a spinner while it fetches; if it fails to LOAD or throws
 *     while RENDERING, the error is captured at this boundary and the graceful
 *     placeholder is shown instead, so a broken plugin can never crash the flow);
 *   - a disabled kind (flag off) or an unknown kind → the graceful placeholder.
 *
 * The queue item is never dropped: every branch is skippable, and `skip`/`open`
 * bubble up to the flow so it can advance or navigate. Plugin cards receive the
 * opaque `item` plus `complete`/`skip`/`open` emits — they can add work, never
 * bypass the host's ordering, gating, or fallback.
 *
 * Explicitly imported by the flows; never relied on via auto-import.
 */
import {
	computed,
	defineAsyncComponent,
	onErrorCaptured,
	shallowRef,
	watch,
	type Component,
} from 'vue';
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import TaskCardFallback from '~/components/agent-tasks/TaskCardFallback.vue';
import TaskCardLoading from '~/components/agent-tasks/TaskCardLoading.vue';
import type { TaskFlowKind } from '~/utils/taskFlow';
import {
	taskCardRegistry,
	type TaskCardRegistry,
	type TaskCardResolution,
} from '~/utils/taskCardRegistry';

const props = withDefaults(
	defineProps<{
		/** The kind of the current card (may be a plugin kind or an unknown one). */
		kind: TaskFlowKind;
		/** Opaque flow item handed to the plugin card component. */
		item?: unknown;
		/** Feature-flag predicate (from useFeatureFlag) for gating plugin kinds. */
		isFlagEnabled?: (flag: FeatureFlagKey) => boolean;
		/** Whether an "Open" affordance makes sense (a destination exists). */
		canOpen?: boolean;
		/** The registry to resolve against (defaults to the app-wide singleton). */
		registry?: TaskCardRegistry;
	}>(),
	{ item: undefined, isFlagEnabled: () => true, canOpen: false, registry: () => taskCardRegistry }
);

const emit = defineEmits<{
	(e: 'skip'): void;
	(e: 'open'): void;
	(e: 'complete', outcome?: string): void;
}>();

const resolution = computed<TaskCardResolution>(() =>
	props.registry.resolve(props.kind, props.isFlagEnabled)
);

// A load OR render error inside a mounted plugin card must not tear down the
// flow — it collapses this card to the fallback placeholder.
const renderFailed = shallowRef(false);
watch(
	() => props.kind,
	() => {
		renderFailed.value = false;
	}
);
onErrorCaptured(() => {
	renderFailed.value = true;
	// Swallow so the error stops at this boundary and the fallback renders.
	return false;
});

// One cached async wrapper per kind, so re-resolves don't re-create the loader.
const asyncCards = new Map<string, Component>();
const pluginCard = computed<Component | null>(() => {
	const r = resolution.value;
	if (r.status !== 'plugin') return null;
	const cached = asyncCards.get(r.definition.kind);
	if (cached) return cached;
	const wrapped = defineAsyncComponent({
		loader: async () => {
			const mod = await r.load();
			return ((mod as { default?: Component }).default ?? mod) as Component;
		},
		loadingComponent: TaskCardLoading,
		delay: 120,
	});
	asyncCards.set(r.definition.kind, wrapped);
	return wrapped;
});

const showFallback = computed(() => resolution.value.status !== 'plugin' || renderFailed.value);
</script>

<template>
	<TaskCardFallback
		v-if="showFallback"
		:reason="resolution.status === 'disabled' ? 'disabled' : 'unknown'"
		:kind="kind"
		:label="resolution.status === 'disabled' ? resolution.label : ''"
		:can-open="canOpen"
		@skip="emit('skip')"
		@open="emit('open')"
	/>
	<component
		:is="pluginCard"
		v-else-if="pluginCard"
		:item="item"
		@skip="emit('skip')"
		@open="emit('open')"
		@complete="(outcome?: string) => emit('complete', outcome)"
	/>
</template>
