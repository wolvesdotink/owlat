<script setup lang="ts" generic="T extends TemplateListItem">
/**
 * The grid view of a template list: one card per template, opened by click,
 * Enter or Space, with edit/duplicate/delete on a hover overlay and in the
 * card's overflow menu.
 */
import type { TemplateListItem, TemplateRowAction } from '~/composables/useTemplateList';
import { formatDate } from '~/utils/formatters';

const props = withDefaults(
	defineProps<{
		items: readonly T[];
		canManage: boolean;
		actions?: readonly TemplateRowAction<T>[];
	}>(),
	{ actions: () => [] }
);

const emit = defineEmits<{ edit: [item: T]; duplicate: [item: T]; delete: [item: T] }>();

defineSlots<{
	/** Replaces the default glyph in the card's preview area. */
	thumbnail?: (props: { item: T }) => unknown;
	/** Extra chips beside the status badge. */
	meta?: (props: { item: T }) => unknown;
}>();

const { t, locale } = useI18n();

const overlayActions = computed(() => props.actions.filter((action) => action.overlay));

const overlayButton =
	'p-2 rounded-lg bg-bg-elevated text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand';
</script>

<template>
	<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
		<UiCard
			v-for="item in items"
			:key="item._id"
			padding="none"
			overflow="hidden"
			hoverable
			clickable
			class="group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
			role="button"
			tabindex="0"
			:aria-label="t('shared.templateList.editAriaLabel', { name: item.name })"
			@click="emit('edit', item)"
			@keydown.enter.self="emit('edit', item)"
			@keydown.space.self.prevent="emit('edit', item)"
		>
			<div
				class="aspect-[4/3] bg-bg-surface flex flex-col items-center justify-center relative px-4"
			>
				<slot name="thumbnail" :item="item">
					<Icon name="lucide:send" class="w-12 h-12 text-text-tertiary/30" />
				</slot>
				<div
					class="absolute inset-0 bg-bg-deep/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2"
				>
					<button
						v-for="action in overlayActions"
						:key="action.key"
						type="button"
						:class="[overlayButton, 'hover:bg-bg-surface-hover']"
						:title="action.label"
						:aria-label="action.label"
						@click.stop="action.run(item)"
					>
						<Icon :name="action.icon" class="w-4 h-4" />
					</button>
					<button
						type="button"
						:class="[overlayButton, 'hover:bg-bg-surface-hover']"
						:aria-label="t('common.edit')"
						@click.stop="emit('edit', item)"
					>
						<Icon name="lucide:pencil" class="w-4 h-4" />
					</button>
					<template v-if="canManage">
						<button
							type="button"
							:class="[overlayButton, 'hover:bg-bg-surface-hover']"
							:aria-label="t('common.duplicate')"
							@click.stop="emit('duplicate', item)"
						>
							<Icon name="lucide:copy" class="w-4 h-4" />
						</button>
						<button
							type="button"
							:class="[overlayButton, 'hover:bg-error hover:text-text-inverse']"
							:aria-label="t('common.delete')"
							@click.stop="emit('delete', item)"
						>
							<Icon name="lucide:trash-2" class="w-4 h-4" />
						</button>
					</template>
				</div>
			</div>

			<div class="p-4">
				<div class="flex items-start justify-between gap-2">
					<div class="min-w-0 flex-1">
						<h3 class="font-medium text-text-primary truncate">{{ item.name }}</h3>
						<p class="text-sm text-text-tertiary truncate mt-0.5">
							{{ item.subject || t('shared.templateList.noSubject') }}
						</p>
					</div>
					<SendTemplateActionsMenu
						:item="item"
						:can-manage="canManage"
						:actions="actions"
						@edit="emit('edit', $event)"
						@duplicate="emit('duplicate', $event)"
						@delete="emit('delete', $event)"
					/>
				</div>

				<div class="flex items-center gap-2 mt-3">
					<SendTemplateStatusBadge :status="item.status" />
					<slot name="meta" :item="item" />
				</div>

				<p class="text-xs text-text-tertiary mt-3">
					{{
						t('shared.templateList.updatedAt', {
							date: formatDate(item.updatedAt, 'medium', locale),
						})
					}}
				</p>
			</div>
		</UiCard>
	</div>
</template>
