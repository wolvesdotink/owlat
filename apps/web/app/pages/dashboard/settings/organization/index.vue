<script setup lang="ts">

useHead({ title: 'Organization Settings — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

// Organization settings sections
const sections = [
	{
		name: 'Team Members',
		description: 'Manage team members, invite new users, and control access',
		href: '/dashboard/settings/team',
		icon: 'lucide:users',
	},
	{
		name: 'Email Theme',
		description: 'Configure default colors and fonts for your email templates',
		href: '/dashboard/settings/email-theme',
		icon: 'lucide:palette',
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
				<UiIconBox icon="lucide:building-2" size="lg" variant="brand" rounded="xl" />

				<div>
					<h1 class="text-2xl font-semibold text-text-primary">Organization</h1>
					<p class="mt-1 text-text-secondary">Manage your team and organization settings</p>
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
