<script setup lang="ts">
/**
 * The shared empty state, built on the landing page's header ladder:
 * eyebrow → heading → one lead sentence → one action. Nothing else.
 *
 * Two deliberate departures from the version this replaces:
 *
 *  1. THE TITLE IS A REAL HEADING. It was a `<p class="font-semibold">`, so a
 *     screen-reader heading walk of a page whose only content is its empty
 *     state landed on nothing at all, and the emphasis came from weight 550 on
 *     body copy rather than from the type scale. `headingLevel` exists because
 *     the same component renders both as a page's whole content (h2 under the
 *     page h1) and inside a section that already has one (h3).
 *  2. NO ICON DISC. The 56px filled grey circle was the loudest thing on an
 *     otherwise empty screen and read as a broken image. `icon` survives as a
 *     hairline-sized glyph inside the eyebrow — tertiary, unfilled, decorative.
 *
 * `variant` splits the two states that were previously worded identically:
 *  - `empty` — there is nothing yet. The action CREATES the first row.
 *  - `no-results` — there is data, the current filter/search hides it. Quieter
 *    (less vertical air, smaller heading) because it is a transient state, and
 *    the action UNDOES the filter: wire `@clear` for the default "Clear
 *    filters" control, or pass your own through `#action`.
 */
import { computed, getCurrentInstance, useSlots } from 'vue';
import { useUiI18n } from '../../composables/useUiI18n';

type EmptyStateVariant = 'empty' | 'no-results';

interface Props {
	/** The one line that says what is missing. Rendered as a real heading. */
	title: string;
	/** Uppercase micro-label above the title. Defaults per variant. */
	eyebrow?: string;
	/** One secondary lead sentence. Keep it to a sentence. */
	description?: string;
	/** Decorative glyph inside the eyebrow row. No disc, no fill. */
	icon?: string;
	variant?: EmptyStateVariant;
	/** Heading level, so the state slots into the page's heading walk. */
	headingLevel?: 2 | 3 | 4;
	/** Label for the built-in `no-results` clear control. */
	clearLabel?: string;
}

const props = withDefaults(defineProps<Props>(), {
	eyebrow: undefined,
	description: undefined,
	icon: undefined,
	variant: 'empty',
	headingLevel: 2,
	clearLabel: undefined,
});

const emit = defineEmits<{
	/** Fired by the built-in `no-results` control. Wire it to reset the filter. */
	clear: [];
}>();

const { t } = useUiI18n();
const slots = useSlots();

// Captured during setup for the same reason QueryBoundary does it:
// `getCurrentInstance()` is null once the render function has run.
const instance = getCurrentInstance();
const hasClearListener = computed(() => !!instance?.vnode.props?.['onClear']);

const isNoResults = computed(() => props.variant === 'no-results');

const headingTag = computed(() => `h${props.headingLevel}` as 'h2' | 'h3' | 'h4');

const eyebrowText = computed(
	() =>
		props.eyebrow ?? t(isNoResults.value ? 'ui.emptyState.noResults' : 'ui.emptyState.nothingYet')
);

/**
 * `default` counts as well as `action`: several call sites pass the button as
 * the component's children, and the version this replaces rendered ONLY
 * `#action` — so those buttons silently did not exist.
 */
const hasAction = computed(() => !!slots['action'] || !!slots['default']);

const showClear = computed(() => isNoResults.value && !hasAction.value && hasClearListener.value);
</script>

<template>
	<div
		class="flex flex-col items-center px-6 text-center"
		:class="isNoResults ? 'py-12' : 'py-16'"
	>
		<p class="lp-eyebrow flex items-center justify-center gap-1.5">
			<Icon v-if="icon" :name="icon" class="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
			<span>{{ eyebrowText }}</span>
		</p>

		<component
			:is="headingTag"
			class="mt-3 max-w-xl text-balance font-medium tracking-[-0.02em] text-text-primary"
			:class="isNoResults ? 'text-lg' : 'text-2xl'"
		>
			{{ title }}
		</component>

		<p v-if="description" class="mt-2 max-w-md text-md text-text-secondary">
			{{ description }}
		</p>

		<div v-if="hasAction" class="mt-6">
			<slot name="action" />
			<slot />
		</div>

		<UiButton
			v-else-if="showClear"
			variant="secondary"
			size="sm"
			class="mt-6"
			@click="emit('clear')"
		>
			{{ clearLabel ?? t('ui.emptyState.clear') }}
		</UiButton>
	</div>
</template>
