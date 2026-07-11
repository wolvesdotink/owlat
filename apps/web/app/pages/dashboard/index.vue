<script setup lang="ts">
import type { SavedRule } from '~/composables/useDashboardRules';

useHead({ title: 'Dashboard — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const { user } = useAuth();
const { hasActiveOrganization, role } = useOrganizationContext();

const userId = computed(() => user.value?.id ?? null);
// Admins/owners see open mailbox requests from teammates stuck at the
// fresh-start dead-end (see components/dashboard/MailboxRequests.vue).
const isAdmin = computed(() => role.value === 'owner' || role.value === 'admin');

const { cards, availableCards, savedRules, isLoading, isEditing, saveLayout } =
	useAdaptiveDashboard();

// Default cards to show when no adaptive layout is available
const defaultCards = [
	{ type: 'verification_queue', size: 'large' as const },
	{ type: 'campaign_performance', size: 'medium' as const },
	{ type: 'delivery_rates', size: 'medium' as const },
	{ type: 'channel_health', size: 'small' as const },
	{ type: 'agent_health', size: 'small' as const },
	{ type: 'recent_contacts', size: 'small' as const },
	{ type: 'upcoming_campaigns', size: 'small' as const },
];

const displayCards = computed(() => {
	if (cards.value.length > 0) return cards.value;
	return defaultCards;
});

function openEditor() {
	isEditing.value = true;
}

function closeEditor() {
	isEditing.value = false;
}

async function handleSave(
	pinnedCards: Array<{ type: string; size: 'small' | 'medium' | 'large'; config?: string }>,
	rules: SavedRule[]
) {
	await saveLayout(pinnedCards, rules);
}
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="flex items-center justify-between mb-8">
			<div>
				<h1 class="text-2xl font-semibold text-text-primary">
					Welcome back{{ user?.name ? `, ${user.name.split(' ')[0]}` : '' }}
				</h1>
				<p class="mt-1 text-text-secondary">Here's what's happening with your email marketing.</p>
			</div>
			<UiButton variant="outline" size="sm" @click="openEditor">
				<template #iconLeft>
					<Icon name="lucide:settings-2" class="w-4 h-4" />
				</template>
				Customize
			</UiButton>
		</div>

		<!--
			Admin-only escalations from teammates stuck at a dead-end. These sit
			above the unified "Getting started" surface as distinct concerns.
		-->
		<DashboardAccessRequests v-if="hasActiveOrganization && isAdmin" />
		<DashboardMailboxRequests v-if="hasActiveOrganization && isAdmin" />

		<!--
			The single, adaptive "Getting started" surface. It replaces the three
			previously-stacked onboarding affordances (self-host banner + instance
			go-live checklist + per-user checklist) with ONE card whose contents and
			ONE dismissal action adapt to the viewer (admin vs member) and the
			instance mode (fresh vs migration). See components/dashboard/GettingStarted.vue.
		-->
		<DashboardGettingStarted
			v-if="hasActiveOrganization && userId"
			:user-id="userId"
			:is-admin="isAdmin"
		/>

		<!-- Loading State -->
		<div v-if="isLoading" class="flex items-center justify-center py-16">
			<Icon name="lucide:loader-2" class="w-6 h-6 animate-spin text-text-tertiary" />
		</div>

		<!-- Adaptive Dashboard Grid -->
		<UiErrorBoundary
			v-else
			fallback-message="Couldn't load your dashboard cards. Please refresh to try again."
		>
			<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
				<DashboardCardRenderer
					v-for="(card, index) in displayCards"
					:key="`${card.type}-${index}`"
					:card="card"
				/>
			</div>
		</UiErrorBoundary>

		<!-- Dashboard Editor -->
		<DashboardEditor
			:is-open="isEditing"
			:cards="displayCards"
			:available-cards="availableCards"
			:rules="savedRules"
			@close="closeEditor"
			@save="handleSave"
		/>
	</div>
</template>
