<script setup lang="ts">
import { REVIEW_SHORTCUT_GROUPS } from '~/utils/reviewShortcuts';

/**
 * Review Queue page header: back link, title, the Focus-mode switch, and the
 * keyboard-hint legend (this queue is keyboard-first). Split out of
 * ReviewBrowseList so the browse list stays within the file-size cap while
 * gaining the C2 multi-select surface.
 */
defineProps<{
	/** Rows exist — show the Focus switch and the keyboard hints. */
	hasRows: boolean;
}>();

const emit = defineEmits<{ (e: 'focus'): void }>();

// The header was lifted out of ReviewBrowseList, so it keeps that surface's
// catalog namespace rather than minting a second copy of the same sentences.
const { t } = useI18n();
</script>

<template>
	<div>
		<div class="flex items-center gap-4 mb-8">
			<NuxtLink
				to="/dashboard/inbox"
				class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
			</NuxtLink>
			<div>
				<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
					{{ t('components.agentTasks.reviewBrowseList.title') }}
				</h1>
				<p class="text-text-secondary mt-1">
					{{ t('components.agentTasks.reviewBrowseList.subtitle') }}
				</p>
			</div>
			<!-- Focus: switch to the one-task-at-a-time card-stack flow. -->
			<button
				v-if="hasRows"
				type="button"
				class="ml-auto inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-md bg-brand text-text-inverse hover:bg-brand/90 transition-colors duration-(--motion-fast)"
				@click="emit('focus')"
			>
				<Icon name="lucide:target" class="w-4 h-4" />
				{{ t('components.agentTasks.reviewBrowseList.focus') }}
			</button>
		</div>

		<!-- Keyboard hint: j/k/Enter/a/e/#, plus the C2 selection keys. -->
		<div
			v-if="hasRows"
			class="flex flex-wrap items-center gap-x-4 gap-y-1 mb-4 text-xs text-text-tertiary"
		>
			<span
				v-for="hint in REVIEW_SHORTCUT_GROUPS"
				:key="hint.label"
				class="inline-flex items-center gap-1"
			>
				<kbd
					v-for="k in hint.keys"
					:key="k"
					class="px-1.5 py-0.5 rounded border border-border-subtle bg-bg-surface font-mono text-[10px] text-text-secondary"
					>{{ k }}</kbd
				>
				<span>{{ t(hint.label) }}</span>
			</span>
		</div>
	</div>
</template>
