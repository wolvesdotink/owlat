<script setup lang="ts">
/**
 * Why a record did not verify: the reason, and — when the lookup found SOMETHING
 * at the name — the value it found, so the operator can compare found against
 * expected instead of just seeing a red status. Split out of `DNSRecordPanel`.
 */
const props = defineProps<{
	verification?: { verified: boolean; error?: string; foundValue?: string };
	/** Prefix for the copied-state key, unique per record. */
	copyKey: string;
}>();

const { t } = useI18n();
const { copy, isCopied } = useCopyToClipboard();

/**
 * Show the found-vs-expected diagnostic only when we have a completed check
 * that did NOT verify and carries a reason. The happy path stays untouched.
 */
const diagnostic = computed(() => {
	const v = props.verification;
	if (!v || v.verified || !v.error) return null;
	return { error: v.error, foundValue: v.foundValue };
});

const handleCopyFound = () => {
	if (diagnostic.value?.foundValue) copy(diagnostic.value.foundValue, `${props.copyKey}-found`);
};
</script>

<template>
	<div
		v-if="diagnostic"
		class="mt-3 rounded-lg border border-error/30 bg-error/10 p-3"
		data-testid="dns-diagnostic"
	>
		<p class="flex items-start gap-2 text-xs font-medium text-error">
			<Icon name="lucide:alert-circle" class="mt-0.5 w-3.5 h-3.5 shrink-0" />
			<span data-testid="dns-diagnostic-error">{{ diagnostic.error }}</span>
		</p>
		<div v-if="diagnostic.foundValue" class="mt-2">
			<p class="text-xs text-text-tertiary mb-1">
				{{ t('components.domains.dnsRecordPanel.found') }}
			</p>
			<div class="flex items-center gap-2">
				<code
					class="flex-1 bg-bg-deep px-3 py-2 rounded-lg text-xs text-text-tertiary font-mono break-all line-clamp-2"
					:title="diagnostic.foundValue"
					data-testid="dns-diagnostic-found"
				>
					{{ diagnostic.foundValue }}
				</code>
				<UiButton
					variant="ghost"
					class="p-2"
					:title="t('components.domains.dnsRecordPanel.copyFoundValue')"
					@click="handleCopyFound"
				>
					<Icon
						v-if="isCopied(`${copyKey}-found`)"
						name="lucide:check"
						class="w-4 h-4 text-success"
					/>
					<Icon v-else name="lucide:copy" class="w-4 h-4" />
				</UiButton>
			</div>
		</div>
	</div>
</template>
