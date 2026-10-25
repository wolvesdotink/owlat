<script setup lang="ts">
/**
 * A thread-list row's hover quick-actions: single-message triage without a
 * round-trip through the bulk selection. The row owns the verbs; each button
 * hands its click back so the row can keep it from following the row's link.
 * Archive is also a sweep handle (`data-sweep-handle`), read by the row.
 */
defineProps<{
	msg: { flagFlagged: boolean; flagSeen: boolean };
	/** A Priority row explains its placement from here. */
	whyHereShown: boolean;
}>();

const emit = defineEmits<{
	'why-here': [event: MouseEvent];
	action: [event: MouseEvent, verb: 'toggle-star' | 'toggle-read' | 'archive' | 'trash'];
}>();

const { t } = useI18n();
</script>

<template>
	<div
		class="ui-hover-reveal absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-0.5 bg-bg-elevated/95 rounded px-1 py-0.5 shadow-sm border border-border-subtle"
	>
		<UiTooltip v-if="whyHereShown" :text="t('postbox.explain.rowLink')">
			<button
				type="button"
				class="p-1 rounded hover:bg-bg-surface text-text-tertiary hover:text-text-primary"
				:aria-label="t('postbox.explain.rowLink')"
				data-testid="row-why-here"
				@click="emit('why-here', $event)"
			>
				<Icon name="lucide:help-circle" class="w-4 h-4" />
			</button>
		</UiTooltip>
		<UiTooltip
			:text="
				msg.flagFlagged
					? t('components.postbox.postboxThreadRow.unstar')
					: t('components.postbox.postboxThreadRow.star')
			"
		>
			<button
				type="button"
				class="p-1 rounded hover:bg-bg-surface text-text-tertiary hover:text-warning"
				:aria-label="
					msg.flagFlagged
						? t('components.postbox.postboxThreadRow.unstar')
						: t('components.postbox.postboxThreadRow.star')
				"
				@click="emit('action', $event, 'toggle-star')"
			>
				<Icon name="lucide:star" class="w-4 h-4" />
			</button>
		</UiTooltip>
		<UiTooltip
			:text="
				msg.flagSeen
					? t('components.postbox.postboxThreadRow.markUnread')
					: t('components.postbox.postboxThreadRow.markRead')
			"
		>
			<button
				type="button"
				class="p-1 rounded hover:bg-bg-surface text-text-tertiary hover:text-text-primary"
				:aria-label="
					msg.flagSeen
						? t('components.postbox.postboxThreadRow.markUnread')
						: t('components.postbox.postboxThreadRow.markRead')
				"
				@click="emit('action', $event, 'toggle-read')"
			>
				<Icon :name="msg.flagSeen ? 'lucide:mail' : 'lucide:mail-open'" class="w-4 h-4" />
			</button>
		</UiTooltip>
		<UiTooltip :text="t('components.postbox.postboxThreadRow.archiveSweepHint')">
			<button
				type="button"
				class="p-1 rounded hover:bg-bg-surface text-text-tertiary hover:text-text-primary"
				:aria-label="t('common.archive')"
				data-sweep-handle="archive"
				@click="emit('action', $event, 'archive')"
			>
				<Icon name="lucide:archive" class="w-4 h-4" />
			</button>
		</UiTooltip>
		<UiTooltip :text="t('common.delete')">
			<button
				type="button"
				class="p-1 rounded hover:bg-error/10 text-text-tertiary hover:text-error"
				:aria-label="t('common.delete')"
				@click="emit('action', $event, 'trash')"
			>
				<Icon name="lucide:trash" class="w-4 h-4" />
			</button>
		</UiTooltip>
	</div>
</template>
