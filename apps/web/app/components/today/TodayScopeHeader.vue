<script setup lang="ts">
import { INBOX_SLOT_SWATCH } from '~/utils/inboxIdentity';

/**
 * The top of one Workbench tab: which inbox this is, what happened in it since
 * the viewer last looked, and four numbers that each jump to their band —
 * new mail, important, conversations that moved, and what was filed away.
 * The actions stay with the inbox they act on: open it, write from it, mark
 * this Workbench as seen.
 */
const props = defineProps<{
	name: string;
	slot: number | null;
	/** Null for the team inbox. */
	address: string | null;
	kind: 'personal' | 'shared' | 'team';
	/** "Since you last looked, Saturday 4:11 PM" / "In the last 24 hours". */
	sinceLabel: string;
	isLoading: boolean;
	stats: {
		/** Null where "new email" means nothing (the team inbox). */
		newMail: number | null;
		isNewMailCapped: boolean;
		important: number;
		/** Null where there is no "What changed" band (the team inbox). */
		moved: number | null;
		filed: number;
	};
	canMarkSeen: boolean;
	inboxHref: string;
	composeHref: string | null;
}>();
const emit = defineEmits<{ markSeen: [] }>();
const { t } = useI18n();

const swatch = computed(() =>
	props.slot === null ? 'bg-text-tertiary' : (INBOX_SLOT_SWATCH[props.slot] ?? 'bg-text-tertiary')
);

const tiles = computed(() => [
	...(props.stats.newMail === null
		? []
		: [
				{
					id: 'new',
					value: props.stats.isNewMailCapped
						? `${props.stats.newMail}+`
						: String(props.stats.newMail),
					label: t('components.today.scope.stats.new', props.stats.newMail),
					href: '#workbench-updates',
				},
			]),
	{
		id: 'important',
		value: String(props.stats.important),
		label: t('components.today.scope.stats.important', props.stats.important),
		href: '#workbench-updates',
	},
	...(props.stats.moved === null
		? []
		: [
				{
					id: 'moved',
					value: String(props.stats.moved),
					label: t('components.today.scope.stats.moved', props.stats.moved),
					href: '#workbench-changed',
				},
			]),
	{
		id: 'filed',
		value: String(props.stats.filed),
		label: t('components.today.scope.stats.filed', props.stats.filed),
		href: '#workbench-filed',
	},
]);
</script>

<template>
	<!-- A size container: the stat tiles follow the card's own width, so they
	     stay two across when the Workbench puts this card in its side column. -->
	<section
		class="@container rounded-2xl border border-border-subtle bg-bg-elevated px-5 py-4"
		aria-labelledby="workbench-scope-name"
	>
		<div class="flex flex-wrap items-start gap-3">
			<div class="min-w-0 flex-1">
				<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
					<Icon v-if="kind === 'team'" name="lucide:bot" class="size-4 text-text-tertiary" />
					<span v-else class="size-2.5 shrink-0 rounded-[3px]" :class="swatch" aria-hidden="true" />
					<h2 id="workbench-scope-name" class="text-base font-medium text-text-primary">
						{{ name }}
					</h2>
					<span v-if="address" class="truncate text-xs text-text-tertiary">{{ address }}</span>
					<span
						class="rounded-full bg-bg-surface px-2 py-px text-2xs font-medium text-text-secondary"
						>{{ t(`components.today.scope.kind.${kind}`) }}</span
					>
				</div>
				<UiSkeleton v-if="isLoading && !sinceLabel" class="mt-1.5 h-4 w-56" />
				<p v-else class="mt-1 text-sm text-text-secondary">{{ sinceLabel }}</p>
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<UiButton variant="ghost" size="sm" :to="inboxHref">
					<template #iconLeft><Icon name="lucide:inbox" class="size-4" /></template>
					{{ t('components.today.scope.openInbox') }}
				</UiButton>
				<UiButton v-if="composeHref" variant="ghost" size="sm" :to="composeHref">
					<template #iconLeft><Icon name="lucide:pen-line" class="size-4" /></template>
					{{ t('components.today.scope.write') }}
				</UiButton>
				<UiButton v-if="canMarkSeen" variant="secondary" size="sm" @click="emit('markSeen')">
					<template #iconLeft><Icon name="lucide:check-check" class="size-4" /></template>
					{{ t('dashboard.today.markAllSeen') }}
				</UiButton>
			</div>
		</div>

		<ul
			class="mt-4 grid grid-cols-2 gap-2"
			:class="['', '', '@lg:grid-cols-2', '@lg:grid-cols-3', '@lg:grid-cols-4'][tiles.length]"
		>
			<li v-for="tile in tiles" :key="tile.id">
				<a
					:href="tile.href"
					class="flex h-full flex-col rounded-xl bg-bg-surface/60 px-3 py-2 transition-colors hover:bg-bg-surface"
					:data-scope-stat="tile.id"
				>
					<UiSkeleton v-if="isLoading" class="my-1 h-5 w-8" />
					<span
						v-else
						class="text-xl font-medium tabular-nums"
						:class="tile.value === '0' ? 'text-text-tertiary' : 'text-text-primary'"
						>{{ tile.value }}</span
					>
					<span class="text-xs text-text-secondary">{{ tile.label }}</span>
				</a>
			</li>
		</ul>
	</section>
</template>
