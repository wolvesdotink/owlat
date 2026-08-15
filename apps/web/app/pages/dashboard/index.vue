<script setup lang="ts">
import type { SavedRule } from '~/composables/useDashboardRules';

const { t } = useI18n();

useHead({ title: () => t('dashboard.index.pageTitle') });

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
const adminDefaultCards = [
	{ type: 'verification_queue', size: 'large' as const },
	{ type: 'campaign_performance', size: 'medium' as const },
	{ type: 'delivery_rates', size: 'medium' as const },
	{ type: 'channel_health', size: 'small' as const },
	{ type: 'agent_health', size: 'small' as const },
	{ type: 'recent_contacts', size: 'small' as const },
	{ type: 'upcoming_campaigns', size: 'small' as const },
];

const memberDefaultCards = [
	{ type: 'campaign_performance', size: 'medium' as const },
	{ type: 'recent_contacts', size: 'small' as const },
	{ type: 'upcoming_campaigns', size: 'small' as const },
];

const firstName = computed(() => user.value?.name?.split(' ')[0] ?? '');

const displayCards = computed(() => {
	if (cards.value.length > 0) return cards.value;
	return isAdmin.value ? adminDefaultCards : memberDefaultCards;
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
				<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
					<I18nT v-if="firstName" keypath="dashboard.index.welcomeNamed" tag="span" scope="global">
						<template #name
							><span class="lp-title-accent">{{ firstName }}</span></template
						>
					</I18nT>
					<template v-else>{{ t('dashboard.index.welcome') }}</template>
				</h1>
				<p class="mt-1 text-text-secondary">
					{{ isAdmin ? t('dashboard.index.subtitleAdmin') : t('dashboard.index.subtitleMember') }}
				</p>
			</div>
			<UiButton variant="outline" size="sm" @click="openEditor">
				<template #iconLeft>
					<Icon name="lucide:settings-2" class="w-4 h-4" />
				</template>
				{{ t('dashboard.index.customize') }}
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
		<UiErrorBoundary v-else :fallback-message="t('dashboard.index.cardsErrorFallback')">
			<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
				<DashboardCardRenderer
					v-for="(card, index) in displayCards"
					:key="`${card.type}-${index}`"
					:card="card"
				/>
			</div>
		</UiErrorBoundary>

		<!--
			Dashboard Editor — available to every role, matching the "Customize"
			button above. The backend role-filters `getAvailableCards` and
			`saveLayout` is an authed (not admin) mutation, so a member customizing
			their own layout only ever sees and pins cards they may read. Gating this
			on `isAdmin` would leave members with a button that does nothing.
		-->
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
