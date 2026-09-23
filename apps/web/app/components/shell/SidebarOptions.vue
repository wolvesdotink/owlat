<script setup lang="ts">
import {
	SIDEBAR_THREADS_MAX,
	SIDEBAR_THREADS_MIN,
	type SidebarThreadSort,
} from '~/composables/useShellSidebarPrefs';

/**
 * "Sidebar options": how many conversations each inbox lists (0 keeps just the
 * inbox rows with their status dots — the calmest setting) and how rows are
 * ordered.
 */
const { t } = useI18n();
const { perInbox, sort } = useShellSidebarPrefs();
const open = ref(false);

const SORTS: ReadonlyArray<{ value: SidebarThreadSort; label: string }> = [
	{ value: 'recent', label: 'components.shell.options.sortRecent' },
	{ value: 'priority', label: 'components.shell.options.sortPriority' },
];
</script>

<template>
	<UiDropdownMenu v-model:open="open" position="left">
		<template #trigger>
			<button
				type="button"
				class="flex size-6 items-center justify-center rounded text-text-tertiary hover:bg-(--surface-2-hover) hover:text-text-primary"
				:aria-label="t('components.shell.options.label')"
				:title="t('components.shell.options.label')"
			>
				<Icon name="lucide:sliders-horizontal" class="size-3.5" />
			</button>
		</template>
		<div class="px-3 pb-1 pt-2 text-2xs font-medium text-text-tertiary">
			{{ t('components.shell.options.perInbox') }}
		</div>
		<div class="flex items-center gap-1 px-3 pb-2" @click.stop>
			<button
				type="button"
				class="flex size-6 items-center justify-center rounded border border-border-subtle text-text-secondary hover:bg-bg-surface disabled:opacity-40"
				:disabled="perInbox <= SIDEBAR_THREADS_MIN"
				:aria-label="t('components.shell.options.fewer')"
				@click="perInbox = perInbox - 1"
			>
				<Icon name="lucide:minus" class="size-3" />
			</button>
			<span class="w-6 text-center text-xs tabular-nums text-text-primary" aria-live="polite">{{
				perInbox
			}}</span>
			<button
				type="button"
				class="flex size-6 items-center justify-center rounded border border-border-subtle text-text-secondary hover:bg-bg-surface disabled:opacity-40"
				:disabled="perInbox >= SIDEBAR_THREADS_MAX"
				:aria-label="t('components.shell.options.more')"
				@click="perInbox = perInbox + 1"
			>
				<Icon name="lucide:plus" class="size-3" />
			</button>
		</div>
		<UiDropdownDivider />
		<div class="px-3 pb-1 pt-2 text-2xs font-medium text-text-tertiary">
			{{ t('components.shell.options.order') }}
		</div>
		<UiDropdownMenuItem
			v-for="option in SORTS"
			:key="option.value"
			:icon="sort === option.value ? 'lucide:check' : undefined"
			@click="sort = option.value"
		>
			<span :class="sort === option.value ? '' : 'pl-6'">{{ t(option.label) }}</span>
		</UiDropdownMenuItem>
	</UiDropdownMenu>
</template>
