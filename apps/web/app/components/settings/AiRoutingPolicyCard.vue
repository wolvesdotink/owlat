<script setup lang="ts">
/**
 * The AI routing policy, below the decision provider
 * card: which new AI paths run, and how much of the spend ceiling triage and
 * shadow runs may use. Admin only, like the page; the server checks again and
 * writes the audit row.
 *
 * Every switch starts at off, which is how Owlat behaves without the policy,
 * and the option says so ("Off (default)"). Each one carries one line on what
 * changes when it is on. `shadow` runs the new path beside today's and only
 * records what it would have done, inside the shadow allowance this card also
 * sets, so the allowance is stated in dollars as the form stands.
 *
 * Its own save, apart from "Save AI provider": the policy is a separate,
 * versioned record. The page asks {@link save} when the unsaved-changes dialog
 * saves, and reads `dirty` for that guard.
 */
import { computed, watch } from 'vue';
import { useAiRoutingPolicy } from '~/composables/useAiRoutingPolicy';
import {
	ROUTING_POLICY_GROUPS,
	routingSwitchOptions,
	type RoutingPolicyField,
} from '~/utils/aiRoutingPolicy';
import { formatDateTime } from '~/utils/formatters';
import { useLocalized } from '~/composables/useLocalized';
import { SHADOW_FRACTION_MAXIMA } from '@owlat/shared/aiRouting';

const emit = defineEmits<{ dirty: [isDirty: boolean] }>();

const { t, locale } = useI18n();
const K = 'dashboard.admin.instance.aiProvider.routing';

const routing = useAiRoutingPolicy();
const { form, problems } = routing;

watch(routing.isDirty, (isDirty) => emit('dirty', isDirty), { immediate: true });
defineExpose({ save: routing.save });

/** D4's maxima as the percentages the two help lines name. */
const maxPercent = {
	message: SHADOW_FRACTION_MAXIMA.shadowMaxMessageFraction * 100,
	ceiling: SHADOW_FRACTION_MAXIMA.shadowMaxCeilingFraction * 100,
};

const formatUsd = (value: number) =>
	new Intl.NumberFormat(locale.value, { style: 'currency', currency: 'USD' }).format(value);

const switchOptions = (key: Parameters<typeof routingSwitchOptions>[0]) =>
	routingSwitchOptions(key).map((option) => ({ ...option, label: t(option.label) }));

const localized = useLocalized();
const problemText = (field: RoutingPolicyField) => {
	const problem = problems.value[field];
	return problem ? localized(problem) : undefined;
};

/** The allowance line: what shadow runs may spend, or why nothing. */
const allowanceLine = computed(() => {
	if (!routing.isShadowing.value) return t(`${K}.shadow.allowanceIdle`);
	if (problems.value.shadowCapUsd) return t(`${K}.shadow.allowanceBlocked`);
	return t(`${K}.shadow.allowance`, { amount: formatUsd(routing.shadowAllowance.value) });
});

const ceilingLine = computed(() =>
	routing.dailyCeilingUsd.value > 0
		? t(`${K}.ceiling`, { amount: formatUsd(routing.dailyCeilingUsd.value) })
		: t(`${K}.noCeiling`)
);

const versionLine = computed(() => {
	const policy = routing.stored.value;
	if (!policy || !routing.data.value?.isStored || policy.updatedAt === null) {
		return t(`${K}.defaultsInUse`);
	}
	return t(`${K}.savedVersion`, {
		version: policy.policyVersion,
		date: formatDateTime(policy.updatedAt),
	});
});

const canSave = computed(
	() => routing.isDirty.value && !routing.hasProblems.value && !routing.isSaving.value
);
</script>

