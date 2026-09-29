<script setup lang="ts">
/**
 * One card of the saved-blocks grid: a click opens the block's content editor,
 * and the hover overlay and the overflow menu carry the same actions. Settings,
 * duplicate and delete are `templates:manage` writes, so both hide them unless
 * `canManage` — the two controls must never disagree on the gate.
 */
import type { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';
import { formatDate } from '~/utils/formatters';

type BlockRow = FunctionReturnType<typeof api.emailBlocks.blocks.list>[number];

defineProps<{
	block: BlockRow;
	canManage: boolean;
}>();

const emit = defineEmits<{
	open: [block: BlockRow];
	settings: [block: BlockRow];
	duplicate: [block: BlockRow];
	delete: [block: BlockRow];
}>();

const { t, locale } = useI18n();

const menuOpen = ref(false);

const overlayButton =
	'p-2 rounded-lg bg-bg-elevated text-text-primary hover:text-text-inverse transition-colors';
</script>

<template>
	<UiCard
		padding="none"
		overflow="hidden"
		hoverable
		clickable
		class="group"
		@click="emit('open', block)"
	>
		<div class="aspect-[4/3] bg-bg-surface flex items-center justify-center relative">
			<Icon name="lucide:blocks" class="w-12 h-12 text-text-tertiary/30" />
			<div
				class="absolute inset-0 bg-bg-deep/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2"
			>
				<button
					:class="[overlayButton, 'hover:bg-brand']"
					:title="t('dashboard.send.blocks.index.editContent')"
					@click.stop="emit('open', block)"
				>
					<Icon name="lucide:file-edit" class="w-4 h-4" />
				</button>
				<template v-if="canManage">
					<button
						:class="[overlayButton, 'hover:bg-brand']"
						:title="t('dashboard.send.blocks.index.quickSettings')"
						@click.stop="emit('settings', block)"
					>
						<Icon name="lucide:settings" class="w-4 h-4" />
					</button>
					<button
						:class="[overlayButton, 'hover:bg-brand']"
						:title="t('common.duplicate')"
						@click.stop="emit('duplicate', block)"
					>
						<Icon name="lucide:copy" class="w-4 h-4" />
					</button>
					<button
						:class="[overlayButton, 'hover:bg-error']"
						:title="t('common.delete')"
						@click.stop="emit('delete', block)"
					>
						<Icon name="lucide:trash-2" class="w-4 h-4" />
					</button>
				</template>
			</div>
		</div>

		<div class="p-4">
			<div class="flex items-start justify-between gap-2">
				<div class="min-w-0 flex-1">
					<h3 class="font-medium text-text-primary truncate">{{ block.name }}</h3>
					<p class="text-sm text-text-tertiary truncate mt-0.5">
						{{ block.description || t('dashboard.send.blocks.index.noDescription') }}
					</p>
				</div>
				<UiDropdownMenu v-model:open="menuOpen" @click.stop>
					<template #trigger>
						<UiButton variant="ghost" size="sm">
							<Icon name="lucide:more-vertical" class="w-4 h-4" />
						</UiButton>
					</template>
					<UiDropdownMenuItem icon="lucide:file-edit" @click="emit('open', block)">
						{{ t('dashboard.send.blocks.index.editContent') }}
					</UiDropdownMenuItem>
					<template v-if="canManage">
						<UiDropdownMenuItem icon="lucide:settings" @click="emit('settings', block)">
							{{ t('common.settings') }}
						</UiDropdownMenuItem>
						<UiDropdownMenuItem icon="lucide:copy" @click="emit('duplicate', block)">
							{{ t('common.duplicate') }}
						</UiDropdownMenuItem>
						<UiDropdownDivider />
						<UiDropdownMenuItem icon="lucide:trash-2" danger @click="emit('delete', block)">
							{{ t('common.delete') }}
						</UiDropdownMenuItem>
					</template>
				</UiDropdownMenu>
			</div>

			<div class="flex items-center gap-2 mt-3">
				<span
					v-if="block.blockCount && block.blockCount > 1"
					class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-brand/10 text-brand"
				>
					{{ t('dashboard.send.blocks.index.blocksBadge', { count: block.blockCount }) }}
				</span>
				<span
					class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-bg-surface text-text-tertiary"
				>
					<Icon name="lucide:bar-chart" class="w-3 h-3" />
					{{ t('dashboard.send.blocks.index.usesBadge', { count: block.usageCount }) }}
				</span>
			</div>

			<p class="text-xs text-text-tertiary mt-3">
				{{
					t('dashboard.send.blocks.index.updatedAt', {
						date: formatDate(block.updatedAt, 'medium', locale),
					})
				}}
			</p>
		</div>
	</UiCard>
</template>
