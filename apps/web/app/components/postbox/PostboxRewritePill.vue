<script setup lang="ts">
/**
 * Tiny floating AI rewrite pill shown over a text selection in the Simple
 * composer. Modeled on the email-builder's FloatingToolbar (absolutely
 * positioned near the selection) but deliberately minimal: one-tap tone/grammar
 * rewrites plus a Translate… submenu of the user's recent target languages.
 *
 * Advisory only — clicking an option asks the parent to fetch a rewrite and show
 * a preview; nothing is applied here. Position + loading are owned by the parent.
 */

import type { RewriteIntent } from '~/composables/postbox/usePostboxSelectionRewrite';

defineProps<{
	/** Absolute-position style computed from the selection rect by the parent. */
	pillStyle: Record<string, string> | null;
	/** True while a rewrite request is in flight (disables the pill). */
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

const OPTIONS: { intent: RewriteIntent; label: string; icon: string }[] = [
	{ intent: 'shorter', label: 'Shorter', icon: 'lucide:scissors' },
	{ intent: 'friendlier', label: 'Friendlier', icon: 'lucide:smile' },
	{ intent: 'formal', label: 'More formal', icon: 'lucide:briefcase' },
	{ intent: 'grammar', label: 'Fix grammar', icon: 'lucide:spell-check' },
];
</script>

<template>
	<div
		v-if="pillStyle"
		class="postbox-rewrite-pill absolute z-30 flex items-center gap-0.5 rounded-lg border border-border-subtle bg-bg-elevated px-1 py-1 shadow-lg"
		:style="pillStyle"
		role="toolbar"
		aria-label="Rewrite selection with AI"
		@mousedown.prevent
	>
		<button
			v-for="opt in OPTIONS"
			:key="opt.intent"
			type="button"
			class="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-text-secondary hover:bg-bg-surface disabled:opacity-50"
			:disabled="loading"
			:title="opt.label"
			@click="pick(opt.intent)"
		>
			<Icon
				v-if="loading && activeIntent === opt.intent"
				name="lucide:loader-2"
				class="h-3.5 w-3.5 animate-spin"
			/>
			<Icon v-else :name="opt.icon" class="h-3.5 w-3.5" />
			<span>{{ opt.label }}</span>
		</button>
		<div class="relative">
			<button
				type="button"
				class="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-text-secondary hover:bg-bg-surface disabled:opacity-50"
				:disabled="loading"
				title="Translate…"
				@click="showTranslate = !showTranslate"
			>
				<Icon
					v-if="loading && activeIntent === 'translate'"
					name="lucide:loader-2"
					class="h-3.5 w-3.5 animate-spin"
				/>
				<Icon v-else name="lucide:languages" class="h-3.5 w-3.5" />
				<span>Translate</span>
				<Icon name="lucide:chevron-down" class="h-3 w-3" />
			</button>
			<div
				v-if="showTranslate"
				class="absolute left-0 top-full mt-1 min-w-[9rem] rounded-lg border border-border-subtle bg-bg-elevated py-1 shadow-lg"
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