<template>
	<UiCard data-testid="ai-routing-policy">
		<h2 class="text-lg font-medium text-text-primary mb-1">{{ t(`${K}.title`) }}</h2>
		<p class="text-sm text-text-secondary mb-4">{{ t(`${K}.description`) }}</p>

		<UiQueryBoundary
			:loading="routing.isLoading.value && !routing.data.value"
			:error="routing.error.value"
			@retry="routing.refetch"
		>
			<template #loading>
				<div class="space-y-3" role="status" aria-busy="true" :aria-label="t(`${K}.loading`)">
					<UiSkeleton v-for="row in 4" :key="row" class="h-10 rounded-lg" />
				</div>
			</template>

			<div class="space-y-6">
				<section
					v-for="group in ROUTING_POLICY_GROUPS"
					:key="group.key"
					:data-testid="`ai-routing-group-${group.key}`"
				>
					<h3 class="text-sm font-medium text-text-primary">
						{{ t(`${K}.groups.${group.key}`) }}
					</h3>
					<div class="mt-3 space-y-3">
						<div
							v-for="key in group.switches"
							:key="key"
							class="flex flex-col gap-3 rounded-lg border border-border-subtle p-3 sm:flex-row sm:items-start sm:justify-between"
						>
							<div class="min-w-0 text-sm">
								<p class="text-text-primary font-medium">{{ t(`${K}.switches.${key}.label`) }}</p>
								<p class="text-text-secondary mt-0.5">{{ t(`${K}.switches.${key}.help`) }}</p>
							</div>
							<UiSelect
								v-model="form.switches[key]"
								class="w-full shrink-0 sm:w-52"
								size="sm"
								:options="switchOptions(key)"
								:aria-label="t(`${K}.switches.${key}.label`)"
								:disabled="routing.isSaving.value"
								:data-testid="`ai-routing-switch-${key}`"
							/>
						</div>
						<UiInput
							v-if="group.key === 'files'"
							v-model="form.knowledgeEntryCap"
							size="sm"
							inputmode="numeric"
							:label="t(`${K}.knowledgeEntryCap.label`)"
							:placeholder="t(`${K}.noCapPlaceholder`)"
							:help-text="t(`${K}.knowledgeEntryCap.help`)"
							:error="problemText('knowledgeEntryCap')"
							:disabled="routing.isSaving.value"
						/>
						<UiInput
							v-if="group.key === 'decisions'"
							v-model="form.verifyClaimCap"
							size="sm"
							inputmode="numeric"
							:label="t(`${K}.verifyClaimCap.label`)"
							:placeholder="t(`${K}.noCapPlaceholder`)"
							:help-text="t(`${K}.verifyClaimCap.help`)"
							:error="problemText('verifyClaimCap')"
							:disabled="routing.isSaving.value"
						/>
						<div
							v-if="group.key === 'writing'"
							class="flex items-start justify-between gap-4 rounded-lg border border-border-subtle p-3"
						>
							<div class="text-sm">
								<p class="text-text-primary font-medium">{{ t(`${K}.promptCache.label`) }}</p>
								<p class="text-text-secondary mt-0.5">{{ t(`${K}.promptCache.help`) }}</p>
							</div>
							<UiSwitch
								v-model="form.isInterpretationCached"
								:label="t(`${K}.promptCache.label`)"
								:disabled="routing.isSaving.value"
							/>
						</div>
					</div>
				</section>

				<section data-testid="ai-routing-budget">
					<h3 class="text-sm font-medium text-text-primary">{{ t(`${K}.groups.budget`) }}</h3>
					<p class="mt-1 text-xs text-text-tertiary">{{ ceilingLine }}</p>
					<div class="mt-3 grid gap-4 sm:grid-cols-2">
						<UiInput
							v-model="form.triagePercent"
							size="sm"
							inputmode="decimal"
							:label="t(`${K}.triage.label`)"
							:help-text="t(`${K}.triage.help`)"
							:error="problemText('triagePercent')"
							:disabled="routing.isSaving.value"
						/>
					</div>
				</section>

				<section data-testid="ai-routing-shadow">
					<h3 class="text-sm font-medium text-text-primary">{{ t(`${K}.groups.shadow`) }}</h3>
					<p class="mt-1 text-xs text-text-tertiary">{{ t(`${K}.shadow.description`) }}</p>
					<div class="mt-3 grid gap-4 sm:grid-cols-3">
						<UiInput
							v-model="form.shadowMessagePercent"
							size="sm"
							inputmode="decimal"
							:label="t(`${K}.shadow.messageLabel`)"
							:help-text="t(`${K}.shadow.messageHelp`, { max: maxPercent.message })"
							:error="problemText('shadowMessagePercent')"
							:disabled="routing.isSaving.value"
						/>
						<UiInput
							v-model="form.shadowCeilingPercent"
							size="sm"
							inputmode="decimal"
							:label="t(`${K}.shadow.ceilingLabel`)"
							:help-text="t(`${K}.shadow.ceilingHelp`, { max: maxPercent.ceiling })"
							:error="problemText('shadowCeilingPercent')"
							:disabled="routing.isSaving.value"
						/>
						<UiInput
							v-model="form.shadowCapUsd"
							size="sm"
							inputmode="decimal"
							:label="t(`${K}.shadow.capLabel`)"
							:placeholder="t(`${K}.noCapPlaceholder`)"
							:help-text="t(`${K}.shadow.capHelp`)"
							:error="problemText('shadowCapUsd')"
							:disabled="routing.isSaving.value"
						/>
					</div>
					<p
						class="mt-3 text-sm"
						:class="problems.shadowCapUsd ? 'text-warning' : 'text-text-secondary'"
						role="status"
						data-testid="ai-routing-shadow-allowance"
					>
						{{ allowanceLine }}
					</p>
				</section>

				<p
					v-if="routing.isConflict.value"
					class="rounded-lg bg-warning-subtle/50 p-3 text-sm text-text-primary"
					role="alert"
					data-testid="ai-routing-conflict"
				>
					{{ t(`${K}.conflict`) }}
				</p>

				<div
					class="flex flex-col gap-3 border-t border-border-subtle pt-4 sm:flex-row sm:items-center sm:justify-between"
				>
					<p class="text-xs text-text-tertiary" data-testid="ai-routing-version">
						{{ versionLine }}
					</p>
					<div class="flex items-center gap-2">
						<UiButton
							v-if="routing.isDirty.value"
							type="button"
							variant="ghost"
							:disabled="routing.isSaving.value"
							@click="routing.discard"
						>
							{{ t(`${K}.discard`) }}
						</UiButton>
						<UiButton
							type="button"
							:loading="routing.isSaving.value"
							:disabled="!canSave"
							data-testid="ai-routing-save"
							@click="routing.save"
						>
							<template #iconLeft>
								<Icon v-if="!routing.isSaving.value" name="lucide:check" class="w-4 h-4" />
							</template>
							{{ t(`${K}.save`) }}
						</UiButton>
					</div>
				</div>
			</div>
		</UiQueryBoundary>
	</UiCard>
</template>
