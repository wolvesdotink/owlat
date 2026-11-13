<script setup lang="ts">
/**
 * Stage 2 of the mailbox move: publish the inbound MX record and check that it
 * has propagated. The parent owns the check itself (and its last verdict),
 * because archiving in stage 3 reads that verdict.
 */
import { CheckIcon, CircleCheckIcon, CopyIcon, GlobeIcon } from '@coolicons/vue';

const props = defineProps<{
	stage: string | null;
	domain: string;
	mxHost: string | null;
	mxPriority: number | undefined;
	mxCheck: { verified: boolean; checkedAt: number } | null;
	isChecking: boolean;
	formatTimestamp: (ts: number | null | undefined) => string;
}>();

const emit = defineEmits<{
	checkMx: [];
}>();

const { t } = useI18n();
const { copy, isCopied } = useCopyToClipboard();
const dnsDetailsOpen = ref(false);

// The exact MX record a DNS admin publishes to receive mail through Owlat.
const mxRecordLine = computed(() =>
	props.mxHost ? `${props.domain}.\t\tIN\tMX\t${props.mxPriority}\t${props.mxHost}.` : ''
);
</script>

<template>
	<div
		class="rounded-md border px-4 py-3"
		:class="
			stage === 'cutover_pending' ? 'border-brand/40 bg-brand-subtle' : 'border-border-subtle'
		"
	>
		<div class="flex items-center gap-2">
			<component
				:is="stage === 'archived' ? CircleCheckIcon : GlobeIcon"
				class="w-4 h-4 shrink-0"
				:class="stage === 'archived' ? 'text-success' : 'text-text-secondary'"
			/>
			<span class="font-medium text-sm">
				{{ t('components.postbox.postboxMailboxMove.stage2.title') }}
			</span>
		</div>

		<div v-if="stage === 'cutover_pending'" class="mt-2 pl-6 space-y-3">
			<p class="text-xs text-text-secondary">
				{{ t('components.postbox.postboxMailboxMove.stage2.body') }}
			</p>
			<UiDisclosure
				v-if="mxHost"
				v-model="dnsDetailsOpen"
				:label="t('components.postbox.postboxMailboxMove.stage2.advanced')"
			>
				<I18nT
					keypath="components.postbox.postboxMailboxMove.stage2.recordIntro"
					tag="p"
					scope="global"
					class="text-xs text-text-secondary"
				>
					<template #domain>
						<code>{{ domain }}</code>
					</template>
				</I18nT>
				<div class="flex items-center gap-2">
					<code class="flex-1 min-w-0 truncate rounded bg-bg-surface px-2 py-1.5 text-xs">{{
						mxRecordLine
					}}</code>
					<UiTooltip
						:text="t('components.postbox.postboxMailboxMove.stage2.copyRecord', { domain })"
					>
						<button
							type="button"
							class="p-1.5 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface shrink-0"
							:aria-label="t('components.postbox.postboxMailboxMove.stage2.copyRecord', { domain })"
							@click="copy(mxRecordLine, 'mx')"
						>
							<component :is="isCopied('mx') ? CheckIcon : CopyIcon" class="w-4 h-4" />
						</button>
					</UiTooltip>
				</div>
				<div class="flex items-center gap-2 flex-wrap">
					<UiButton size="sm" variant="secondary" :loading="isChecking" @click="emit('checkMx')">
						{{ t('components.postbox.postboxMailboxMove.stage2.checkPropagation') }}
					</UiButton>
					<span v-if="mxCheck?.verified" class="text-xs text-success flex items-center gap-1">
						<CircleCheckIcon class="w-3.5 h-3.5" />
						{{ t('components.postbox.postboxMailboxMove.stage2.pointsHere', { domain }) }}
					</span>
					<span v-else-if="mxCheck" class="text-xs text-text-tertiary">
						{{
							t('components.postbox.postboxMailboxMove.stage2.notPointing', {
								checked: formatTimestamp(mxCheck.checkedAt),
							})
						}}
					</span>
				</div>
				<p class="text-xs text-text-tertiary">
					{{ t('components.postbox.postboxMailboxMove.stage2.afterMx') }}
				</p>
			</UiDisclosure>
			<p v-else class="text-xs text-warning">
				{{ t('components.postbox.postboxMailboxMove.stage2.noInboundHost') }}
			</p>
		</div>
		<I18nT
			v-else-if="stage === 'archived'"
			keypath="components.postbox.postboxMailboxMove.stage2.delivered"
			tag="p"
			scope="global"
			class="mt-1 pl-6 text-xs text-text-tertiary"
		>
			<template #domain>
				<code>{{ domain }}</code>
			</template>
		</I18nT>
		<p v-else class="mt-1 pl-6 text-xs text-text-tertiary">
			{{ t('components.postbox.postboxMailboxMove.stage2.locked') }}
		</p>
	</div>
</template>
