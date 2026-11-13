<script setup lang="ts">
import { postboxListEmptyState } from '~/utils/postboxListEmptyState';
import { useShortcutLabels } from '~/composables/useShortcutLabels';

const props = defineProps<{
	folderRole: string;
	hasMore?: boolean;
	emptyContext?: 'label';
	/** A triage filter chip is hiding rows that exist: offer "Show all". */
	filterActive?: boolean;
}>();

const emit = defineEmits<{
	(e: 'clear-filter'): void;
}>();

const { t } = useI18n();

// Context-aware empty state — a filtered-to-zero folder, inbox zero, an empty
// label and an empty custom folder each say something different. The choice is
// a pure derivation (utils/postboxListEmptyState.ts); this is the render
// boundary that resolves its catalog keys.
const { labelFor, labelParams } = useShortcutLabels();
const emptyState = computed(() => {
	const state = postboxListEmptyState({
		filterActive: props.filterActive === true,
		hasMore: props.hasMore === true,
		emptyContext: props.emptyContext,
		folderRole: props.folderRole,
		isShortcutLive: (id) => labelFor(id) !== null,
	});
	const hintParams = labelParams(state.hintShortcuts);
	return {
		icon: state.icon,
		title: t(state.titleKey),
		hint: state.hintKey && hintParams ? t(state.hintKey, hintParams) : undefined,
		showFilterAction: state.showFilterAction,
	};
});
</script>

<template>
	<PostboxEmptyState :icon="emptyState.icon" :title="emptyState.title" :hint="emptyState.hint">
		<template v-if="filterActive" #action>
			<button
				type="button"
				class="inline-block mt-2 text-xs text-brand hover:underline"
				@click="emit('clear-filter')"
			>
				{{ t('components.postbox.postboxThreadList.showAllMessages') }}
			</button>
		</template>
		<template v-else-if="emptyState.showFilterAction" #action>
			<NuxtLink
				to="/dashboard/preferences/filters"
				class="inline-block mt-2 text-xs text-brand hover:underline"
			>
				{{ t('components.postbox.postboxThreadList.setUpFilter') }}
			</NuxtLink>
		</template>
	</PostboxEmptyState>
</template>
