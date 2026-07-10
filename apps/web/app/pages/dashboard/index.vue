<script setup lang="ts">
import type { SavedRule } from '~/composables/useDashboardRules';

useHead({ title: 'Dashboard — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const { user } = useAuth();
const { hasActiveOrganization } = useOrganizationContext();

const userId = computed(() => user.value?.id ?? null);

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
			Onboarding surface. Exactly one of these is ever visible at a time and
			both share the same instance-scoped dismissal record:
			- SelfHostOnboardingBanner owns the self-host pre-send phase (configure a
			  delivery provider / verify a domain) and auto-hides once the instance
			  can send.
			- OnboardingChecklist takes over afterwards (and is the only surface in
			  non-self-host mode) for the remaining go-live steps. It suppresses
			  itself while the banner owns the pre-send phase.
		-->
		<DashboardSelfHostOnboardingBanner v-if="hasActiveOrganization && userId" :user-id="userId" />
		<DashboardOnboardingChecklist v-if="hasActiveOrganization && userId" :user-id="userId" />

		<!--
			Persistent, resumable per-user onboarding checklist (piece c1). Distinct
			from the instance-wide admin checklist above: this tracks THIS member's
			personal setup journey (mailbox, optional import, first send) and its
			steps adapt to migration vs fresh-start mode. Dismissible; gone for good
			once complete.
		-->
		<OnboardingUserChecklist
			v-if="hasActiveOrganization && userId"
			:user-id="userId"
			class="mb-8"
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
