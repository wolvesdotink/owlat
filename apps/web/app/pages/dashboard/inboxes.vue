<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { ConversationStatus } from '~/utils/conversationStatus';
import { mailThreadStatus, teamThreadStatus } from '~/utils/conversationStatus';

/**
 * All inboxes — every conversation the viewer can read in one list, newest
 * first: their own mailboxes, the team inboxes they belong to, and (owners/
 * admins) the team inbox. Each row wears its inbox chip. Chips narrow the list
 * to one inbox; Unread / Needs you / a category (`?category=` — Today's
 * "Filed away" links land here) narrow it further. Opening a row goes to the
 * conversation in its own inbox.
 */
const { t } = useI18n();
useHead({ title: () => t('dashboard.inboxes.pageTitle') });
definePageMeta({ layout: 'dashboard', middleware: 'auth' });

const route = useRoute();
const router = useRouter();
const { isEnabled } = useFeatureFlag();
const { isAdmin } = usePermissions();
const { inboxes, ids, byId, isLoading: inboxesLoading } = useInboxes();

const PER_INBOX = 40;
const threadResults = useConvexQueryMap(api.mail.mailbox.queries.listThreads, ids, (mailboxId) => ({
	mailboxId,
	folderRole: 'inbox',
	limit: PER_INBOX,
}));
const teamOn = computed(() => isAdmin.value && isEnabled('inbox'));
const { data: teamData } = useConvexQuery(api.inbox.queries.listThreads, () =>
	teamOn.value ? { filter: 'open' as const, sort: 'newest' as const, limit: 30 } : 'skip'
);

type Row = {
	key: string;
	inboxId: string;
	title: string;
	from: string;
	snippet: string;
	at: number;
	unread: boolean;
	status: ConversationStatus | null;
	category: string | null;
	href: string;
};

const allRows = computed<Row[]>(() => {
	const rows: Row[] = [];
	for (const [mailboxId, result] of threadResults) {
		for (const thread of result.data.value?.threads ?? []) {
			rows.push({
				key: `mail:${mailboxId}:${thread._id}`,
				inboxId: mailboxId,
				title: thread.latestSubject,
				from: thread.latestFromAddress ?? '',
				snippet: thread.latestSnippet,
				at: thread.lastMessageAt,
				unread: thread.unreadCount > 0,
				status: mailThreadStatus(thread),
				category: thread.category?.label ?? null,
				href: thread.latestMessageId
					? `/dashboard/postbox/inbox/${thread.latestMessageId}?mailbox=${mailboxId}`
					: `/dashboard/postbox/inbox?mailbox=${mailboxId}`,
			});
		}
	}
	for (const thread of teamData.value?.threads ?? []) {
		rows.push({
			key: `team:${thread._id}`,
			inboxId: 'team',
			title: thread.subject,
			from: thread.contactIdentifier,
			snippet: thread.lastPreview ?? '',
			at: thread.lastMessageAt,
			unread: thread.unread,
			status: teamThreadStatus(thread),
			category: null,
			href: `/dashboard/inbox/${thread._id}`,
		});
	}
	return rows.sort((a, b) => b.at - a.at);
});

const inboxFilter = computed(() =>
	typeof route.query['in'] === 'string' ? route.query['in'] : 'all'
);
const show = computed(() =>
	typeof route.query['show'] === 'string' ? route.query['show'] : 'all'
);
const category = computed(() =>
	typeof route.query['category'] === 'string' ? route.query['category'] : null
);
function setQuery(patch: Record<string, string | null>) {
	const next: Record<string, string> = {};
	for (const [k, v] of Object.entries({ ...route.query, ...patch })) {
		if (typeof v === 'string' && v !== 'all') next[k] = v;
	}
	void router.replace({ query: next });
}

const rows = computed(() =>
	allRows.value.filter((row) => {
		if (inboxFilter.value !== 'all' && row.inboxId !== inboxFilter.value) return false;
		if (show.value === 'unread' && !row.unread) return false;
		if (show.value === 'needs' && row.status !== 'needs_you' && row.status !== 'draft_ready')
			return false;
		if (category.value && row.category !== category.value) return false;
		return true;
	})
);

const isLoading = computed(() => {
	if (inboxesLoading.value) return true;
	for (const r of threadResults.values()) if (r.isLoading.value && !r.data.value) return true;
	return false;
});

function inboxOf(id: string) {
	return id === 'team' ? null : (byId.value.get(id as Id<'mailboxes'>) ?? null);
}
function senderLabel(from: string): string {
	return from;
}

const SHOW_OPTIONS = [
	{ id: 'all', label: 'dashboard.inboxes.show.all' },
	{ id: 'unread', label: 'dashboard.inboxes.show.unread' },
	{ id: 'needs', label: 'dashboard.inboxes.show.needs' },
];
</script>

