<script setup lang="ts">
/**
 * One company, led by the open work about it (the tasks the viewer can see),
 * then the conversations with anyone there as its history and evidence, and
 * the people beside them. The colleague line is the one thing
 * that comes from mail the viewer cannot open, and it carries names only
 * (`companies/read.ts`).
 *
 * A key the index does not know yet (a conversation that arrived since the
 * last sweep, a mistyped link) reads as an empty company, not an error.
 */
import { api } from '@owlat/api';
import { companyKeyOfDomain, companyNameFromKey } from '@owlat/shared/companyKey';
import { useCompanyColleagues } from '~/composables/companies/useCompanyColleagues';
import { companyConversationHref, conversationPeople, personLabel } from '~/utils/companies';
import { formatCompactRelativeTime, formatRelativeTime } from '~/utils/formatters';
import CompanyLogo from '~/components/companies/CompanyLogo.vue';
import CompanyTaskList from '~/components/companies/CompanyTaskList.vue';
import { ArrowLeftIcon, BriefcaseIcon, InboxIcon, MailIcon, UsersIcon } from '@coolicons/vue';

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const { t } = useI18n();
const route = useRoute();

const rawKey = computed(() => {
	const param = route.params['key'];
	return (Array.isArray(param) ? param[0] : param) ?? '';
});
/** The key as the index stores it (`mail.northwind.example` → `northwind.example`). */
const companyKey = computed(
	() => companyKeyOfDomain(rawKey.value) ?? rawKey.value.trim().toLowerCase()
);

const companyQuery = useConvexQuery(api.companies.companies.get, () =>
	companyKey.value ? { key: companyKey.value } : 'skip'
);
const tasksQuery = useConvexQuery(api.tasks.tasks.forCompany, () =>
	companyKey.value ? { companyKey: companyKey.value } : 'skip'
);

const company = computed(() => companyQuery.data.value ?? null);
const tasks = computed(() => tasksQuery.data.value ?? []);
const name = computed(() => company.value?.name ?? companyNameFromKey(companyKey.value));
const isLoading = computed(
	() => companyQuery.data.value === undefined && !companyQuery.error.value
);
const isEmpty = computed(() => {
	const c = company.value;
	if (!c) return true;
	return (
		c.conversations.length === 0 &&
		c.people.length === 0 &&
		c.colleagueUserIds.length === 0 &&
		tasks.value.length === 0
	);
});

const { lineFor } = useCompanyColleagues();
const colleagues = computed(() => (company.value ? lineFor(company.value) : null));

useHead({ title: () => name.value || t('dashboard.companies.index.pageTitle') });

const { setDynamicBreadcrumbs, clearDynamicBreadcrumbs } = useBreadcrumbs();
watch(
	name,
	(label) => {
		setDynamicBreadcrumbs([
			{ label: 'shared.breadcrumbRoutes.sections.companies', href: '/dashboard/companies' },
			{ label },
		]);
	},
	{ immediate: true }
);
onBeforeUnmount(clearDynamicBreadcrumbs);

type Conversation = NonNullable<typeof company.value>['conversations'][number];

function peopleOf(conversation: Conversation): string {
	const { shown, more } = conversationPeople(
		conversation.addresses,
		company.value?.people ?? [],
		3
	);
	const names = shown.join(', ');
	return more > 0 ? t('components.companies.context.peopleMore', { names, count: more }) : names;
}

function retry() {
	if (companyQuery.error.value) companyQuery.refetch();
	if (tasksQuery.error.value) tasksQuery.refetch();
}
</script>

