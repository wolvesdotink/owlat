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
 *
 * `tone="clear"` is for states where empty is the GOOD outcome (inbox zero,
 * nothing quarantined, no failures): a check glyph and an "All clear" eyebrow
 * instead of wording that implies something is still expected to arrive.
 *
 * The `empty` variant has no default eyebrow — "Nothing here yet" read wrong on
 * every page where empty is fine. Pass `eyebrow` when the page wants one.
 */
import { computed, getCurrentInstance, useSlots } from 'vue';
import { useUiI18n } from '../../composables/useUiI18n';

type EmptyStateVariant = 'empty' | 'no-results';
type EmptyStateTone = 'default' | 'clear';

interface Props {
	/** The one line that says what is missing. Rendered as a real heading. */
	title: string;
	/**
	 * Uppercase micro-label above the title. Only `no-results` and
	 * `tone="clear"` have a default; otherwise none renders unless passed.
	 */
	eyebrow?: string;
	/** One secondary lead sentence. Keep it to a sentence. */
	description?: string;
	/** Decorative glyph inside the eyebrow row. No disc, no fill. */
	icon?: string;
	variant?: EmptyStateVariant;
	/** `clear` marks an empty that is good news: check glyph, "All clear". */
	tone?: EmptyStateTone;
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
	tone: 'default',
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

const isClear = computed(() => props.tone === 'clear');

const eyebrowText = computed<string | undefined>(() => {
	if (props.eyebrow) return props.eyebrow;
	if (isClear.value) return t('ui.emptyState.allClear');
	if (isNoResults.value) return t('ui.emptyState.noResults');
	return undefined;
});

const eyebrowIcon = computed(
	() => props.icon ?? (isClear.value ? 'lucide:circle-check' : undefined)
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
	<div class="flex flex-col items-center px-6 text-center" :class="isNoResults ? 'py-10' : 'py-12'">
		<p
			v-if="eyebrowText"
			class="lp-eyebrow flex items-center justify-center gap-1.5"
			:class="isClear ? 'text-success' : undefined"
			:data-tone="tone"
		>
			<Icon
				v-if="eyebrowIcon"
				:name="eyebrowIcon"
				class="w-3.5 h-3.5 shrink-0"
				aria-hidden="true"
			/>
			<span>{{ eyebrowText }}</span>
		</p>
		<Icon
			v-else-if="eyebrowIcon"
			:name="eyebrowIcon"
			class="w-4 h-4 shrink-0 text-text-tertiary"
			aria-hidden="true"
		/>

		<component
			:is="headingTag"
			:class="[eyebrowText || eyebrowIcon ? 'mt-3' : '', isNoResults ? 'text-lg' : 'text-xl']"
			class="max-w-xl text-balance font-medium tracking-[-0.02em] text-text-primary"
		>
			{{ title }}
		</component>

		<p v-if="description" class="mt-2 max-w-md text-sm leading-relaxed text-text-secondary">
			{{ description }}
		</p>

		<!-- Pairs with page-header-actions: same label, different region. -->
		<div v-if="hasAction" data-testid="empty-state-action" class="mt-5">
			<slot name="action" />
			<slot />
		</div>

		<UiButton
			v-else-if="showClear"
			variant="secondary"
			size="sm"
			class="mt-5"
			@click="emit('clear')"
		>
			{{ clearLabel ?? t('ui.emptyState.clear') }}
		</UiButton>
	</div>
</template>
