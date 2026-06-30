<script setup lang="ts">

useHead({ title: 'Technical Settings — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

// Technical settings sections
const sections = [
	{
		name: 'Delivery',
		description: 'Check the email delivery provider and send a test email to confirm sending works',
		href: '/dashboard/settings/delivery',
		icon: 'lucide:send',
	},
	{
		name: 'API Keys',
		description: 'Manage API keys for authenticating your API requests',
		href: '/dashboard/settings/api',
		icon: 'lucide:key',
	},
	{
		name: 'Sending Domains',
		description: 'Configure custom sending domains for better deliverability',
		href: '/dashboard/settings/domains',
		icon: 'lucide:globe',
	},
	{
		name: 'Sending Reputation',
		description: 'Monitor domain reputation, sending limits, and account health',
		href: '/dashboard/settings/reputation',
		icon: 'lucide:shield-check',
	},
	{
		name: 'Provider Routing',
		description: 'Route message types across email providers with failover and workload-split',
		href: '/dashboard/settings/provider-routing',
		icon: 'lucide:route',
	},
	{
		name: 'Webhooks',
		description: 'Receive real-time notifications when events happen',
		href: '/dashboard/settings/webhooks',
		icon: 'lucide:webhook',
	},
	{
		name: 'Form Endpoints',
		description: 'Create embeddable signup forms for your website',
		href: '/dashboard/settings/forms',
		icon: 'lucide:file-text',
	},
	{
		name: 'Email Blocklist',
		description: 'Manage blocked email addresses to protect sender reputation',
		href: '/dashboard/settings/blocklist',
		icon: 'lucide:ban',
	},
	{
		name: 'Audit Log',
		description: 'Track team member actions and changes',
		href: '/dashboard/settings/audit',
		icon: 'lucide:clipboard-list',
	},
];
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="mb-6">
			<NuxtLink
				to="/dashboard/settings"
				class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary mb-4"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
				Back to Settings
			</NuxtLink>
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:wrench" size="lg" variant="brand" rounded="xl" />
				<div>
					<h1 class="text-2xl font-semibold text-text-primary">Technical</h1>
					<p class="mt-1 text-text-secondary">
						Configure API access, integrations, and developer tools
					</p>
				</div>
			</div>
		</div>

		<!-- Settings Sections -->
		<div class="grid gap-4">
			<NuxtLink
				v-for="section in sections"
				:key="section.href"
				:to="section.href"
				class="card p-6 flex items-center justify-between hover:bg-bg-surface/50 transition-colors group"
			>
				<div class="flex items-center gap-4">
					<div class="p-3 rounded-lg bg-bg-surface group-hover:bg-brand/10 transition-colors flex items-center justify-center">
						<Icon
							:name="section.icon"
							class="w-6 h-6 text-text-secondary group-hover:text-brand transition-colors"
						/>
					</div>
					<div>
						<h3 class="text-lg font-medium text-text-primary">{{ section.name }}</h3>
						<p class="text-sm text-text-secondary mt-0.5">{{ section.description }}</p>
					</div>
				</div>
				<Icon name="lucide:chevron-right" class="w-5 h-5 text-text-tertiary group-hover:text-brand transition-colors" />
			</NuxtLink>
		</div>
	</div>
</template>