<template>
	<div class="mx-auto w-full max-w-page p-6 lg:p-8">
		<NuxtLink
			to="/dashboard/companies"
			class="mb-4 inline-flex items-center gap-1.5 text-sm text-text-tertiary transition-colors hover:text-text-primary"
		>
			<ArrowLeftIcon class="h-4 w-4" aria-hidden="true" />
			{{ t('dashboard.companies.detail.back') }}
		</NuxtLink>

		<UiQueryBoundary
			:loading="isLoading"
			:error="companyQuery.error.value ?? tasksQuery.error.value"
			:empty="isEmpty"
			@retry="retry"
		>
			<template #loading>
				<div class="space-y-6" aria-hidden="true">
					<UiSkeletonRow avatar avatar-size="h-12 w-12" :lines="2" />
					<div
						class="divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle bg-bg-elevated"
					>
						<UiSkeletonRow v-for="n in 4" :key="n" class="px-4 py-3" :lines="2" trailing />
					</div>
				</div>
			</template>
			<template #empty>
				<UiEmptyState
					:icon="BriefcaseIcon"
					:eyebrow="companyKey"
					:title="t('dashboard.companies.detail.emptyTitle', { company: name })"
					:description="t('dashboard.companies.detail.emptyDescription')"
					data-testid="company-empty"
				>
					<template #action>
						<UiButton variant="secondary" to="/dashboard/companies">
							{{ t('dashboard.companies.detail.allCompanies') }}
						</UiButton>
					</template>
				</UiEmptyState>
			</template>

			<template v-if="company">
				<div class="mb-6 flex items-start gap-4">
					<CompanyLogo :company-key="company.key" :name="company.name" size="lg" class="mt-1" />
					<UiPageHeader class="min-w-0 flex-1" :title="company.name">
						<template #description>
							<span class="text-text-tertiary">{{ company.key }}</span>
							<template v-if="company.lastMessageAt !== null">
								·
								<time
									:datetime="new Date(company.lastMessageAt).toISOString()"
									:title="formatRelativeTime(company.lastMessageAt)"
									>{{
										t('dashboard.companies.detail.lastContact', {
											time: formatCompactRelativeTime(company.lastMessageAt),
										})
									}}</time
								>
							</template>
						</template>
						<template #actions>
							<TasksTaskCreatePopover
								:company-key="company.key"
								:label="t('dashboard.companies.detail.makeTask')"
								variant="secondary"
							/>
						</template>
					</UiPageHeader>
				</div>

				<p
					v-if="colleagues"
					class="mb-6 flex items-start gap-2 rounded-lg bg-bg-soft px-3 py-2 text-sm text-text-secondary"
					data-testid="company-colleagues"
				>
					<UsersIcon class="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" aria-hidden="true" />
					<span>{{ colleagues }}</span>
				</p>

				<div class="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
					<div class="min-w-0 space-y-8">
						<section aria-labelledby="company-tasks" data-testid="company-open-work">
							<h2
								id="company-tasks"
								class="mb-2 flex items-center text-2xs font-medium uppercase tracking-wider text-text-tertiary"
							>
								{{ t('dashboard.companies.detail.openWork') }}
								<span
									v-if="tasks.length > 0"
									class="ml-auto text-xs font-normal normal-case tracking-normal"
									>{{ tasks.length }}</span
								>
							</h2>
							<CompanyTaskList v-if="tasks.length > 0" :tasks="tasks" />
							<p v-else class="text-sm text-text-tertiary" data-testid="company-no-tasks">
								{{ t('dashboard.companies.detail.noTasks') }}
							</p>
						</section>

						<section aria-labelledby="company-conversations">
							<h2
								id="company-conversations"
								class="mb-2 flex items-center text-2xs font-medium uppercase tracking-wider text-text-tertiary"
							>
								{{ t('dashboard.companies.detail.conversations') }}
								<span class="ml-auto text-xs font-normal normal-case tracking-normal">{{
									company.conversations.length
								}}</span>
							</h2>
							<ul
								v-if="company.conversations.length > 0"
								class="divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle bg-bg-elevated"
								data-testid="company-conversations"
							>
								<li
									v-for="conversation in company.conversations"
									:key="
										conversation.mailThreadId ??
										conversation.conversationThreadId ??
										conversation.subject
									"
								>
									<component
										:is="companyConversationHref(conversation) ? 'NuxtLink' : 'div'"
										:to="companyConversationHref(conversation) ?? undefined"
										class="flex items-start gap-3 px-4 py-3 outline-none transition-colors"
										:class="
											companyConversationHref(conversation)
												? 'hover:bg-bg-surface focus-visible:bg-bg-surface focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand'
												: ''
										"
										data-testid="company-conversation"
									>
										<component
											:is="conversation.kind === 'team' ? InboxIcon : MailIcon"
											class="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary"
											aria-hidden="true"
										/>
										<span class="min-w-0 flex-1">
											<span class="block truncate text-sm font-medium text-text-primary">{{
												conversation.subject || t('components.companies.noSubject')
											}}</span>
											<span
												v-if="conversation.snippet"
												class="block truncate text-xs text-text-tertiary"
												>{{ conversation.snippet }}</span
											>
											<span
												class="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs"
											>
												<span class="truncate text-text-secondary">{{
													peopleOf(conversation)
												}}</span>
												<UiBadge variant="neutral" data-testid="company-conversation-source">{{
													conversation.kind === 'team'
														? t('components.companies.teamInbox')
														: (conversation.mailboxName ?? t('components.companies.mailbox'))
												}}</UiBadge>
											</span>
										</span>
										<time
											class="shrink-0 text-xs text-text-tertiary"
											:datetime="new Date(conversation.lastMessageAt).toISOString()"
											:title="formatRelativeTime(conversation.lastMessageAt)"
											>{{ formatCompactRelativeTime(conversation.lastMessageAt) }}</time
										>
									</component>
								</li>
							</ul>
							<p
								v-else
								class="rounded-xl border border-dashed border-border-subtle px-4 py-6 text-center text-sm text-text-tertiary"
							>
								{{ t('dashboard.companies.detail.noConversations') }}
							</p>
						</section>
					</div>

					<div class="space-y-8">
						<section v-if="company.people.length > 0" aria-labelledby="company-people">
							<h2
								id="company-people"
								class="mb-2 flex items-center text-2xs font-medium uppercase tracking-wider text-text-tertiary"
							>
								{{ t('dashboard.companies.detail.people') }}
								<span class="ml-auto text-xs font-normal normal-case tracking-normal">{{
									company.people.length
								}}</span>
							</h2>
							<ul class="space-y-0.5" data-testid="company-people">
								<li v-for="person in company.people" :key="person.address">
									<NuxtLink
										:to="`/dashboard/compose?to=${encodeURIComponent(person.address)}`"
										class="-mx-1.5 flex items-center gap-2.5 rounded-md px-1.5 py-1.5 outline-none hover:bg-bg-surface focus-visible:ring-1 focus-visible:ring-brand/40"
										:aria-label="
											t('dashboard.companies.detail.writeTo', { name: personLabel(person) })
										"
									>
										<UiAvatar
											:name="person.name"
											:email="person.address"
											size="md"
											deterministic-color
											aria-hidden="true"
										/>
										<span class="min-w-0 flex-1">
											<span class="block truncate text-sm text-text-primary">{{
												personLabel(person)
											}}</span>
											<span class="block truncate text-xs text-text-tertiary">
												<template v-if="person.name">{{ person.address }} · </template>
												{{
													t(
														'dashboard.companies.detail.personConversations',
														{ count: person.conversations },
														person.conversations
													)
												}}
												· {{ formatCompactRelativeTime(person.lastMessageAt) }}
											</span>
										</span>
									</NuxtLink>
								</li>
							</ul>
						</section>
					</div>
				</div>
			</template>
		</UiQueryBoundary>
	</div>
</template>
