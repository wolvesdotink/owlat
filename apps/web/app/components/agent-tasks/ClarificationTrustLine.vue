<script setup lang="ts">
import { clarificationTrust, type ClarificationProvenance } from '~/utils/clarificationLocale';

/**
 * The one trust line under a card of clarification questions: they were
 * generated from an email (from which domain, when they all agree), and Owlat
 * never asks for a password. Worded in the reader's language from the
 * questions' stored `origin` (utils/clarificationLocale). Renders nothing when
 * no question says where it came from.
 */
const props = withDefaults(
	defineProps<{
		questions: readonly ClarificationProvenance[];
		testId?: string;
	}>(),
	{ testId: 'clarification-trust' }
);

const { t } = useI18n();

const line = computed(() => {
	const trust = clarificationTrust(props.questions);
	if (!trust) return null;
	return trust.domain
		? t('components.agentTasks.clarificationTrustLine.trust', { domain: trust.domain })
		: t('components.agentTasks.clarificationTrustLine.trustNoDomain');
});
</script>

<template>
	<p v-if="line" class="flex items-start gap-1.5 text-2xs text-text-tertiary" :data-testid="testId">
		<Icon name="lucide:shield-check" class="mt-px size-3 shrink-0" aria-hidden="true" />
		<span>{{ line }}</span>
	</p>
</template>
