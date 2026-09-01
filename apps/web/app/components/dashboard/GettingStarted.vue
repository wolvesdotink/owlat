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

const { t } = useI18n();

/**
 * A copy field owned by the shared getting-started model: either a bare message
 * key or a key plus the values it interpolates.
 */
type LocalizedField = string | { key: string; params?: Record<string, unknown> };
const localize = (value: LocalizedField): string =>
	typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});

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

// Member-safe "can this instance send at all?" — the same signal as the admin
// `sendPathReady` flag, readable by every member. Without it the personal send
// steps would sit open forever with no explanation while the instance has no
// outbound transport; with it they render as blocked and unblock themselves the
// moment sending works (the same edge that notifies the waiting member — see
// `auth/sendReadyNotices.ts`).
const { data: sendReadyState } = useOrganizationQuery(api.auth.sendReadyNotices.getState);
// UNRESOLVED IS "NOT BLOCKED", NOT "NOT READY". An unanswered `getState` is
// UNKNOWN, and rendering it as "cannot send" would flash the personal send steps
// as blocked (a non-clickable waiting row) on an instance that can in fact send.
// The gate is HERE rather than in the card's own loading flag: this query is
// org-scoped, so it stays skipped for as long as there is no active organization
// to answer it — and a card-level gate would then hide the whole checklist
// indefinitely rather than for a paint. The steps settle into their blocked
// state the moment the query says the instance cannot send.
const sendPathReady = computed(() => sendReadyState.value?.isReady ?? true);

// How much can actually go out today under the IP warm-up cap. Admins only —
// only they see the "Send a campaign" go-live step this qualifies, and there is
// no reason to subscribe every member to a projection they will not be shown.
// No From address exists at this point, so the backend answers conservatively;
// an uncapped or unmeasurable deployment answers `null` and the step keeps its
// plain description.
const { data: sendingReadiness } = useOrganizationQuery(
	api.campaigns.sendingReadiness.getSendingReadiness,
	() => (isInstanceViewer.value ? {} : undefined)
);
const sendCapacityToday = computed(() =>
	sendingReadiness.value?.capped === true ? sendingReadiness.value.today : null
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

// Every gate the card's CONTENTS depend on. Each of these decides whether a step
// exists or is ticked, so the card stays hidden until they answer; the
// send-readiness read is deliberately not among them (see `sendPathReady`).
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
		sendPathReady: sendPathReady.value,
		sendCapacityToday: sendCapacityToday.value,
	})
);

// Deep link from the "you can send now" notice: `/dashboard?step=firstSendDone`
// names the step the member was blocked on, so the card scrolls to it and
// highlights it instead of dropping them at the top of a long checklist.
const route = useRoute();
const focusedStepId = computed(() =>
	typeof route.query['step'] === 'string' ? route.query['step'] : null
);

function stepDomId(stepId: string): string {
	return `getting-started-step-${stepId}`;
}

// The card only renders once its queries resolve — usually after this mounts —
// so scroll when it becomes visible rather than on mount.
watch(
	[() => model.value.visible, focusedStepId],
	async ([visible, stepId]) => {
		if (!import.meta.client || !visible || !stepId) return;
		await nextTick();
		document.getElementById(stepDomId(stepId))?.scrollIntoView({ block: 'center' });
	},
	{ immediate: true }
);

const progressPercentage = computed(() => {
	if (model.value.totalCount === 0) return 0;
	return (model.value.completedCount / model.value.totalCount) * 100;
});

