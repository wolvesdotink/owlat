<script setup lang="ts">
/**
 * The result of "Test on recent mail" (read on arrival, SPEC §6.2): how many
 * of the newest Inbox mails the rule matches, and for each match where the
 * answer came from (the rule's own conditions or the AI question). A mail the
 * AI question could not be asked about says "not tested" instead of
 * pretending to know.
 */

import type { RuleDryRunResult } from '~/composables/postbox/usePostboxRules';
import { formatCompactRelativeTime } from '~/utils/formatters';

const props = defineProps<{ result: RuleDryRunResult }>();
defineEmits<{ (e: 'close'): void }>();

const { t } = useI18n();

type Source = RuleDryRunResult['rows'][number]['source'];

const SOURCE_KEYS: Record<Source, string> = {
	no_match: 'postbox.rules.dryRun.source.noMatch',
	rule: 'postbox.rules.dryRun.source.rule',
	ai_yes: 'postbox.rules.dryRun.source.aiYes',
	ai_no: 'postbox.rules.dryRun.source.aiNo',
	ai_unknown: 'postbox.rules.dryRun.source.aiUnknown',
	not_tested: 'postbox.rules.dryRun.source.notTested',
};

/** Matches first, then what the AI turned down or could not judge; plain misses stay out. */
const shown = computed(() =>
	props.result.rows.filter((row) => row.source !== 'no_match').slice(0, 20)
);
</script>

<template>
	<section class="rounded-lg border border-border-subtle bg-bg-elevated p-4" aria-live="polite">
		<header class="mb-2 flex items-center justify-between gap-3 text-sm">
			<span class="font-medium">
				{{ t('postbox.rules.dryRun.title', { count: result.scanned }) }}
			</span>
			<span class="text-text-secondary">
				{{
					t('postbox.rules.dryRun.summary', { matches: result.matchCount, count: result.scanned })
				}}
			</span>
		</header>
		<p v-if="result.isAiUnavailable" class="mb-2 text-xs text-text-secondary">
			{{ t('postbox.rules.dryRun.aiUnavailable') }}
		</p>
		<p v-if="shown.length === 0" class="text-sm text-text-secondary">
			{{ t('postbox.rules.dryRun.empty') }}
		</p>
		<ul v-else class="space-y-1.5 text-sm">
			<li v-for="row in shown" :key="row.messageId" class="flex items-baseline gap-3">
				<span class="w-14 shrink-0 text-xs text-text-tertiary">
					{{ formatCompactRelativeTime(row.receivedAt) }}
				</span>
				<span class="min-w-0 flex-1 truncate">
					<b class="font-medium">{{ row.fromName || row.fromAddress }}</b>
					{{ row.subject }}
				</span>
				<span class="shrink-0 text-xs" :class="row.isMatch ? 'text-brand' : 'text-text-tertiary'">
					{{ t(SOURCE_KEYS[row.source]) }}
				</span>
			</li>
		</ul>
		<div class="mt-3 flex justify-end">
			<UiButton variant="ghost" size="sm" type="button" @click="$emit('close')">
				{{ t('common.close') }}
			</UiButton>
		</div>
	</section>
</template>
