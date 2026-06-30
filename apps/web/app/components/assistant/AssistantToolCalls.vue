<script setup lang="ts">
export interface AssistantToolCall {
	toolCallId: string;
	toolName: string;
	argsJson?: string;
	resultJson?: string;
	status: 'running' | 'done' | 'error';
}

const props = defineProps<{ toolCalls: AssistantToolCall[] }>();

const open = ref(false);

const TOOL_LABELS: Record<string, string> = {
	searchKnowledge: 'Searched knowledge',
	searchFiles: 'Searched files',
	searchEverything: 'Searched workspace',
	getCampaignStats: 'Looked up campaign stats',
	getEmailStats: 'Looked up email stats',
	draftEmailReply: 'Drafted an email reply',
	draftCampaignCopy: 'Drafted campaign copy',
};

const label = (name: string) => TOOL_LABELS[name] ?? name;
const summary = computed(() =>
	props.toolCalls.length === 1
		? label(props.toolCalls[0]!.toolName)
		: `Used ${props.toolCalls.length} tools`,
);
</script>

<template>
	<div v-if="toolCalls.length > 0" class="mb-2 rounded-lg border border-border-subtle bg-bg-surface/50">
		<button
			class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary"
			@click="open = !open"
		>
			<Icon name="lucide:wrench" class="w-3.5 h-3.5 flex-shrink-0" />
			<span class="truncate">{{ summary }}</span>
			<Icon
				:name="open ? 'lucide:chevron-down' : 'lucide:chevron-right'"
				class="w-3.5 h-3.5 ml-auto flex-shrink-0"
			/>
		</button>

		<div v-if="open" class="border-t border-border-subtle px-3 py-2 space-y-2">
			<div v-for="tc in toolCalls" :key="tc.toolCallId" class="text-xs">
				<div class="flex items-center gap-2 font-medium text-text-secondary">
					<Icon
						v-if="tc.status === 'running'"
						name="lucide:loader-circle"
						class="w-3.5 h-3.5 animate-spin text-brand"
					/>
					<Icon
						v-else-if="tc.status === 'done'"
						name="lucide:check"
						class="w-3.5 h-3.5 text-success"
					/>
					<Icon v-else name="lucide:x" class="w-3.5 h-3.5 text-error" />
					<span>{{ label(tc.toolName) }}</span>
					<code class="text-[10px] text-text-tertiary">{{ tc.toolName }}</code>
				</div>
				<pre
					v-if="tc.argsJson"
					class="mt-1 overflow-x-auto rounded bg-bg-surface border border-border-subtle p-2 text-[11px] font-mono text-text-tertiary"
				>{{ tc.argsJson }}</pre>
				<pre
					v-if="tc.resultJson"
					class="mt-1 overflow-x-auto rounded bg-bg-surface border border-border-subtle p-2 text-[11px] font-mono text-text-tertiary max-h-40"
				>{{ tc.resultJson }}</pre>
			</div>
		</div>
	</div>
</template>
