<script setup lang="ts">
import { api } from '@owlat/api';
import { shouldShowOnboardingChecklist } from '~/utils/onboarding';

const props = defineProps<{
	userId: string;
}>();

const config = useRuntimeConfig();
const isSelfHost = config.public.deploymentMode === 'selfhost';

// Fetch onboarding progress with actual data
const { data: progress, isLoading } = useOrganizationQuery(
	api.auth.onboarding.getWithActualProgress,
	() => ({
		userId: props.userId,
	})
);

// Dismiss mutation
const { run: dismiss } = useBackendOperation(api.auth.onboarding.dismiss, {
	label: 'Dismiss onboarding',
});

// Handle skip/dismiss
async function handleDismiss() {
	await dismiss({
		userId: props.userId,
	});
}

// Onboarding steps definition
const steps = computed(() => [
	{
		id: 'sendPathReady',
		title: 'Configure a sending provider',
		description:
			'Set up a delivery provider so this instance can actually send email — then send a test',
		icon: 'lucide:send',
		completed: progress.value?.sendPathReady ?? false,
		href: '/dashboard/settings/delivery',
		cta: 'Set up sending',
	},
	{
		id: 'addedContacts',
		title: 'Add contacts',
		description: 'Import or add your first contact',
		icon: 'lucide:users',
		completed: progress.value?.addedContacts ?? false,
		href: '/dashboard/audience/contacts',
		cta: 'Add Contacts',
	},
	{
		id: 'createdEmail',
		title: 'Create email',
		description: 'Build an email template you can send',
		icon: 'lucide:file-text',
		completed: progress.value?.createdEmail ?? false,
		href: '/dashboard/send/marketing',
		cta: 'Create Email',
	},
	{
		id: 'sentCampaign',
		title: 'Send campaign',
		description: 'Send your first email campaign to your audience',
		icon: 'lucide:megaphone',
		completed: progress.value?.sentCampaign ?? false,
		href: '/dashboard/campaigns/new',
		cta: 'New Campaign',
	},
	{
		id: 'createdApiKey',
		title: 'Create an API key',
		description:
			'Send transactional email (receipts, password resets) programmatically via the API',
		icon: 'lucide:key',
		completed: progress.value?.createdApiKey ?? false,
		href: '/dashboard/settings/api',
		cta: 'Create Key',
	},
	{
		id: 'setupDomain',
		title: 'Set up domain',
		description: 'Verify a sending domain (SPF, DKIM, DMARC) for deliverability',
		icon: 'lucide:globe',
		completed: progress.value?.setupDomain ?? false,
		href: '/dashboard/settings/domains',
		cta: 'Add Domain',
	},
]);

// Don't show if dismissed or all complete. In self-host mode the
// SelfHostOnboardingBanner owns the pre-send phase (configure a delivery
// provider / verify a domain), so defer to it until the instance can actually
// send — then take over for the remaining steps. Only one onboarding surface is
// ever visible at a time, and both share the same instance-scoped dismissal.
const shouldShow = computed(() =>
	shouldShowOnboardingChecklist({
		isLoading: isLoading.value,
		dismissed: progress.value?.dismissed ?? false,
		isComplete: progress.value?.isComplete ?? false,
		isSelfHost,
		sendPathReady: progress.value?.sendPathReady ?? false,
	})
);

// Progress percentage for visual indicator
const progressPercentage = computed(() => {
	if (!progress.value) return 0;
	return (progress.value.completedSteps / progress.value.totalSteps) * 100;
});
</script>

<template>
	<div v-if="shouldShow" class="card mb-8">
		<div>
			<!-- Header -->
			<div class="flex items-start justify-between mb-6">
				<div class="flex items-center gap-3">
					<UiIconBox icon="lucide:list-checks" variant="surface" />
					<div>
						<h2 class="text-lg font-semibold text-text-primary">Get your instance ready</h2>
						<p class="text-sm text-text-secondary mt-0.5">
							A few steps to go live — set up sending, then your marketing and transactional email
						</p>
					</div>
				</div>
				<button
					class="p-1.5 rounded-lg hover:bg-bg-surface text-text-tertiary hover:text-text-secondary transition-colors"
					title="Dismiss onboarding"
					@click="handleDismiss"
				>
					<Icon name="lucide:x" class="w-4 h-4" />
				</button>
			</div>

			<!-- Progress bar -->
			<div class="mb-6">
				<div class="flex items-center justify-between text-sm mb-2">
					<span class="text-text-secondary">Progress</span>
					<span class="text-text-primary font-medium">
						{{ progress?.completedSteps ?? 0 }} of {{ progress?.totalSteps ?? 6 }} completed
					</span>
				</div>
				<UiProgressBar size="sm" :value="progressPercentage" aria-label="Onboarding progress" />
			</div>

			<!-- Steps list -->
			<div class="space-y-3">
				<NuxtLink
					v-for="step in steps"
					:key="step.id"
					:to="step.href"
					class="flex items-center gap-4 p-4 rounded-xl border transition-all group"
					:class="[
						step.completed
							? 'bg-success/5 border-success/20 cursor-default'
							: 'bg-bg-surface/50 border-border-subtle hover:border-brand hover:bg-bg-surface',
					]"
				>
					<!-- Icon with completion state -->
					<div
						class="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition-colors"
						:class="[
							step.completed
								? 'bg-success text-text-inverse'
								: 'bg-bg-elevated text-text-secondary group-hover:bg-brand group-hover:text-text-inverse',
						]"
					>
						<Icon v-if="step.completed" name="lucide:check" class="w-5 h-5" />
						<Icon v-else :name="step.icon" class="w-5 h-5" />
					</div>

					<!-- Content -->
					<div class="flex-1 min-w-0">
						<p
							class="font-medium"
							:class="step.completed ? 'text-text-secondary line-through' : 'text-text-primary'"
						>
							{{ step.title }}
						</p>
						<p
							class="text-sm mt-0.5"
							:class="step.completed ? 'text-text-tertiary' : 'text-text-secondary'"
						>
							{{ step.description }}
						</p>
					</div>

					<!-- CTA or checkmark -->
					<div class="flex-shrink-0">
						<span v-if="step.completed" class="text-sm text-success font-medium"> Done </span>
						<span
							v-else
							class="flex items-center gap-1 text-sm text-brand opacity-0 group-hover:opacity-100 transition-opacity"
						>
							{{ step.cta }}
							<Icon name="lucide:chevron-right" class="w-4 h-4" />
						</span>
					</div>
				</NuxtLink>
			</div>

			<!-- Skip link -->
			<div class="mt-4 text-center">
				<button
					class="text-sm text-text-tertiary hover:text-text-secondary transition-colors"
					@click="handleDismiss"
				>
					I'll do this later
				</button>
			</div>
		</div>
	</div>
</template>
