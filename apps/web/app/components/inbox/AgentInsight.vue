<script setup lang="ts">
/**
 * "Why did the agent do this?" — the agent's working for one inbound message,
 * behind a disclosure, for admins.
 *
 * The thread used to print an "AI classification" block (category, priority,
 * sentiment, a monospace confidence percentage) and a processing-trace toggle
 * on every message. Someone answering a customer needs none of it; someone
 * tuning the agent needs all of it. The header keeps a one-line summary
 * ("Billing · urgent"); the detail lives here, closed by default, and the host
 * renders this only for admins.
 */
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	inboundMessageId: Id<'inboundMessages'>;
	classification?: {
		category: string;
		priority: string;
		sentiment: string;
		confidence?: number;
	} | null;
	decisionReason?: string | null;
}>();

const { t, te } = useI18n();

const open = ref(false);

// Backend enums stay the source of truth; an unknown value renders as stored.
function label(group: string, value: string): string {
	const key = `dashboard.inbox.detail.${group}.${value}`;
	return te(key) ? t(key) : value;
}

const confidencePercent = computed(() =>
	props.classification?.confidence === undefined
		? null
		: Math.round(props.classification.confidence * 100)
);
</script>

<template>
	<div class="mt-3" data-testid="agent-insight">
		<button
			type="button"
			class="inline-flex items-center gap-1 text-xs text-text-tertiary hover:text-text-secondary"
			:aria-expanded="open"
			@click="open = !open"
		>
			<Icon :name="open ? 'lucide:chevron-down' : 'lucide:chevron-right'" class="w-3 h-3" />
			{{ t('dashboard.inbox.detail.insight.toggle') }}
		</button>
		<div
			v-if="open"
			class="mt-2 space-y-2 rounded-lg bg-bg-surface p-3 text-xs text-text-secondary"
			data-testid="agent-insight-body"
		>
			<p v-if="classification">
				{{
					t('dashboard.inbox.detail.insight.sortedAs', {
						category: label('categories', classification.category),
						priority: label('priorities', classification.priority),
						sentiment: label('sentiments', classification.sentiment),
					})
				}}
				<template v-if="confidencePercent !== null">
					{{ t('dashboard.inbox.detail.insight.confidence', { percent: confidencePercent }) }}
				</template>
			</p>
			<p v-if="decisionReason">
				{{ t('dashboard.inbox.detail.insight.reason', { reason: decisionReason }) }}
			</p>
			<InboxAgentActionTimeline :inbound-message-id="inboundMessageId" embedded />
		</div>
	</div>
</template>
