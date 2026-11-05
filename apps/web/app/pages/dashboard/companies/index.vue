<script setup lang="ts">
/**
 * Companies: the people the workspace talks to, grouped by the organisational
 * domain of their addresses, most recent contact first. Each row opens the
 * company. The list holds only conversations the viewer could open anyway
 * (`companies/companies.ts`); search filters it here, by name or domain.
 */
import { api } from '@owlat/api';
import { companyHref, filterCompanies } from '~/utils/companies';
import { formatCompactRelativeTime, formatRelativeTime } from '~/utils/formatters';
import CompanyLogo from '~/components/companies/CompanyLogo.vue';
import { BriefcaseIcon, SearchIcon } from '@coolicons/vue';

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const { t } = useI18n();
useHead({ title: () => t('dashboard.companies.index.pageTitle') });

const { data, isLoading, error, refetch } = useConvexQuery(api.companies.companies.list, {});
const companies = computed(() => data.value ?? []);

const search = ref('');
const shown = computed(() => filterCompanies(companies.value, search.value));
</script>

<template>
	<div class="mx-auto w-full max-w-page p-6 lg:p-8">
		<UiPageHeader
			:title="t('dashboard.companies.index.title')"
			:description="t('dashboard.companies.index.subtitle')"
			class="mb-6"
		/>

		<UiQueryBoundary
			:loading="isLoading && data === undefined"
			:error="error"
			:empty="companies.length === 0"
			@retry="refetch"
		>
			<template #loading>
				<div
					class="divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle bg-bg-elevated"
					aria-hidden="true"
				>
					<UiSkeletonRow v-for="n in 5" :key="n" class="px-4 py-3" avatar :lines="2" trailing />
				</div>
			</template>
			<template #empty>
				<UiEmptyState
					:icon="BriefcaseIcon"
					:title="t('dashboard.companies.index.emptyTitle')"
					:description="t('dashboard.companies.index.emptyDescription')"
					data-testid="companies-empty"
				/>
			</template>

			<div class="mb-4 w-full sm:max-w-sm">
				<div class="relative">
					<SearchIcon
						class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary"
						aria-hidden="true"
					/>
					<input
						v-model="search"
						type="search"
						class="input input-sm pl-9"
						:placeholder="t('dashboard.companies.index.searchPlaceholder')"
						:aria-label="t('dashboard.companies.index.searchLabel')"
						data-testid="companies-search"
					/>
				</div>
			</div>

			<UiEmptyState
				v-if="shown.length === 0"
				variant="no-results"
				:title="t('dashboard.companies.index.noResults', { query: search.trim() })"
				:heading-level="3"
				@clear="search = ''"
			/>
			<ul
				v-else
				class="divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle bg-bg-elevated"
				:aria-label="t('dashboard.companies.index.listLabel')"
				data-testid="companies-list"
			>
				<li v-for="company in shown" :key="company.key">
					<NuxtLink
						:to="companyHref(company.key)"
						class="flex items-center gap-3 px-4 py-3 outline-none transition-colors hover:bg-bg-surface focus-visible:bg-bg-surface focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
						data-testid="company-row"
					>
						<CompanyLogo :company-key="company.key" :name="company.name" />
						<span class="min-w-0 flex-1">
							<span class="block truncate text-sm font-medium text-text-primary">{{
								company.name
							}}</span>
							<span class="block truncate text-xs text-text-tertiary">{{ company.key }}</span>
						</span>
						<span
							class="hidden shrink-0 items-center sm:flex"
							:title="company.people.join(', ')"
							data-testid="company-row-people"
						>
							<span class="flex -space-x-1.5" aria-hidden="true">
								<UiAvatar
									v-for="address in company.people"
									:key="address"
									:email="address"
									size="sm"
									deterministic-color
									class="ring-2 ring-bg-elevated"
								/>
							</span>
							<span
								v-if="company.peopleCount > company.people.length"
								class="ml-1.5 text-2xs text-text-tertiary"
								aria-hidden="true"
								>+{{ company.peopleCount - company.people.length }}</span
							>
							<span class="sr-only">{{
								t(
									'dashboard.companies.index.peopleCount',
									{ count: company.peopleCount },
									company.peopleCount
								)
							}}</span>
						</span>
						<span class="w-28 shrink-0 text-right text-xs text-text-tertiary max-sm:w-auto">
							<span class="block text-text-secondary">{{
								t(
									'dashboard.companies.index.conversations',
									{ count: company.conversations },
									company.conversations
								)
							}}</span>
							<time
								:datetime="new Date(company.lastMessageAt).toISOString()"
								:title="formatRelativeTime(company.lastMessageAt)"
								>{{ formatCompactRelativeTime(company.lastMessageAt) }}</time
							>
						</span>
					</NuxtLink>
				</li>
			</ul>
			<p class="mt-3 text-xs text-text-tertiary">{{ t('dashboard.companies.index.footnote') }}</p>
		</UiQueryBoundary>
	</div>
</template>
