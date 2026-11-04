<script setup lang="ts">
/**
 * The Workbench's People card for one inbox: who waits on you, then who you
 * were last talking to, each with the topic they lead with, as a row of
 * people rather than a list of subjects. A row opens that person's page in the
 * People view; the heading opens the view itself. Hidden with the classic
 * inbox, which has no People view to open.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { ArrowRightIcon } from '@coolicons/vue';
import { askingSentence, dueParts } from '~/utils/postboxPeople';

/** The Workbench tab's inbox (a tab scope is a mailbox id for a personal tab). */
const props = defineProps<{ mailboxId: string }>();

const { t } = useI18n();
const { data } = useConvexQuery(
	api.mail.people.directory.sidebarPeople,
	() => ({ mailboxId: props.mailboxId as Id<'mailboxes'>, limit: 6 }),
	{ keepPreviousData: true }
);
const rows = computed(() => data.value?.people ?? []);
const companies = computed(() => data.value?.companies ?? []);
const { locale } = useI18n();
/** What the company mail asks, with its due date, else its topic. */
function companyLine(company: {
	title: string;
	reason?: { en: string; de: string };
	dueAt?: number;
}): string {
	if (!company.reason) return company.title;
	const text = locale.value === 'de' ? company.reason.de : company.reason.en;
	if (!company.dueAt) return text;
	const { date, isOverdue } = dueParts(company.dueAt, locale.value);
	return `${text} · ${t(`components.postbox.people.row.${isOverdue ? 'overdueOn' : 'dueOn'}`, { date })}`;
}
const companyHref = (key: string) =>
	`/dashboard/postbox/inbox?mailbox=${props.mailboxId}&company=${encodeURIComponent(key)}`;
// Everyone waiting in the inbox's recent mail, not only the rows shown, and
// only on a request Owlat read: the Answer card above counts its own flags.
const waitingCount = computed(() => data.value?.waitingCount ?? 0);
const isShared = computed(() => data.value?.scope === 'shared');
const owedConversations = computed(() => data.value?.owedConversations ?? 0);
const waitingRows = computed(() => rows.value.filter((r) => r.owedCount > 0));
const recentRows = computed(() => rows.value.filter((r) => r.owedCount === 0));
// Who waits on you under the heading that counts them; whoever else you wrote
// with lately apart, so the heading never counts a row it does not mean.
const personGroups = computed(() => [
	{ id: 'waiting', title: null, rows: waitingRows.value },
	// The sub-heading only sets these apart from people who wait; alone, the card's heading says it.
	{
		id: 'recent',
		title: waitingRows.value.length > 0 ? t('components.today.people.recent') : null,
		rows: recentRows.value,
	},
]);
const peopleHref = computed(() => `/dashboard/postbox/inbox?mailbox=${props.mailboxId}`);
const hrefFor = (key: string) =>
	`/dashboard/postbox/inbox?mailbox=${props.mailboxId}&person=${encodeURIComponent(key)}`;
</script>

<template>
	<section
		v-if="rows.length > 0 || companies.length > 0"
		aria-labelledby="today-people"
		data-testid="today-people"
	>
		<h3
			id="today-people"
			class="mb-2 mt-8 flex items-center text-2xs font-medium uppercase tracking-wider text-text-tertiary"
		>
			{{
				waitingCount > 0
					? t(
							isShared
								? 'components.today.people.waitingTeamWithCount'
								: 'components.today.people.waitingWithCount',
							{
								people: t(
									'components.postbox.people.column.peopleCount',
									{ count: waitingCount },
									waitingCount
								),
								conversations: owedConversations,
							},
							owedConversations
						)
					: t('components.today.people.title')
			}}
			<NuxtLink
				:to="peopleHref"
				class="ml-auto inline-flex items-center gap-1 normal-case tracking-normal text-brand hover:underline"
			>
				{{ t('components.today.people.open') }}
				<ArrowRightIcon class="h-3 w-3" />
			</NuxtLink>
		</h3>
		<template v-for="group in personGroups" :key="group.id">
			<h4
				v-if="group.title && group.rows.length > 0"
				class="mb-2 mt-4 text-2xs font-medium uppercase tracking-wider text-text-tertiary"
			>
				{{ group.title }}
			</h4>
			<ul v-if="group.rows.length > 0" class="grid grid-cols-1 gap-2 sm:grid-cols-2">
				<li v-for="row in group.rows" :key="row.key">
					<NuxtLink
						:to="hrefFor(row.key)"
						class="flex h-full items-center gap-3 rounded-xl border border-border-subtle bg-bg-elevated px-3 py-2.5 transition-colors hover:bg-bg-surface"
					>
						<PostboxPeopleAvatar kind="person" :name="row.name" :color-key="row.key" size="md" />
						<span class="min-w-0 flex-1">
							<span class="block truncate text-sm font-medium text-text-primary">{{
								row.name
							}}</span>
							<span class="line-clamp-2 text-xs text-text-tertiary">{{
								(row.leadSnippet && askingSentence(row.leadSnippet)) || row.leadTitle
							}}</span>
						</span>
						<PostboxPeopleMark
							:owed="row.owedCount"
							:may-owe="row.mayOweCount"
							:unread="row.unread"
						/>
					</NuxtLink>
				</li>
			</ul>
		</template>
		<template v-if="companies.length > 0">
			<h4 class="mb-2 mt-4 text-2xs font-medium uppercase tracking-wider text-text-tertiary">
				{{ t('components.postbox.people.column.fromCompanies') }}
			</h4>
			<ul class="grid grid-cols-1 gap-2 sm:grid-cols-2">
				<li v-for="company in companies" :key="company.key">
					<NuxtLink
						:to="companyHref(company.key)"
						class="flex h-full items-center gap-3 rounded-xl border border-border-subtle bg-bg-elevated px-3 py-2.5 transition-colors hover:bg-bg-surface"
					>
						<PostboxPeopleAvatar
							kind="company"
							:name="company.name"
							:logo-url="company.logoUrl"
							:is-automated="company.isAutomated"
							:sender-kind="company.kind"
							size="md"
						/>
						<span class="min-w-0 flex-1">
							<span class="block truncate text-sm font-medium text-text-primary">{{
								company.name
							}}</span>
							<span class="block truncate text-xs text-text-tertiary">{{
								companyLine(company)
							}}</span>
						</span>
						<PostboxPeopleMark :owed="company.actionableCount" />
					</NuxtLink>
				</li>
			</ul>
		</template>
	</section>
</template>
