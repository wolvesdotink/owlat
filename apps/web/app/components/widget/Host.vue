<script setup lang="ts" generic="Ctx = void">
/**
 * WidgetHost — the isolation boundary every panel/widget contribution renders
 * through. It lazily mounts a `WidgetModule.component`, passing an optional typed
 * `context`, and wraps it so a contribution that throws (including a broken
 * plugin panel) is caught, logged, and replaced by an accessible fallback —
 * without propagating the error up and taking the surrounding page down.
 *
 * States handled: loading (async chunk in flight), error (isolated), and content.
 */
import { ref, computed, onErrorCaptured, defineAsyncComponent } from 'vue';
import type { WidgetModule } from '~/composables/widgets/types';

const props = defineProps<{
	/** The resolved widget module to render. */
	module: WidgetModule;
	/**
	 * Typed context handed to the contribution as a `context` prop. Omitted for
	 * surfaces (e.g. dashboard cards) whose contributions take no context, so no
	 * stray attribute is bound.
	 */
	context?: Ctx;
}>();

const error = ref<Error | null>(null);
// Bumped on retry. `defineAsyncComponent` caches its loader promise — including a
// rejection — for the life of the wrapper, so recovering a failed chunk load
// requires a *fresh* wrapper. Keying the async component on this counter builds
// one per attempt, which re-invokes the loader and genuinely re-fetches.
const attempt = ref(0);

const asyncComponent = computed(() => {
	void attempt.value;
	return defineAsyncComponent(props.module.component);
});

onErrorCaptured((err) => {
	error.value = err instanceof Error ? err : new Error(String(err));
	// Surface for debugging; the fallback UI otherwise hides it.
	console.error(`[WidgetHost] widget "${props.module.kind}" failed and was isolated:`, err);
	// Stop propagation: a single broken widget must never crash the page.
	return false;
});

const regionLabel = computed(() => props.module.label ?? props.module.kind);
const boundProps = computed(() => (props.context === undefined ? {} : { context: props.context }));

function retry() {
	error.value = null;
	// New wrapper → the loader runs again, so a transient chunk-load failure or a
	// component that has since recovered can actually re-render.
	attempt.value += 1;
}
</script>

<template>
	<section class="contents" role="region" :aria-label="regionLabel">
		<div
			v-if="error"
			role="alert"
			class="p-4 rounded-lg border border-error/20 bg-error/5 text-center"
		>
			<div class="flex flex-col items-center gap-2">
				<Icon name="lucide:alert-circle" class="w-6 h-6 text-error" />
				<p class="text-sm text-text-secondary">
					This panel ran into a problem and was hidden to keep the rest of the page working.
				</p>
				<button
					class="px-3 py-1 text-sm font-medium bg-bg-elevated border border-border-default rounded-md hover:bg-bg-base transition-colors"
					@click="retry"
				>
					Try again
				</button>
			</div>
		</div>
		<Suspense v-else :key="attempt">
			<component :is="asyncComponent" v-bind="boundProps" />
			<template #fallback>
				<div class="p-4 flex items-center justify-center gap-2" aria-busy="true">
					<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
					<span class="sr-only">Loading {{ regionLabel }}…</span>
				</div>
			</template>
		</Suspense>
	</section>
</template>
