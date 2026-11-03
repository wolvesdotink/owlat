<script setup lang="ts">
import { INBOX_SLOT_SWATCH } from '~/utils/inboxIdentity';
import { CheckAllIcon, InboxIcon, MoreHorizontalIcon, PencilIcon, RobotIcon } from '@coolicons/vue';

/**
 * The top of one Workbench tab, two quiet lines: which inbox this is (its name
 * opens it), then what happened since the viewer last looked as a sentence of
 * links, each jumping to its band: new mail, important, conversations that
 * moved, what was filed away. Numbers that are zero are left out; when all are,
 * the line says so. "Mark all as seen" shows only when there is something to
 * mark, and the rarer actions (open the inbox, write from it) wait in ⋯.
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

const allTiles = computed(() => [
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
// Zero says nothing worth a link; an all-zero summary says "nothing new".
const tiles = computed(() => allTiles.value.filter((tile) => tile.value !== '0'));
const menuOpen = ref(false);
const kindLabel = computed(() =>
	props.kind === 'personal' ? null : t(`components.today.scope.kind.${props.kind}`)
);
</script>

<template>
	<section aria-labelledby="workbench-scope-name">
		<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
			<RobotIcon v-if="kind === 'team'" class="size-4 text-text-tertiary" />
			<span v-else class="size-2.5 shrink-0 rounded-[3px]" :class="swatch" aria-hidden="true" />
			<h2 id="workbench-scope-name" class="text-base font-medium text-text-primary">
				<UiTooltip :text="t('components.today.scope.openInbox')">
					<NuxtLink :to="inboxHref" class="hover:underline">{{ name }}</NuxtLink>
				</UiTooltip>
			</h2>
			<span v-if="address" class="hidden truncate text-xs text-text-tertiary sm:inline">{{
				address
			}}</span>
			<span
				v-if="kindLabel"
				class="rounded-full bg-bg-surface px-2 py-px text-2xs font-medium text-text-secondary"
				>{{ kindLabel }}</span
			>
			<div class="ml-auto flex items-center gap-1">
				<UiButton v-if="canMarkSeen" variant="ghost" size="sm" @click="emit('markSeen')">
					<template #iconLeft><CheckAllIcon class="size-4" /></template>
					{{ t('dashboard.today.markAllSeen') }}
				</UiButton>
				<UiDropdownMenu v-model:open="menuOpen" position="right">
					<template #trigger>
						<UiButton
							variant="ghost"
							size="sm"
							class="w-8 px-0"
							:aria-label="t('components.today.scope.more', { inbox: name })"
						>
							<MoreHorizontalIcon class="size-4" />
						</UiButton>
					</template>
					<UiDropdownMenuItem :icon="InboxIcon" @click="navigateTo(inboxHref)">
						{{ t('components.today.scope.openInbox') }}
					</UiDropdownMenuItem>
					<UiDropdownMenuItem
						v-if="composeHref"
						:icon="PencilIcon"
						@click="navigateTo(composeHref)"
					>
						{{ t('components.today.scope.write') }}
					</UiDropdownMenuItem>
				</UiDropdownMenu>
			</div>
		</div>

		<UiSkeleton v-if="isLoading && !sinceLabel" class="mt-1.5 h-4 w-72" />
		<p v-else class="mt-1 text-sm text-text-secondary">
			{{ sinceLabel }}<template v-if="sinceLabel">: </template>
			<UiSkeleton v-if="isLoading" class="inline-block h-3.5 w-40 align-middle" />
			<template v-else-if="tiles.length === 0">{{ t('components.today.scope.allClear') }}</template>
			<template v-for="(tile, index) in tiles" v-else :key="tile.id"
				><template v-if="index > 0"> · </template
				><a
					:href="tile.href"
					class="text-text-primary underline decoration-border-default underline-offset-2 hover:decoration-text-primary"
					:data-scope-stat="tile.id"
					><span class="tabular-nums">{{ tile.value }}</span> {{ tile.label }}</a
				></template
			>
		</p>
	</section>
</template>
