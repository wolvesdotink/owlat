<script setup lang="ts">
import { api } from '@owlat/api';
import { buildGettingStarted, type InstanceFlagId } from '~/utils/gettingStarted';
import {
	AI_CONNECTED_STEP_ID,
	isAiConnected,
	visibleChecklistSteps,
	type ChecklistStepId,
	type OnboardingMode,
} from '~/utils/welcomeFlow';

/**
 * The single, adaptive "Getting started" surface. It REPLACES the three
 * previously-stacked onboarding affordances (self-host banner + instance go-live
 * checklist + per-user checklist), each of which had its own visibility gate and
 * dismissal scope. One card, one dismiss, contents that adapt to the viewer
 * (admin vs member) and the instance mode (fresh vs migration).
 *
 * The honest completion logic is unchanged and still derived server-side; this
 * component only unifies the presentation and the dismissal model. See
 * `~/utils/gettingStarted` for the pure selection logic.
 */

const props = withDefaults(
	defineProps<{
		/** The signed-in member whose personal checklist this is. */
		userId: string;
		/** Whether this viewer can drive instance-wide setup (owner/admin). */
		isAdmin?: boolean;
		/**
		 * Force the personal-only view (no instance go-live section) regardless of
		 * role. Used by the Postbox empty state, where only the member's own mailbox
		 * journey belongs.
		 */
		personalOnly?: boolean;
	}>(),
	{ isAdmin: false, personalOnly: false }
);

const config = useRuntimeConfig();
const isSelfHost = config.public.deploymentMode === 'selfhost';

// Whether this render should include the instance go-live section.
const isInstanceViewer = computed(() => !props.personalOnly && props.isAdmin);

// Instance go-live progress (admins only) — the honest derive-from-real-state
// record. Members never subscribe: instance setup is not theirs to do.
const { data: instanceProgress, isLoading: isLoadingInstance } = useOrganizationQuery(
	api.auth.onboarding.getWithActualProgress,
	() => (isInstanceViewer.value ? { userId: props.userId } : undefined)
);

// Per-user checklist state.
const { data: onboarding, isLoading: isLoadingOnboarding } = useConvexQuery(
	api.auth.userOnboarding.get,
	() => ({ userId: props.userId })
);
const { data: settings, isLoading: isLoadingSettings } = useConvexQuery(
	api.workspaces.settings.get,
	{}
);

// AI is configured for the instance exactly when the `ai` flag is absent from
// the per-flag config-gap map (env `LLM_*` OR a stored key). The loading guard
// lives in the pure helper so the step never flashes complete on first paint.
const { data: flagsConfigStatus, isLoading: isLoadingAiConfig } = useConvexQuery(
	api.workspaces.featureFlags.getFlagsConfigStatus,
	{}
);

// Backups pointer (platform-admin only, self-host): a fresh install with no
// backup plan is a real gap, so it becomes one of the admin's go-live steps
// until a daily schedule is recorded. getBackupState is platform-admin gated on
// the server, so only subscribe once we know this viewer is a platform admin.
const { data: isPlatformAdmin } = useConvexQuery(
	api.platformAdmin.platformAdmin.isPlatformAdmin,
	() => (isInstanceViewer.value && isSelfHost ? {} : 'skip')
);
const { data: backupState } = useConvexQuery(api.backups.getBackupState, () =>
	isPlatformAdmin.value === true ? {} : 'skip'
);
const showBackupsStep = computed(
	() =>
		isSelfHost && isPlatformAdmin.value === true && backupState.value?.isScheduleEnabled !== true
);

const mode = computed<OnboardingMode>(() =>
	settings.value?.isMigrationMode ? 'migration' : 'fresh'
);

const aiConfigured = computed(() => isAiConnected(flagsConfigStatus.value));

// The resolved set of completed personal step ids. `aiConnected` is org-scoped
// (derived from AI config); every other step is a per-user stamp.
const personalCompleted = computed<ReadonlySet<ChecklistStepId>>(() => {
	const done = new Set<ChecklistStepId>();
	for (const step of visibleChecklistSteps(mode.value)) {
		const complete =
			step.id === AI_CONNECTED_STEP_ID
				? aiConfigured.value
				: (onboarding.value?.[step.id] ?? null) !== null;
		if (complete) done.add(step.id);
	}
	return done;
});

const instanceFlags = computed<Record<InstanceFlagId, boolean>>(() => ({
	sendPathReady: instanceProgress.value?.sendPathReady ?? false,
	addedContacts: instanceProgress.value?.addedContacts ?? false,
	createdEmail: instanceProgress.value?.createdEmail ?? false,
	sentCampaign: instanceProgress.value?.sentCampaign ?? false,
	createdApiKey: instanceProgress.value?.createdApiKey ?? false,
	setupDomain: instanceProgress.value?.setupDomain ?? false,
}));

const isLoading = computed(
	() =>
		isLoadingOnboarding.value ||
		isLoadingSettings.value ||
		isLoadingAiConfig.value ||
		(isInstanceViewer.value && isLoadingInstance.value)
);

