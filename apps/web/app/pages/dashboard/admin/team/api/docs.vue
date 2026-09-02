<script setup lang="ts">
/**
 * Instance-specific API quickstart. The full endpoint reference lives on the
 * docs site — this page used to hand-maintain a 565-line copy of that
 * catalog (with a placeholder base URL), which drifted from the real API.
 * Now it only shows what the docs site cannot: THIS instance's base URL and
 * ready-to-paste snippets against it.
 */
const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.team.api.docs.pageTitle') });

definePageMeta({
	layout: 'admin',
	middleware: ['auth', 'admin'],
});

const runtimeConfig = useRuntimeConfig();
const apiBaseUrl = computed(
	() => runtimeConfig.public.convexSiteUrl || runtimeConfig.public.convexUrl || ''
);

const { copy, copiedKey } = useCopyToClipboard();

const curlExample = computed(() =>
	[
		`curl -X POST ${apiBaseUrl.value}/api/v1/contacts \\`,
		"  -H 'Authorization: Bearer YOUR_API_KEY' \\",
		"  -H 'Content-Type: application/json' \\",
		`  -d '{"email": "jane@example.com", "firstName": "Jane"}'`,
	].join('\n')
);

const endpoints = computed(() => [
	{
		method: 'GET/POST',
		path: '/api/v1/contacts',
		description: t('dashboard.admin.team.api.docs.endpoints.contacts'),
	},
	{
		method: 'GET/PUT/DELETE',
		path: '/api/v1/contacts/:id',
		description: t('dashboard.admin.team.api.docs.endpoints.contact'),
	},
	{ method: 'POST', path: '/api/v1/events', description: t('dashboard.admin.team.api.docs.endpoints.events') },
	{
		method: 'POST',
		path: '/api/v1/transactional',
		description: t('dashboard.admin.team.api.docs.endpoints.transactional'),
	},
	{ method: '*', path: '/api/v1/topics/…', description: t('dashboard.admin.team.api.docs.endpoints.topics') },
	{ method: 'GET', path: '/api/v1/health', description: t('dashboard.admin.team.api.docs.endpoints.health') },
]);
</script>

<template>
	<div class="max-w-3xl">
		<div class="mb-8">
			<NuxtLink
				to="/dashboard/admin/team/api"
				class="text-sm text-text-secondary inline-flex items-center gap-1 hover:text-text-primary mb-4"
			>
				<Icon name="lucide:arrow-left" class="w-3.5 h-3.5" />
				{{ t('dashboard.admin.team.api.docs.backToKeys') }}
			</NuxtLink>
			<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
				{{ t('dashboard.admin.team.api.docs.title') }}
			</h1>
			<I18nT keypath="dashboard.admin.team.api.docs.intro" tag="p" scope="global" class="text-text-secondary mt-1">
				<template #settingsLink>
					<NuxtLink to="/dashboard/admin/team/api" class="link">{{
						t('dashboard.admin.team.api.docs.introLink')
					}}</NuxtLink>
				</template>
			</I18nT>
		</div>

		<UiCard class="mb-6">
			<h2 class="text-sm font-medium text-text-secondary mb-2">{{ t('dashboard.admin.team.api.docs.baseUrlTitle') }}</h2>
			<div class="flex items-center gap-2">
				<code
					class="flex-1 px-3 py-2 bg-bg-surface border border-border-subtle rounded-lg text-sm text-text-primary overflow-x-auto"
				>
					{{ apiBaseUrl || t('dashboard.admin.team.api.docs.baseUrlMissing') }}
				</code>
				<UiButton
					v-if="apiBaseUrl"
					variant="secondary"
					size="sm"
					@click="copy(apiBaseUrl, 'base-url')"
				>
					<Icon :name="copiedKey === 'base-url' ? 'lucide:check' : 'lucide:copy'" class="w-4 h-4" />
				</UiButton>
			</div>
		</UiCard>

		<UiCard class="mb-6">
			<div class="flex items-center justify-between mb-2">
				<h2 class="text-sm font-medium text-text-secondary">{{ t('dashboard.admin.team.api.docs.createContact') }}</h2>
				<UiButton variant="ghost" size="sm" @click="copy(curlExample, 'curl')">
					<Icon :name="copiedKey === 'curl' ? 'lucide:check' : 'lucide:copy'" class="w-4 h-4" />
				</UiButton>
			</div>
			<pre
				class="px-3 py-2 bg-bg-surface border border-border-subtle rounded-lg text-xs text-text-primary overflow-x-auto"
			><code>{{ curlExample }}</code></pre>
		</UiCard>

		<UiCard class="mb-6" padding="none" overflow="hidden">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-border-subtle text-left">
						<th class="px-4 py-3 font-medium text-text-secondary">{{ t('dashboard.admin.team.api.docs.table.method') }}</th>
						<th class="px-4 py-3 font-medium text-text-secondary">
							{{ t('dashboard.admin.team.api.docs.table.endpoint') }}
						</th>
						<th class="px-4 py-3 font-medium text-text-secondary">{{ t('common.description') }}</th>
					</tr>
				</thead>
				<tbody>
					<tr
						v-for="e in endpoints"
						:key="e.path"
						class="border-b border-border-subtle last:border-0"
					>
						<td class="px-4 py-3 font-mono text-xs text-text-tertiary whitespace-nowrap">
							{{ e.method }}
						</td>
						<td class="px-4 py-3 font-mono text-xs text-text-primary whitespace-nowrap">
							{{ e.path }}
						</td>
						<td class="px-4 py-3 text-text-secondary">{{ e.description }}</td>
					</tr>
				</tbody>
			</table>
		</UiCard>

		<UiButton
			href="https://docs.owlat.app/api/"
			target="_blank"
			rel="noopener noreferrer"
			class="gap-2"
		>
			<Icon name="lucide:book-open" class="w-4 h-4" />
			{{ t('dashboard.admin.team.api.docs.fullReference') }}
			<Icon name="lucide:external-link" class="w-3.5 h-3.5" />
		</UiButton>
	</div>
</template>
