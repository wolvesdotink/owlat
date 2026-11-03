<script setup lang="ts">
/**
 * The AI selection-rewrite action buttons (Shorter / Friendlier / More formal /
 * Fix grammar + a Translate… submenu of recent target languages).
 *
 * Pure presentation, extracted so the SAME buttons can render in two places:
 *   - {@link PostboxRewritePill} — the standalone floating pill over a selection
 *     (used when the classic persistent toolbar is on).
 *   - {@link PostboxFloatingFormatBar} — the combined bar (format commands left,
 *     these AI actions right) shown in the default floating-toolbar mode.
 *
 * Advisory only: clicking an option asks the parent to fetch a rewrite and show
 * a preview; nothing is applied here.
 */

import { ref } from 'vue';
import type { RewriteIntent } from '~/composables/postbox/usePostboxSelectionRewrite';
import {
	BriefcaseIcon,
	ChevronDownIcon,
	FaceSmileIcon,
	ScissorsIcon,
	SpellCheckIcon,
	TranslateIcon,
	type IconComponent,
} from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

const { t } = useI18n();

defineProps<{
	/** True while a rewrite request is in flight (disables the buttons). */
	loading?: boolean;
	/** The intent currently loading, for a per-button spinner. */
	activeIntent?: RewriteIntent | null;
	/** Recent + default translate targets. */
	languages: string[];
}>();

const emit = defineEmits<{
	(e: 'select', payload: { intent: RewriteIntent; targetLanguage?: string }): void;
}>();

const showTranslate = ref(false);

function pick(intent: RewriteIntent) {
	emit('select', { intent });
}

function pickLanguage(language: string) {
	showTranslate.value = false;
	emit('select', { intent: 'translate', targetLanguage: language });
}

/** Labels are message KEYS — the template resolves them so a locale switch repaints. */
const OPTIONS: { intent: RewriteIntent; label: string; icon: IconComponent }[] = [
	{
		intent: 'shorter',
		label: 'components.postbox.postboxRewriteActions.shorter',
		icon: ScissorsIcon,
	},
	{
		intent: 'friendlier',
		label: 'components.postbox.postboxRewriteActions.friendlier',
		icon: FaceSmileIcon,
	},
	{
		intent: 'formal',
		label: 'components.postbox.postboxRewriteActions.formal',
		icon: BriefcaseIcon,
	},
	{
		intent: 'grammar',
		label: 'components.postbox.postboxRewriteActions.grammar',
		icon: SpellCheckIcon,
	},
];
</script>

<template>
	<div class="flex items-center gap-0.5" data-testid="postbox-rewrite-actions">
		<button
			v-for="opt in OPTIONS"
			:key="opt.intent"
			type="button"
			class="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-text-secondary hover:bg-bg-surface disabled:opacity-50"
			:disabled="loading"
			@click="pick(opt.intent)"
		>
			<SpinnerIcon v-if="loading && activeIntent === opt.intent" class="h-3.5 w-3.5" />
			<component v-else :is="opt.icon" class="h-3.5 w-3.5" />
			<span>{{ t(opt.label) }}</span>
		</button>
		<div class="relative">
			<UiTooltip :text="t('components.postbox.postboxRewriteActions.translateTitle')">
				<button
					type="button"
					class="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-text-secondary hover:bg-bg-surface disabled:opacity-50"
					:disabled="loading"
					@click="showTranslate = !showTranslate"
				>
					<SpinnerIcon v-if="loading && activeIntent === 'translate'" class="h-3.5 w-3.5" />
					<TranslateIcon v-else class="h-3.5 w-3.5" />
					<span>{{ t('components.postbox.postboxRewriteActions.translate') }}</span>
					<ChevronDownIcon class="h-3 w-3" />
				</button>
			</UiTooltip>
			<div
				v-if="showTranslate"
				class="absolute left-0 top-full mt-1 min-w-[9rem] rounded-lg border border-border-subtle bg-bg-elevated py-1 shadow-lg z-40"
				role="menu"
			>
				<button
					v-for="lang in languages"
					:key="lang"
					type="button"
					class="block w-full px-3 py-1.5 text-left text-xs text-text-secondary hover:bg-bg-surface"
					role="menuitem"
					@click="pickLanguage(lang)"
				>
					{{ lang }}
				</button>
			</div>
		</div>
	</div>
</template>