const model = computed(() =>
	buildGettingStarted({
		role: isInstanceViewer.value ? 'admin' : 'member',
		isSelfHost,
		mode: mode.value,
		isLoading: isLoading.value,
		instanceDismissed: instanceProgress.value?.dismissed ?? false,
		instanceComplete: instanceProgress.value?.isComplete ?? false,
		instanceFlags: instanceFlags.value,
		showBackupsStep: showBackupsStep.value,
		userDismissed: (onboarding.value?.dismissedAt ?? null) !== null,
		personalCompleted: personalCompleted.value,
	})
);

const progressPercentage = computed(() => {
	if (model.value.totalCount === 0) return 0;
	return (model.value.completedCount / model.value.totalCount) * 100;
});

// One dismiss action covering whatever the card is currently showing.
const { run: dismissInstance } = useBackendOperation(api.auth.onboarding.dismiss, {
	label: 'Dismiss onboarding',
});
const { run: dismissUser } = useBackendOperation(api.auth.userOnboarding.dismiss, {
	label: 'Dismiss checklist',
});

async function handleDismiss() {
	const scope = model.value.dismissalScope;
	const jobs: Promise<unknown>[] = [];
	if (scope === 'instance' || scope === 'both')
		jobs.push(dismissInstance({ userId: props.userId }));
	if (scope === 'user' || scope === 'both') jobs.push(dismissUser({ userId: props.userId }));
	await Promise.all(jobs);
}
</script>

<template>
	<Transition
		enter-active-class="transition-all duration-(--motion-moderate) ease-spring"
		enter-from-class="opacity-0 -translate-y-2"
		enter-to-class="opacity-100 translate-y-0"
		leave-active-class="transition-all duration-(--motion-moderate-exit) ease-exit"
		leave-from-class="opacity-100 translate-y-0"
		leave-to-class="opacity-0 -translate-y-2"
	>
		<section v-if="model.visible" class="card mb-8" role="region" aria-label="Getting started">
			<!-- Header -->
			<div class="mb-6 flex items-start justify-between">
				<div class="flex items-center gap-3">
					<UiIconBox icon="lucide:list-checks" variant="surface" />
					<div>
						<h2 class="text-lg font-semibold text-text-primary">Getting started</h2>
						<p class="mt-0.5 text-sm text-text-secondary">
							Everything left to do to get Owlat working for you — in one place.
						</p>
					</div>
				</div>
				<button
					class="rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-bg-surface hover:text-text-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
					title="Dismiss"
					aria-label="Dismiss getting started"
					@click="handleDismiss"
				>
					<Icon name="lucide:x" class="h-4 w-4" />
				</button>
			</div>

			<!-- Progress -->
			<div class="mb-6">
				<div class="mb-2 flex items-center justify-between text-sm">
					<span class="text-text-secondary">Progress</span>
					<span class="font-medium text-text-primary">
						{{ model.completedCount }} of {{ model.totalCount }} done
					</span>
				</div>
				<UiProgressBar
					size="sm"
					:value="progressPercentage"
					aria-label="Getting started progress"
				/>
			</div>

			<!-- Sections -->
			<div class="space-y-6">
				<div v-for="section in model.sections" :key="section.id">
					<!-- Section heading (only when both sections are present) -->
					<div v-if="model.sections.length > 1" class="mb-3">
						<h3 class="text-sm font-semibold text-text-primary">{{ section.title }}</h3>
						<p class="mt-0.5 text-sm text-text-secondary">{{ section.description }}</p>
					</div>

					<div class="space-y-3">
						<NuxtLink
							v-for="step in section.steps"
							:key="step.id"
							:to="step.href"
							class="group flex items-center gap-4 rounded-xl border p-4 transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
							:class="[
								step.completed
									? 'border-success/20 bg-success/5'
									: 'border-border-subtle bg-bg-surface/50 hover:border-brand hover:bg-bg-surface',
							]"
						>
							<div
								class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full transition-colors"
								:class="[
									step.completed
										? 'bg-success text-text-inverse'
										: 'bg-bg-elevated text-text-secondary group-hover:bg-brand group-hover:text-text-inverse',
								]"
							>
								<Icon v-if="step.completed" name="lucide:check" class="h-5 w-5" />
								<Icon v-else :name="step.icon" class="h-5 w-5" />
							</div>

							<div class="min-w-0 flex-1">
								<p
									class="font-medium"
									:class="step.completed ? 'text-text-secondary line-through' : 'text-text-primary'"
								>
									{{ step.title }}
								</p>
								<p
									class="mt-0.5 text-sm"
									:class="step.completed ? 'text-text-tertiary' : 'text-text-secondary'"
								>
									{{ step.description }}
								</p>
							</div>

							<div class="flex-shrink-0">
								<span v-if="step.completed" class="text-sm font-medium text-success">Done</span>
								<span
									v-else
									class="flex items-center gap-1 text-sm text-brand opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
								>
									{{ step.cta }}
									<Icon name="lucide:chevron-right" class="h-4 w-4" />
								</span>
							</div>
						</NuxtLink>
					</div>

					<!-- Self-host resource links live under the instance steps. -->
					<DashboardGettingStartedResources
						v-if="section.id === 'instance' && model.showSelfHostResources"
					/>
				</div>
			</div>

			<!-- Skip -->
			<div class="mt-4 text-center">
				<button
					class="text-sm text-text-tertiary transition-colors hover:text-text-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
					@click="handleDismiss"
				>
					I'll do this later
				</button>
			</div>
		</section>
	</Transition>
</template>
