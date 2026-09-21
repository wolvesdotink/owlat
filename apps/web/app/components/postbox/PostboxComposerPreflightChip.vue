<script setup lang="ts">
/**
 * The quiet footer chip for the deterministic pre-send checks (plan idea 6).
 *
 * Advisory by design: it states what it found and gets out of the way — no
 * modal, no disabled Send, no colour louder than the footer around it. The
 * findings are computed in `utils/postboxPreflight` and arrive as catalog keys,
 * which this render boundary resolves.
 */
import type { PreflightFinding } from '~/utils/postboxPreflight';

const props = defineProps<{ findings: PreflightFinding[] }>();

const { t } = useI18n();

const details = computed(() =>
	props.findings.map((finding) => t(finding.key, finding.params ?? {})).join(' · ')
);

const summary = computed(() =>
	t(
		'components.postbox.postboxComposerPreflightChip.summary',
		{ count: props.findings.length, details: details.value },
		props.findings.length
	)
);
</script>

<template>
	<span
		v-if="findings.length > 0"
		class="inline-flex items-center gap-1.5 min-w-0 text-xs text-text-tertiary"
		data-testid="postbox-preflight-chip"
	>
		<Icon name="lucide:list-checks" class="w-3.5 h-3.5 shrink-0 text-warning" />
		<span class="truncate max-w-[18rem]" :title="summary">{{ summary }}</span>
	</span>
</template>
