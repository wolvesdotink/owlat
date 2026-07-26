<script setup lang="ts">
import type {
	DeliverabilityChecklistGroup,
	DeliverabilityChecklistItem,
} from '~/utils/deliverabilityCenter';
import DeliverabilitySetupValues from './DeliverabilitySetupValues.vue';
import DeliverabilityGuidance from './DeliverabilityGuidance.vue';
import {
	checklistItemDomId,
	DELIVERABILITY_STATUS_PRESENTATION,
	formatVerificationAge,
	itemKey,
} from '~/utils/deliverabilityCenter';

defineProps<{
	groups: DeliverabilityChecklistGroup[];
	verifyingItemKey?: string | null;
}>();

const emit = defineEmits<{
	verify: [item: DeliverabilityChecklistItem];
}>();

const { copy, isCopied } = useCopyToClipboard();

const groupIcon = {
	blocking: 'lucide:shield-alert',
	reputation: 'lucide:trending-up',
	recommended: 'lucide:sparkles',
} as const;
</script>

<template>
	<div id="deliverability-checklist" class="space-y-5">
		<section v-for="group in groups" :key="group.key" :aria-labelledby="`${group.key}-heading`">
			<div class="mb-2 flex items-start gap-3 px-1">
				<Icon :name="groupIcon[group.key]" class="mt-0.5 h-5 w-5 shrink-0 text-text-tertiary" />
				<div>
					<h2 :id="`${group.key}-heading`" class="font-semibold text-text-primary">
						{{ group.label }}
					</h2>
					<p class="text-sm text-text-secondary">{{ group.description }}</p>
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
						<Icon
							:name="DELIVERABILITY_STATUS_PRESENTATION[item.status].icon"
							class="h-5 w-5 shrink-0"
							:class="[
								DELIVERABILITY_STATUS_PRESENTATION[item.status].className.split(' ').at(-1),
								{ 'animate-spin': item.status === 'pending-dns' },
							]"
						/>
						<div class="min-w-0 flex-1">
							<p class="font-medium text-text-primary">{{ item.title }}</p>
							<p class="mt-0.5 truncate text-xs text-text-tertiary">
								{{ item.protocol }}
								<span v-if="item.scope.kind === 'domain'"> · {{ item.scope.domain }}</span>
								<span v-else> · This server</span>
								<span v-if="item.lastCheckedAt">
									· {{ formatVerificationAge(item.lastCheckedAt) }}</span
								>
							</p>
						</div>
						<span
							class="hidden rounded-full border px-2 py-0.5 text-xs font-medium sm:inline-flex"
							:class="DELIVERABILITY_STATUS_PRESENTATION[item.status].className"
						>
							{{ DELIVERABILITY_STATUS_PRESENTATION[item.status].label }}
						</span>
						<Icon
							name="lucide:chevron-down"
							class="h-4 w-4 shrink-0 text-text-tertiary transition-transform group-open:rotate-180"
						/>
					</summary>

					<div class="space-y-4 border-t border-border-subtle bg-bg-deep/30 px-4 py-4 sm:px-5">
						<p class="text-sm leading-6 text-text-secondary">{{ item.impact }}</p>
						<div
							v-if="item.failureReason || item.nextStep || item.observed.length"
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
								Observed: {{ item.observed.join(' · ') }}
							</p>
						</div>

						<DeliverabilitySetupValues
							v-if="item.setupValues?.length"
							:setup-values="item.setupValues"
							:scope-key="itemKey(item.scope, item.id)"
						/>
						<DeliverabilityGuidance
							v-if="item.status !== 'pass' && item.instructions"
							:instructions="item.instructions"
							:scope-key="itemKey(item.scope, item.id)"
						/>

						<div class="flex flex-col gap-3 sm:flex-row sm:items-center">
							<UiButton
								v-if="item.status !== 'pass'"
								size="sm"
								variant="secondary"
								:loading="verifyingItemKey === itemKey(item.scope, item.id)"
								:disabled="!!item.lockedReason || verifyingItemKey === itemKey(item.scope, item.id)"
								@click="emit('verify', item)"
							>
								<template #iconLeft>
									<Icon
										v-if="verifyingItemKey !== itemKey(item.scope, item.id)"
										name="lucide:refresh-cw"
										class="h-3.5 w-3.5"
									/>
								</template>
								Verify now
							</UiButton>
							<p v-if="item.lockedReason" class="text-xs text-text-secondary">
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
											? 'Diagnostic copied'
											: 'Copy diagnostic'
									}}
								</button>
								<a
									:href="item.docsHref"
									target="_blank"
									rel="noopener noreferrer"
									class="text-xs text-brand hover:underline"
								>
									How this works
								</a>
							</div>
						</div>
					</div>
				</details>
			</div>
		</section>
	</div>
</template>
