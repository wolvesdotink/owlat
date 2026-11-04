<script setup lang="ts">
/**
 * An inbox's people in the Conversations sidebar, for the People view (the
 * classic inbox lists its latest conversations instead): whoever waits on you
 * first, then the most recent, one line each, set in the primary ink when
 * something waits or is unread, with the People view's one mark
 * (PostboxPeopleMark). The topic they lead with is the row's
 * tooltip; a row opens that person's page.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { SIDEBAR_JUMP_HINTS } from '~/composables/useSidebarJumpHints';

const props = defineProps<{ mailboxId: Id<'mailboxes'>; limit: number }>();

const { t } = useI18n();
const route = useRoute();
const { data } = useConvexQuery(
	api.mail.people.directory.sidebarPeople,
	() => ({ mailboxId: props.mailboxId, limit: props.limit }),
	{ keepPreviousData: true }
);
const rows = computed(() => data.value?.people ?? []);
// The rows stop at the limit; the rest are one link away, never silently cut.
const hiddenCount = computed(() => Math.max(0, (data.value?.peopleCount ?? 0) - rows.value.length));
const hiddenWaiting = computed(() =>
	Math.max(0, (data.value?.waitingCount ?? 0) - rows.value.filter((r) => r.owedCount > 0).length)
);
const inboxHref = computed(() => `/dashboard/postbox/inbox?mailbox=${props.mailboxId}`);
const activeKey = computed(() =>
	route.path.startsWith('/dashboard/postbox/inbox') && typeof route.query['person'] === 'string'
		? route.query['person']
		: null
);
const hrefFor = (key: string) =>
	`/dashboard/postbox/inbox?mailbox=${props.mailboxId}&person=${encodeURIComponent(key)}`;

const hints = inject(SIDEBAR_JUMP_HINTS, null);
const jumpNumber = (key: string) =>
	hints?.show.value ? (hints.labels.value.get(`person:${key}`) ?? null) : null;
</script>

<template>
	<div class="mt-px space-y-px">
		<NuxtLink
			v-for="row in rows"
			:key="row.key"
			:to="hrefFor(row.key)"
			:data-sidebar-jump="`person:${row.key}`"
			:aria-current="activeKey === row.key ? 'page' : undefined"
			class="group grid grid-cols-[auto_1fr_auto] items-center gap-x-2 rounded-md py-1 pl-6 pr-2 transition-colors duration-(--motion-fast)"
			:class="
				activeKey === row.key
					? 'bg-(--surface-2-selected) text-text-primary'
					: 'text-text-secondary hover:bg-(--surface-2-hover) hover:text-text-primary'
			"
		>
			<PostboxPeopleAvatar
				kind="person"
				:name="row.name"
				:color-key="row.key"
				size="sm"
				class="!w-5 !h-5"
			/>
			<span
				class="min-w-0 truncate text-xs"
				:class="row.unread > 0 ? 'font-medium text-text-primary' : ''"
				:title="row.leadTitle"
				>{{ row.name }}</span
			>
			<span class="flex items-center justify-end gap-1.5">
				<kbd
					v-if="jumpNumber(row.key) !== null"
					class="rounded bg-bg-elevated px-1 font-mono text-2xs leading-4 text-text-tertiary shadow-(--shadow-1)"
					>⌥{{ jumpNumber(row.key) }}</kbd
				>
				<span v-else class="text-2xs tabular-nums text-text-tertiary">{{
					formatCompactRelativeTime(row.lastAt)
				}}</span>
				<!-- At the right edge, as in every other list. -->
				<PostboxPeopleMark
					:owed="row.owedCount"
					:may-owe="row.mayOweCount"
					:unread="row.unread"
					size="sm"
				/>
			</span>
		</NuxtLink>
		<NuxtLink
			v-if="hiddenCount > 0"
			:to="inboxHref"
			class="flex items-center gap-2 rounded-md py-1 pl-7 pr-2 text-2xs text-text-tertiary hover:bg-(--surface-2-hover) hover:text-text-primary"
		>
			{{
				hiddenWaiting > 0
					? t('components.shell.peopleRows.moreWaiting', { count: hiddenWaiting }, hiddenWaiting)
					: t('components.shell.peopleRows.more', { count: hiddenCount }, hiddenCount)
			}}
		</NuxtLink>
		<p v-if="data && rows.length === 0" class="py-1 pl-7 pr-2 text-2xs text-text-tertiary">
			{{ t('components.shell.peopleRows.empty') }}
		</p>
	</div>
</template>
