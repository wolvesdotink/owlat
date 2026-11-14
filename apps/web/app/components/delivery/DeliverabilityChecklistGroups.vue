<script setup lang="ts">
import type {
	DeliverabilityChecklistGroup,
	DeliverabilityChecklistItem,
} from '~/utils/deliverabilityCenter';
import DeliverabilitySetupValues from './DeliverabilitySetupValues.vue';
import DeliverabilityGuidance from './DeliverabilityGuidance.vue';
import {
	checklistItemDomId,
	deliverabilityItemPresentation,
	formatVerificationAge,
	itemKey,
} from '~/utils/deliverabilityCenter';
import { useDeliverabilityChecklistCopy } from '~/composables/useDeliverabilityChecklistCopy';
import { useLocalized } from '~/composables/useLocalized';
import {
	ChevronDownIcon,
	CircleMinusIcon,
	GlobeIcon,
	ReloadIcon,
	ShieldWarningIcon,
	SparklesIcon,
	TrendingUpIcon,
} from '@coolicons/vue';

defineProps<{
	groups: DeliverabilityChecklistGroup[];
	verifyingItemKey?: string | null;
}>();

const emit = defineEmits<{
	verify: [item: DeliverabilityChecklistItem];
}>();

const { t } = useI18n();

/**
 * `formatVerificationAge` carries an i18n key plus the number it interpolates
 * (the registry convention for module-scope sentences); rendered unresolved it
 * paints the serialized object at the operator instead of "3 minutes ago".
 */
const localized = useLocalized();

/**
 * The check taxonomy and the group headings are shared-module/read-model data
 * whose English also leaves the browser (diagnostic dumps, mailed regression
 * alerts), so the German comes from a key derived from the check id and the
 * group's severity. See `~/composables/useDeliverabilityChecklistCopy`.
 */
const { itemTitle, itemImpact, groupLabel, groupDescription } = useDeliverabilityChecklistCopy();

const { copy, isCopied } = useCopyToClipboard();

const groupIcon = {
	blocking: ShieldWarningIcon,
	reputation: TrendingUpIcon,
	recommended: SparklesIcon,
	ipv6: GlobeIcon,
	not_applicable: CircleMinusIcon,
} as const;

/** A check that judges a send path this deployment does not use. */
function isNotApplicable(item: DeliverabilityChecklistItem): boolean {
	return item.notGraded === 'own_mta_unused' || item.notGraded === 'marketing_off';
}
</script>

