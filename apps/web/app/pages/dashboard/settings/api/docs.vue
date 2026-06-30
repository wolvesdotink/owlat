<script setup lang="ts">
/**
 * Instance-specific API quickstart. The full endpoint reference lives on the
 * docs site — this page used to hand-maintain a 565-line copy of that
 * catalog (with a placeholder base URL), which drifted from the real API.
 * Now it only shows what the docs site cannot: THIS instance's base URL and
 * ready-to-paste snippets against it.
 */
useHead({ title: 'API Quickstart — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const runtimeConfig = useRuntimeConfig();
const apiBaseUrl = computed(
	() => runtimeConfig.public.convexSiteUrl || runtimeConfig.public.convexUrl || '',
);

const { copy, copiedKey } = useCopyToClipboard();

const curlExample = computed(() =>
	[
		`curl -X POST ${apiBaseUrl.value}/api/v1/contacts \\`,
		"  -H 'Authorization: Bearer YOUR_API_KEY' \\",
		"  -H 'Content-Type: application/json' \\",
		`  -d '{"email": "jane@example.com", "firstName": "Jane"}'`,
	].join('\n'),
);

const endpoints = [
	{ method: 'GET/POST', path: '/api/v1/contacts', description: 'List or create contacts' },
	{ method: 'GET/PUT/DELETE', path: '/api/v1/contacts/:id', description: 'Read, update, or delete a contact' },
	{ method: 'POST', path: '/api/v1/events', description: 'Track custom events' },
	{ method: 'POST', path: '/api/v1/transactional', description: 'Send a transactional email (slug in body)' },
	{ method: '*', path: '/api/v1/topics/…', description: 'Manage topics and subscriptions' },
	{ method: 'GET', path: '/api/v1/health', description: 'Health probe' },
];
</script>

<template>
	<div class="max-w-3xl">
		<div class="mb-8">
			<NuxtLink
				to="/dashboard/settings/api"
				class="text-sm text-text-secondary inline-flex items-center gap-1 hover:text-text-primary mb-4"
			>
				<Icon name="lucide:arrow-left" class="w-3.5 h-3.5" />
				Back to API Keys
			</NuxtLink>
			<h1 class="text-2xl font-semibold text-text-primary">API Quickstart</h1>
			<p class="text-text-secondary mt-1">
				Authenticate with a scoped API key from
				<NuxtLink to="/dashboard/settings/api" class="link">Settings → API Keys</NuxtLink>.
			</p>
		</div>

		<UiCard class="mb-6">
			<h2 class="text-sm font-medium text-text-secondary mb-2">Your API base URL</h2>
			<div class="flex items-center gap-2">
				<code class="flex-1 px-3 py-2 bg-bg-surface border border-border-subtle rounded-lg text-sm text-text-primary overflow-x-auto">
					{{ apiBaseUrl || 'Not configured (NUXT_PUBLIC_CONVEX_SITE_URL)' }}
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
				<h2 class="text-sm font-medium text-text-secondary">Create a contact</h2>
				<UiButton variant="ghost" size="sm" @click="copy(curlExample, 'curl')">
					<Icon :name="copiedKey === 'curl' ? 'lucide:check' : 'lucide:copy'" class="w-4 h-4" />
				</UiButton>
			</div>
			<pre class="px-3 py-2 bg-bg-surface border border-border-subtle rounded-lg text-xs text-text-primary overflow-x-auto"><code>{{ curlExample }}</code></pre>
		</UiCard>

		<UiCard class="mb-6" padding="none" overflow="hidden">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-border-subtle text-left">
						<th class="px-4 py-3 font-medium text-text-secondary">Method</th>
						<th class="px-4 py-3 font-medium text-text-secondary">Endpoint</th>
						<th class="px-4 py-3 font-medium text-text-secondary">Description</th>
					</tr>
				</thead>
				<tbody>
					<tr v-for="e in endpoints" :key="e.path" class="border-b border-border-subtle last:border-0">
						<td class="px-4 py-3 font-mono text-xs text-text-tertiary whitespace-nowrap">{{ e.method }}</td>
						<td class="px-4 py-3 font-mono text-xs text-text-primary whitespace-nowrap">{{ e.path }}</td>
						<td class="px-4 py-3 text-text-secondary">{{ e.description }}</td>
					</tr>
				</tbody>
			</table>
		</UiCard>

		<a
			href="https://docs.owlat.app/api/"
			target="_blank"
			rel="noopener noreferrer"
			class="btn btn-primary gap-2"
		>
			<Icon name="lucide:book-open" class="w-4 h-4" />
			Full API reference
			<Icon name="lucide:external-link" class="w-3.5 h-3.5" />
		</a>
	</div>
</template>