// One dismiss action covering whatever the card is currently showing.
const { run: dismissInstance } = useBackendOperation(api.auth.onboarding.dismiss, {
	label: () => t('components.dashboard.gettingStarted.dismissInstanceOperation'),
});
const { run: dismissUser } = useBackendOperation(api.auth.userOnboarding.dismiss, {
	label: () => t('components.dashboard.gettingStarted.dismissUserOperation'),
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
		<section v-if="model.visible" class="card mb-8" role="region" :aria-label="t('components.dashboard.gettingStarted.title')">
			<!-- Header -->
			<div class="mb-6 flex items-start justify-between">
				<div class="flex items-center gap-3">
					<UiIconBox icon="lucide:list-checks" variant="surface" />
					<div>
						<h2 class="text-lg font-semibold text-text-primary">{{ t('components.dashboard.gettingStarted.title') }}</h2>
						<p class="mt-0.5 text-sm text-text-secondary">
							{{ t('components.dashboard.gettingStarted.subtitle') }}
						</p>
					</div>
				</div>
				<button
					class="rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-bg-surface hover:text-text-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
					:title="t('common.dismiss')"
					:aria-label="t('components.dashboard.gettingStarted.dismissLabel')"
					@click="handleDismiss"
				>
					<Icon name="lucide:x" class="h-4 w-4" />
				</button>
			</div>

			<!-- Progress -->
			<div class="mb-6">
				<div class="mb-2 flex items-center justify-between text-sm">
					<span class="text-text-secondary">{{ t('components.dashboard.gettingStarted.progress') }}</span>
					<span class="font-medium text-text-primary">
						{{
							t('components.dashboard.gettingStarted.progressCount', {
								completed: model.completedCount,
								total: model.totalCount,
							})
						}}
					</span>
				</div>
				<UiProgressBar
					size="sm"
					:value="progressPercentage"
					:aria-label="t('components.dashboard.gettingStarted.progressLabel')"
				/>
			</div>

			<!-- Sections -->
			<div class="space-y-6">
				<div v-for="section in model.sections" :key="section.id">
					<!-- Section heading (only when both sections are present) -->
					<div v-if="model.sections.length > 1" class="mb-3">
						<h3 class="text-sm font-semibold text-text-primary">
							{{ localize(section.title) }}
						</h3>
						<p class="mt-0.5 text-sm text-text-secondary">
							{{ localize(section.description) }}
						</p>
					</div>

					<div class="space-y-3">
						<!-- A blocked step is NOT a link: there is nothing for the member to do
						     there yet, so it renders as a plain waiting row instead of a CTA
						     into a dead end. -->
						<component
							:is="step.blocked ? 'div' : (resolveComponent('NuxtLink') as 'div')"
							v-for="step in section.steps"
							:id="stepDomId(step.id)"
							:key="step.id"
							:to="step.blocked ? undefined : step.href"
							class="group flex items-center gap-4 rounded-xl border p-4 transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
							:class="[
								step.completed
									? 'border-success/20 bg-success/5'
									: step.blocked
										? 'border-border-subtle bg-bg-surface/30'
										: 'border-border-subtle bg-bg-surface/50 hover:border-brand hover:bg-bg-surface',
								focusedStepId === step.id ? 'ring-2 ring-brand ring-offset-2 ring-offset-bg-base' : '',
							]"
						>
							<div
								class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full transition-colors"
								:class="[
									step.completed
										? 'bg-success text-text-inverse'
										: step.blocked
											? 'bg-bg-elevated text-text-tertiary'
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
									{{ localize(step.title) }}
								</p>
								<p
									class="mt-0.5 text-sm"
									:class="step.completed ? 'text-text-tertiary' : 'text-text-secondary'"
								>
									{{ localize(step.description) }}
								</p>
							</div>

							<!--
								Each trailing affordance is its own flex item rather than living in a
								shared wrapper: an always-rendered wrapper would still be a flex item
								(so still eat a `gap-4` and its own width) on the narrow viewports
								where the hover-only CTA is not rendered at all. Below `sm` a normal
								step therefore has exactly two items — icon and text — and the copy
								gets the full row width instead of a ~40% column. The CTA is
								hover/focus-only, which never fires on touch, so hiding it there
								costs nothing: the whole row is the link.
							-->
							<span v-if="step.completed" class="flex-shrink-0 text-sm font-medium text-success">{{
								t('common.done')
							}}</span>
							<span
								v-else-if="step.blocked"
								class="flex min-w-0 items-center gap-1.5 text-sm text-text-tertiary"
							>
								<Icon name="lucide:clock" class="h-4 w-4 flex-shrink-0" />
								{{ step.blockedReason ? localize(step.blockedReason) : '' }}
							</span>
							<span
								v-else
								class="hidden flex-shrink-0 items-center gap-1 text-sm text-brand opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 sm:flex"
							>
								{{ localize(step.cta) }}
								<Icon name="lucide:chevron-right" class="h-4 w-4" />
							</span>
						</component>
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
					{{ t('components.dashboard.gettingStarted.later') }}
				</button>
			</div>
		</section>
	</Transition>
</template>
