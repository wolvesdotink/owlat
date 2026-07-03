<script setup lang="ts">
/**
 * Read-only explanation of the agent's routing decision for one inbound message.
 *
 * Surfaces two things the pipeline already recorded but never showed:
 *   - agentDecision — the auto-approve / human-review outcome + the precise
 *     reason the route step computed ("Sent because… / Held because…").
 *   - groundingSources — the prior emails + knowledge entries context_retrieval
 *     assembled into the draft's briefing ("Grounded in:"). These titles are
 *     UNTRUSTED retrieved text; they are rendered as escaped text (never HTML).
 *
 * Purely presentational and DEGRADES CLEANLY: on a message processed before this
 * data existed (both fields absent) it renders nothing. Auto-imports as
 * <InboxDecisionRationale> (path-prefixed).
 */

interface GroundingSource {
	type: 'thread' | 'knowledge';
	id: string;
	title: string;
}

interface AgentDecision {
	decision: 'auto_approve' | 'human_review';
	reason: string;
	confidence: number;
}

const props = defineProps<{
	decision?: AgentDecision | null;
	groundingSources?: GroundingSource[] | null;
}>();

const decision = computed(() => props.decision ?? null);
const sources = computed(() => props.groundingSources ?? []);
const hasSources = computed(() => sources.value.length > 0);
const hasAnything = computed(() => decision.value !== null || hasSources.value);

const isAutoSend = computed(() => decision.value?.decision === 'auto_approve');
const headline = computed(() => (isAutoSend.value ? 'Sent because' : 'Held because'));
</script>

<template>
	<div v-if="hasAnything" class="mt-3 space-y-2 text-xs">
		<!-- Rationale line -->
		<div v-if="decision" class="flex items-start gap-1.5">
			<Icon
				:name="isAutoSend ? 'lucide:send' : 'lucide:pause'"
				:class="['w-3.5 h-3.5 mt-px shrink-0', isAutoSend ? 'text-success' : 'text-warning']"
			/>
			<p class="text-text-secondary">
				<span class="font-medium text-text-primary">{{ headline }}:</span>
				{{ decision.reason }}
			</p>
		</div>

		<!-- Grounded-in provenance list -->
		<div v-if="hasSources" class="flex items-start gap-1.5">
			<Icon name="lucide:link" class="w-3.5 h-3.5 mt-px shrink-0 text-text-tertiary" />
			<div class="min-w-0">
				<span class="font-medium text-text-primary">Grounded in:</span>
				<ul class="mt-1 space-y-0.5">
					<li
						v-for="src in sources"
						:key="`${src.type}:${src.id}`"
						class="flex items-center gap-1.5 text-text-secondary"
					>
						<Icon
							:name="src.type === 'knowledge' ? 'lucide:brain' : 'lucide:mail'"
							class="w-3 h-3 shrink-0 text-text-tertiary"
						/>
						<span class="truncate">{{ src.title }}</span>
					</li>
				</ul>
			</div>
		</div>
	</div>
</template>
