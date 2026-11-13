<script setup lang="ts">
import { CloseIcon } from '@coolicons/vue';

/**
 * The command palette's box: the scope chip (or, inside an item's argument
 * step, that step's prompt), the input and its clear button. Every key the
 * input receives goes back to `AppCommandPalette`, which owns the keyboard and
 * reads the caret through the exposed `input`.
 */
defineProps<{
	/** The active scope's name on the chip ("Everything", "Mail"). */
	scopeLabel: string;
	/** The argument step's prompt key; null outside one, where the chip shows. */
	pendingPromptKey: string | null;
	placeholderKey: string;
	/** The highlighted row's option id, for `aria-activedescendant`. */
	activeDescendant: string | undefined;
}>();

const emit = defineEmits<{
	keydown: [event: KeyboardEvent];
	/** The caret may have moved (a key, a click, typed text). */
	caret: [];
	cycleScope: [];
}>();

const query = defineModel<string>('query', { required: true });

const { t } = useI18n();
const input = ref<HTMLInputElement | null>(null);

defineExpose({ input });
</script>

<template>
	<div class="flex items-center gap-3 px-4 py-3 border-b border-border-subtle">
		<!-- The scope chip. `tabindex="-1"` on purpose: Tab inside the overlay
		     is bound to cycling the scope, so the chip could never be reached
		     by it anyway, and leaving it out of the tab ring keeps the focus
		     trap's "first focusable" on the input, where typing belongs. -->
		<UiTooltip v-if="!pendingPromptKey" :text="t('components.appCommandPalette.scopeLabel')">
			<button
				type="button"
				tabindex="-1"
				class="flex-shrink-0 text-xs font-medium px-2 py-1 rounded-full bg-brand/10 text-brand hover:bg-brand/20 transition-colors duration-(--motion-fast)"
				:aria-label="`${t('components.appCommandPalette.scopeLabel')}: ${scopeLabel}`"
				@click="emit('cycleScope')"
			>
				{{ scopeLabel }}
			</button>
		</UiTooltip>
		<span v-else class="flex-shrink-0 text-xs px-2 py-1 rounded bg-bg-surface text-text-secondary">
			{{ t(pendingPromptKey) }}
		</span>
		<input
			ref="input"
			v-model="query"
			type="text"
			:placeholder="t(placeholderKey)"
			class="input-bare flex-1 text-base"
			role="combobox"
			aria-expanded="true"
			aria-controls="app-cmdk-list"
			:aria-label="t('components.appCommandPalette.dialogLabel')"
			:aria-activedescendant="activeDescendant"
			@keydown="emit('keydown', $event)"
			@keyup="emit('caret')"
			@click="emit('caret')"
			@input="emit('caret')"
		/>
		<button
			v-if="query"
			type="button"
			class="p-1 text-text-tertiary hover:text-text-primary transition-colors duration-(--motion-fast)"
			:aria-label="t('components.appCommandPalette.clearQuery')"
			@click="query = ''"
		>
			<CloseIcon class="w-4 h-4" />
		</button>
		<kbd
			class="hidden sm:inline-flex items-center px-2 py-1 text-xs text-text-tertiary bg-bg-surface border border-border-subtle rounded"
		>
			esc
		</kbd>
	</div>
</template>
