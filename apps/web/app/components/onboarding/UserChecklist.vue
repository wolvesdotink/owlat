<script setup lang="ts">
import { api } from '@owlat/api';
import {
	isChecklistComplete,
	shouldShowUserChecklist,
	visibleChecklistSteps,
	type ChecklistStepId,
	type OnboardingMode,
} from '~/utils/welcomeFlow';

/**
 * Persistent, resumable per-user onboarding checklist (piece c1).
 *
 * Renders the caller's own `userOnboarding` state (b3) as a list of steps that
 * ADAPT to the instance mode: import + "AI learns your history" + the
 * post-import sending switch appear only in migration mode. Every step links to
 * where it is resumed, so closing the tab mid-flow costs nothing — the member
 * picks up from the checklist, never from zero. The card is dismissible and
 * disappears for good once every visible step is complete.
 */

const props = defineProps<{
	/** The member whose checklist this is — always the signed-in user. */
	userId: string;
}>();

const { data: onboarding, isLoading: isLoadingOnboarding } = useConvexQuery(
	api.auth.userOnboarding.get,
	() => ({ userId: props.userId })
);
const { data: settings, isLoading: isLoadingSettings } = useConvexQuery(
	api.workspaces.settings.get,
	{}
);

const mode = computed<OnboardingMode>(() =>
	settings.value?.isMigrationMode ? 'migration' : 'fresh'
);

const steps = computed(() =>
	visibleChecklistSteps(mode.value).map((step) => ({
		...step,
		completed: (onboarding.value?.[step.id] ?? null) !== null,
	}))
);

const completedIds = computed<ReadonlySet<ChecklistStepId>>(
	() => new Set(steps.value.filter((s) => s.completed).map((s) => s.id))
);

const completedCount = computed(() => steps.value.filter((s) => s.completed).length);

const isComplete = computed(() => isChecklistComplete(mode.value, completedIds.value));

const isLoading = computed(() => isLoadingOnboarding.value || isLoadingSettings.value);

const shouldShow = computed(() =>
	shouldShowUserChecklist({
		isLoading: isLoading.value,
		dismissed: (onboarding.value?.dismissedAt ?? null) !== null,
		isComplete: isComplete.value,
	})
);

const progressPercentage = computed(() => {
	const total = steps.value.length;
	if (total === 0) return 0;
	return (completedCount.value / total) * 100;
});

const { run: dismiss } = useBackendOperation(api.auth.userOnboarding.dismiss, {
	label: 'Dismiss checklist',
});

async function handleDismiss() {
	await dismiss({ userId: props.userId });
}
</script>

<template>
	<div v-if="shouldShow" class="card">
		<!-- Header -->
		<div class="mb-6 flex items-start justify-between">
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:list-checks" variant="surface" />
				<div>
					<h2 class="text-lg font-medium text-text-primary">Finish setting up</h2>
					<p class="mt-0.5 text-sm text-text-secondary">
						Pick up wherever you left off — nothing here is one-shot.
					</p>
				</div>
			</div>
			<button
				class="rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-bg-surface hover:text-text-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
				title="Dismiss checklist"
				aria-label="Dismiss checklist"
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
					{{ completedCount }} of {{ steps.length }} done
				</span>
			</div>
			<UiProgressBar size="sm" :value="progressPercentage" aria-label="Onboarding progress" />
		</div>

		<!-- Steps -->
		<div class="space-y-3">
			<NuxtLink
				v-for="step in steps"
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

		<!-- Skip -->
		<div class="mt-4 text-center">
			<button
				class="text-sm text-text-tertiary transition-colors hover:text-text-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
				@click="handleDismiss"
			>
				Don't show this again
			</button>
		</div>
	</div>
</template>
