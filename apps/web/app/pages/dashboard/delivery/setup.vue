<script setup lang="ts">
useHead({ title: 'Delivery setup — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

// Delivery-infrastructure config surfaces. API keys are app-level (they live
// under Settings) but are cross-linked here because they authenticate the send
// API. Suppressions live under Audience (they are audience data) but are
// cross-linked here because they directly protect deliverability.
const sections = [
	{
		name: 'Delivery provider',
		description: 'Check the email delivery provider and send a test email to confirm sending works',
		href: '/dashboard/delivery/config',
		icon: 'lucide:send',
	},
	{
		name: 'Sending domains',
		description: 'Configure custom sending domains for better deliverability',
		href: '/dashboard/delivery/domains',
		icon: 'lucide:globe',
	},
	// Provider routing is demoted to the "Advanced routing" link on the Delivery
	// hub's transport card — the escape hatch, not a peer top-level section — so
	// it no longer competes with the one instance-level transport for attention.
	// The route itself is unchanged and still reachable from that link.
	{
		name: 'Webhooks',
		description: 'Receive real-time notifications when delivery events happen',
		href: '/dashboard/delivery/webhooks',
		icon: 'lucide:webhook',
	},
	{
		name: 'API keys',
		description: 'Manage API keys that authenticate your send and API requests',
		href: '/dashboard/settings/api',
		icon: 'lucide:key',
	},
	{
		name: 'Suppressions',
		description:
			'Addresses that no longer receive mail after a bounce, complaint, or manual suppression',
		href: '/dashboard/audience/suppressions',
		icon: 'lucide:ban',
	},
];
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="mb-6">
			<NuxtLink
				to="/dashboard/delivery"
				class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary mb-4"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
				Delivery health
			</NuxtLink>
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:settings-2" size="lg" variant="brand" rounded="xl" />
				<div>
					<h1 class="text-2xl font-semibold text-text-primary">Delivery setup</h1>
					<p class="mt-1 text-text-secondary">
						Configure the domains, providers, and integrations your email sends through
					</p>
				</div>
			</div>
		</div>

		<!-- Setup sections -->
		<div class="grid gap-4">
			<NuxtLink
				v-for="section in sections"
				:key="section.href"
				:to="section.href"
				class="card p-6 flex items-center justify-between hover:bg-bg-surface/50 transition-colors group"
			>
				<div class="flex items-center gap-4">
					<div
						class="p-3 rounded-lg bg-bg-surface group-hover:bg-brand/10 transition-colors flex items-center justify-center"
					>
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
				<Icon
					name="lucide:chevron-right"
					class="w-5 h-5 text-text-tertiary group-hover:text-brand transition-colors"
				/>
			</NuxtLink>
		</div>
	</div>
</template>