<template>
	<div id="deliverability-checklist" class="space-y-5">
		<section
			v-for="group in groups"
			:key="group.key"
			:aria-labelledby="`${group.key}-heading`"
			:data-testid="`checklist-group-${group.key}`"
		>
			<div class="mb-2 flex items-start gap-3 px-1">
				<component :is="groupIcon[group.key]" class="mt-0.5 h-5 w-5 shrink-0 text-text-tertiary" />
				<div>
					<h2 :id="`${group.key}-heading`" class="font-semibold text-text-primary">
						{{ groupLabel(group) }}
					</h2>
					<p class="text-sm text-text-secondary">{{ groupDescription(group) }}</p>
				</div>
			</div>

			<div class="overflow-hidden rounded-xl border border-border-subtle bg-bg-elevated">
				<details
					v-for="item in group.items"
					:id="checklistItemDomId(item)"
					:key="itemKey(item.scope, item.id)"
					class="group border-b border-border-subtle last:border-b-0"
				>
					<summary
						class="flex cursor-pointer list-none items-center gap-3 px-4 py-4 hover:bg-bg-surface focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand sm:px-5"
					>
						<component
							:is="deliverabilityItemPresentation(item).icon"
							class="h-5 w-5 shrink-0"
							:class="[
								deliverabilityItemPresentation(item).className.split(' ').at(-1),
								{
									'animate-spin motion-reduce:animate-none':
										!item.notGraded && item.status === 'pending-dns',
								},
							]"
						/>
						<div class="min-w-0 flex-1">
							<p class="font-medium text-text-primary">{{ itemTitle(item) }}</p>
							<p class="mt-0.5 truncate text-xs text-text-tertiary">
								{{ item.protocol }}
								<span v-if="item.scope.kind === 'domain'"> · {{ item.scope.domain }}</span>
								<span v-else>
									·
									{{ t('components.delivery.deliverabilityChecklistGroups.thisServer') }}</span
								>
								<span v-if="item.lastCheckedAt">
									· {{ localized(formatVerificationAge(item.lastCheckedAt)) }}</span
								>
							</p>
						</div>
						<span
							class="inline-flex shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium"
							:class="deliverabilityItemPresentation(item).className"
						>
							{{ t(deliverabilityItemPresentation(item).label) }}
						</span>
						<ChevronDownIcon
							class="h-4 w-4 shrink-0 text-text-tertiary transition-transform group-open:rotate-180"
						/>
					</summary>

					<div class="space-y-4 border-t border-border-subtle bg-bg-deep/30 px-4 py-4 sm:px-5">
						<p class="text-sm leading-6 text-text-secondary">{{ itemImpact(item) }}</p>
						<p
							v-if="item.notGraded"
							class="text-sm text-text-secondary"
							:data-testid="`not-graded-${item.notGraded}`"
						>
							{{
								t(`components.delivery.deliverabilityChecklistGroups.notGraded.${item.notGraded}`)
							}}
						</p>
						<div
							v-if="
								!isNotApplicable(item) &&
								(item.failureReason || item.nextStep || item.observed.length)
							"
							class="rounded-lg border border-border-subtle bg-bg-surface p-3 text-sm"
						>
							<p v-if="item.failureReason" class="font-medium text-text-primary">
								{{ item.failureReason }}
							</p>
							<p v-if="item.nextStep" class="mt-1 text-text-secondary">{{ item.nextStep }}</p>
							<p
								v-if="item.observed.length"
								class="mt-2 break-words font-mono text-xs text-text-tertiary"
							>
								{{
									t('components.delivery.deliverabilityChecklistGroups.observed', {
										values: item.observed.join(' · '),
									})
								}}
							</p>
						</div>

						<DeliverabilitySetupValues
							v-if="!isNotApplicable(item) && item.setupValues?.length"
							:setup-values="item.setupValues"
							:scope-key="itemKey(item.scope, item.id)"
						/>
						<DeliverabilityGuidance
							v-if="!isNotApplicable(item) && item.status !== 'pass' && item.instructions"
							:instructions="item.instructions"
							:scope-key="itemKey(item.scope, item.id)"
						/>

						<div class="flex flex-col gap-3 sm:flex-row sm:items-center">
							<UiButton
								v-if="!isNotApplicable(item) && item.status !== 'pass'"
								size="sm"
								variant="secondary"
								:loading="verifyingItemKey === itemKey(item.scope, item.id)"
								:disabled="!!item.lockedReason || verifyingItemKey === itemKey(item.scope, item.id)"
								@click="emit('verify', item)"
							>
								<template #iconLeft>
									<ReloadIcon
										v-if="verifyingItemKey !== itemKey(item.scope, item.id)"
										class="h-3.5 w-3.5"
									/>
								</template>
								{{ t('components.delivery.deliverabilityChecklistGroups.verifyNow') }}
							</UiButton>
							<p
								v-if="item.lockedReason && !isNotApplicable(item)"
								class="text-xs text-text-secondary"
							>
								{{ item.lockedReason }}
							</p>
							<div class="flex flex-wrap gap-3 sm:ml-auto">
								<button
									type="button"
									class="text-xs text-text-secondary hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
									@click="copy(item.diagnosticReport, `${itemKey(item.scope, item.id)}:diagnostic`)"
								>
									{{
										isCopied(`${itemKey(item.scope, item.id)}:diagnostic`)
											? t('components.delivery.deliverabilityChecklistGroups.diagnosticCopied')
											: t('components.delivery.deliverabilityChecklistGroups.copyDiagnostic')
									}}
								</button>
								<a
									:href="item.docsHref"
									target="_blank"
									rel="noopener noreferrer"
									class="text-xs text-text-secondary hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
								>
									{{ t('components.delivery.deliverabilityChecklistGroups.howThisWorks') }}
								</a>
							</div>
						</div>
					</div>
				</details>
			</div>
		</section>
	</div>
</template>
