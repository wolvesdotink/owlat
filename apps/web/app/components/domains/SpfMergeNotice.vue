<script setup lang="ts">
/**
 * The domain already publishes an SPF record for another sender. Publishing a
 * second `v=spf1` record is a PermError (RFC 7208 §3.2) that breaks SPF for
 * everyone, so this offers the single merged record instead. Split out of
 * `DNSRecordPanel`.
 */
import type { SpfCoexistenceSuggestion } from '~/utils/spfCoexistence';

const props = defineProps<{
	coexistence: SpfCoexistenceSuggestion;
	/** Prefix for the copied-state key, unique per record. */
	copyKey: string;
}>();

const { t } = useI18n();
const { copy, isCopied } = useCopyToClipboard();

const handleCopyMerged = () => copy(props.coexistence.merged, `${props.copyKey}-merged`);
</script>

<template>
	<div class="mt-3 rounded-lg border border-warning/30 bg-warning/10 p-3">
		<p class="flex items-start gap-2 text-xs font-medium text-warning">
			<Icon name="lucide:alert-triangle" class="mt-0.5 w-3.5 h-3.5 shrink-0" />
			<I18nT
				keypath="components.domains.dnsRecordPanel.coexistenceWarning"
				tag="span"
				scope="global"
			>
				<template #record>
					<code class="font-mono">v=spf1</code>
				</template>
			</I18nT>
		</p>
		<div class="mt-2">
			<p class="text-xs text-text-tertiary mb-1">
				{{ t('components.domains.dnsRecordPanel.existingRecord') }}
			</p>
			<code
				class="block bg-bg-deep px-3 py-2 rounded-lg text-xs text-text-tertiary font-mono break-all"
			>
				{{ coexistence.existing }}
			</code>
		</div>
		<div class="mt-2">
			<p class="text-xs text-text-tertiary mb-1">
				{{ t('components.domains.dnsRecordPanel.mergedRecord') }}
			</p>
			<div class="flex items-center gap-2">
				<code
					class="flex-1 bg-bg-deep px-3 py-2 rounded-lg text-sm text-text-secondary font-mono break-all"
				>
					{{ coexistence.merged }}
				</code>
				<UiButton
					variant="ghost"
					class="p-2"
					:title="t('components.domains.dnsRecordPanel.copyMergedValue')"
					@click="handleCopyMerged"
				>
					<Icon
						v-if="isCopied(`${copyKey}-merged`)"
						name="lucide:check"
						class="w-4 h-4 text-success"
					/>
					<Icon v-else name="lucide:copy" class="w-4 h-4" />
				</UiButton>
			</div>
		</div>
	</div>
</template>
