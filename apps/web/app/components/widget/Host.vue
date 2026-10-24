<script setup lang="ts" generic="Ctx = void">
/**
 * WidgetHost — the isolation boundary every panel/widget contribution renders
 * through. It lazily mounts a `WidgetModule.component`, passing an optional typed
 * `context`, and wraps it so a contribution that throws (including a broken
 * plugin panel) is caught, logged, and replaced by an accessible fallback —
 * without propagating the error up and taking the surrounding page down.
 *
 * States handled: loading (async chunk in flight), error (isolated), and content.
 * Capturing the failure and clearing it again (Retry, or a different module
 * in the same host) is the shared UiErrorBoundary's job; this host owns the
 * fresh loader per attempt, the loading state and focus.
 */
import { ref, computed, nextTick, defineAsyncComponent } from 'vue';
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

const { t } = useI18n();

// The labelled region wrapper. Activating "Try again" unmounts the button that
// held focus, so focus must be moved somewhere sensible or it falls to <body>.
// The <section> that carries this ref must stay a box-generating element: a
// `display: contents` element (e.g. Tailwind's `contents` utility) generates no
// box and cannot be focused in real browsers, so `focus()` would silently no-op.
// happy-dom does NOT model that, so a regression to `display: contents` here
// would still pass every focus test in this suite — keep the target a real box.
const regionRef = ref<HTMLElement | null>(null);
// Bumped on retry. Keying a *fresh* `defineAsyncComponent` on this counter builds
// one wrapper per attempt, so retry re-invokes the loader *by construction* and a
// chunk that failed to load can genuinely re-fetch. This makes the retry guarantee
// self-contained rather than leaning on Vue's internal async-wrapper bookkeeping
// (3.5 happens to clear `pendingRequest` on a rejected load, but that is
// undocumented and version-dependent, so we do not depend on it).
const attempt = ref(0);

const asyncComponent = computed(() => {
	void attempt.value;
	return defineAsyncComponent(props.module.component);
});

const regionLabel = computed(() => props.module.label ?? props.module.kind);
const boundProps = computed(() => (props.context === undefined ? {} : { context: props.context }));

function retry(clearFailure: () => void) {
	clearFailure();
	// New wrapper → the loader runs again, so a transient chunk-load failure or a
	// component that has since recovered can actually re-render.
	attempt.value += 1;
	// Keep keyboard/screen-reader focus inside the widget across the transition:
	// the retry button has just unmounted. On a re-failure the freshly-rendered
	// alert is inside this region, so focus lands next to it (and the role=alert
	// is announced); on success focus rests at the top of the recovered widget.
	void nextTick(() => regionRef.value?.focus());
}
</script>

<template>
	<section ref="regionRef" role="region" tabindex="-1" :aria-label="regionLabel">
		<!-- No `capture` filter: every error from a contribution stops here, not
		     only render failures, because a broken widget (often a plugin) must
		     never reach the page. Reset keys: a host handed a different module
		     starts clean even after the previous one failed. -->
		<UiErrorBoundary :name="`widget:${module.kind}`" :reset-keys="[module.kind, module.component]">
			<Suspense :key="attempt">
				<component :is="asyncComponent" v-bind="boundProps" />
				<template #fallback>
					<div class="p-4 flex items-center justify-center gap-2" aria-busy="true">
						<Icon
							name="lucide:loader-2"
							class="w-5 h-5 animate-spin motion-reduce:animate-none text-text-tertiary"
						/>
						<span class="sr-only">{{
							t('components.widget.host.loading', { label: regionLabel })
						}}</span>
					</div>
				</template>
			</Suspense>
			<template #fallback="{ retry: clearFailure }">
				<div role="alert" class="p-4 rounded-lg border border-error/20 bg-error/5 text-center">
					<div class="flex flex-col items-center gap-2">
						<Icon name="lucide:alert-circle" class="w-6 h-6 text-error" />
						<p class="text-sm text-text-secondary">
							{{ t('components.widget.host.failed') }}
						</p>
						<UiButton variant="secondary" size="sm" @click="retry(clearFailure)">
							{{ t('components.widget.host.tryAgain') }}
						</UiButton>
					</div>
				</div>
			</template>
		</UiErrorBoundary>
	</section>
</template>