<template>
	<div class="mx-auto w-full max-w-5xl px-6 pb-16 pt-8 lg:px-10">
		<header class="flex flex-wrap items-baseline gap-3">
			<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
				{{ t('dashboard.inboxes.title') }}
			</h1>
			<p class="text-sm text-text-secondary">
				{{
					t(
						'dashboard.inboxes.subtitle',
						{ count: inboxes.length + (teamOn ? 1 : 0) },
						inboxes.length + (teamOn ? 1 : 0)
					)
				}}
			</p>
		</header>

		<div
			class="mt-5 flex flex-wrap items-center gap-1.5"
			role="toolbar"
			:aria-label="t('dashboard.inboxes.filterLabel')"
		>
			<button
				type="button"
				:aria-pressed="inboxFilter === 'all'"
				class="rounded-full px-2.5 py-1 text-xs transition-colors"
				:class="
					inboxFilter === 'all'
						? 'bg-text-primary text-text-inverse'
						: 'bg-bg-elevated text-text-secondary shadow-(--shadow-1) hover:text-text-primary'
				"
				@click="setQuery({ in: null })"
			>
				{{ t('dashboard.inboxes.allInboxes') }}
			</button>
			<button
				v-for="inbox in inboxes"
				:key="inbox.mailboxId"
				type="button"
				:aria-pressed="inboxFilter === inbox.mailboxId"
				class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs transition-colors"
				:class="
					inboxFilter === inbox.mailboxId
						? 'bg-text-primary text-text-inverse'
						: 'bg-bg-elevated text-text-secondary shadow-(--shadow-1) hover:text-text-primary'
				"
				@click="setQuery({ in: inbox.mailboxId })"
			>
				<InboxChip :name="inbox.name" :slot="inbox.slot" variant="plain" class="!text-inherit" />
				<span v-if="inbox.unread > 0" class="tabular-nums opacity-70">{{ inbox.unread }}</span>
			</button>
			<button
				v-if="teamOn"
				type="button"
				:aria-pressed="inboxFilter === 'team'"
				class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs transition-colors"
				:class="
					inboxFilter === 'team'
						? 'bg-text-primary text-text-inverse'
						: 'bg-bg-elevated text-text-secondary shadow-(--shadow-1) hover:text-text-primary'
				"
				@click="setQuery({ in: 'team' })"
			>
				<Icon name="lucide:bot" class="size-3" />{{ t('components.shell.teamInbox') }}
			</button>
			<span class="mx-1 h-4 w-px bg-border-subtle" aria-hidden="true" />
			<button
				v-for="option in SHOW_OPTIONS"
				:key="option.id"
				type="button"
				:aria-pressed="show === option.id"
				class="rounded-full px-2.5 py-1 text-xs transition-colors"
				:class="
					show === option.id
						? 'bg-bg-surface font-medium text-text-primary'
						: 'text-text-secondary hover:text-text-primary'
				"
				@click="setQuery({ show: option.id })"
			>
				{{ t(option.label) }}
			</button>
			<button
				v-if="category"
				type="button"
				class="inline-flex items-center gap-1 rounded-full bg-bg-surface px-2.5 py-1 text-xs font-medium text-text-primary"
				:aria-label="t('dashboard.inboxes.clearCategory')"
				@click="setQuery({ category: null })"
			>
				{{ t(`dashboard.inboxes.category.${category}`) }}
				<Icon name="lucide:x" class="size-3" />
			</button>
		</div>

		<div v-if="isLoading && rows.length === 0" class="mt-4 space-y-2">
			<UiSkeleton v-for="i in 6" :key="i" class="h-14 w-full rounded-lg" />
		</div>
		<div v-else-if="rows.length === 0" class="mt-10 text-center text-sm text-text-secondary">
			{{ t('dashboard.inboxes.empty') }}
		</div>
		<ul
			v-else
			class="mt-4 divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle bg-bg-elevated"
		>
			<li v-for="row in rows" :key="row.key">
				<NuxtLink
					:to="row.href"
					class="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-bg-surface"
				>
					<span
						class="mt-1.5 size-1.5 shrink-0 rounded-full"
						:class="row.unread ? 'bg-brand' : 'bg-transparent'"
						aria-hidden="true"
					/>
					<span class="min-w-0 flex-1">
						<span class="flex items-baseline gap-2">
							<span
								class="truncate text-sm"
								:class="row.unread ? 'font-medium text-text-primary' : 'text-text-secondary'"
								>{{ row.title || t('components.shell.noSubject') }}</span
							>
							<ShellStatusPill v-if="row.status" :status="row.status" class="shrink-0" />
						</span>
						<span class="mt-0.5 block truncate text-xs text-text-tertiary">
							{{ senderLabel(row.from)
							}}<template v-if="row.snippet"> — {{ row.snippet }}</template>
						</span>
					</span>
					<span class="flex shrink-0 flex-col items-end gap-1">
						<InboxChip
							v-if="inboxOf(row.inboxId)"
							:name="inboxOf(row.inboxId)!.name"
							:slot="inboxOf(row.inboxId)!.slot"
						/>
						<span
							v-else
							class="inline-flex items-center gap-1 rounded-full bg-bg-surface px-2 py-px text-2xs font-medium text-text-secondary"
							><Icon name="lucide:bot" class="size-3" />{{ t('components.shell.teamInbox') }}</span
						>
						<span class="text-2xs tabular-nums text-text-tertiary">{{
							formatCompactRelativeTime(row.at)
						}}</span>
					</span>
				</NuxtLink>
			</li>
		</ul>
		<p class="mt-3 text-xs text-text-tertiary">
			{{ t('dashboard.inboxes.footnote', { count: PER_INBOX }) }}
		</p>
	</div>
</template>
