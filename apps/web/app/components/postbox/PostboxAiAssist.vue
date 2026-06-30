<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * In-inbox AI: summarize the thread + suggest replies. Calls the mail.ai
 * actions (advisory only). Emits `use-reply` with a chosen suggestion so the
 * reader opens a prefilled reply.
 */
const props = defineProps<{
	messageId: string;
}>();

const emit = defineEmits<{ (e: 'use-reply', text: string): void }>();

const summary = ref<string | null>(null);
const replies = ref<string[]>([]);

const summarizeOp = useBackendOperation(api.mail.ai.summarizeThread, {
	label: 'Summarize thread',
	type: 'action',
});
const suggestOp = useBackendOperation(api.mail.ai.suggestReplies, {
	label: 'Suggest replies',
	type: 'action',
});

const busy = computed(() => summarizeOp.isLoading.value || suggestOp.isLoading.value);

async function summarize() {
	summary.value = null;
	const res = await summarizeOp.run({ messageId: props.messageId as Id<'mailMessages'> });
	if (res) summary.value = res.summary;
}

async function suggest() {
	replies.value = [];
	const res = await suggestOp.run({ messageId: props.messageId as Id<'mailMessages'> });
	if (res) replies.value = res.replies;
}
</script>

<template>
	<div class="mt-3 space-y-2">
		<div class="flex items-center gap-2">
			<button
				type="button"
				class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-surface disabled:opacity-50"
				:disabled="summarizeOp.isLoading.value"
				aria-label="Summarize thread"
				@click="summarize"
			>
				<Icon
					:name="summarizeOp.isLoading.value ? 'lucide:loader-2' : 'lucide:sparkles'"
					class="w-3.5 h-3.5"
					:class="{ 'animate-spin': summarizeOp.isLoading.value }"
				/>
				Summarize
			</button>
			<button
				type="button"
				class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-surface disabled:opacity-50"
				:disabled="suggestOp.isLoading.value"
				aria-label="Suggest replies"
				@click="suggest"
			>
				<Icon
					:name="suggestOp.isLoading.value ? 'lucide:loader-2' : 'lucide:wand-2'"
					class="w-3.5 h-3.5"
					:class="{ 'animate-spin': suggestOp.isLoading.value }"
				/>
				Suggest replies
			</button>
		</div>

		<div aria-live="polite" :aria-busy="busy" class="space-y-2">
			<span v-if="busy" class="sr-only">Working…</span>

			<div
				v-if="summary"
				class="text-sm text-text-secondary bg-bg-surface border border-border-subtle rounded-lg p-3 whitespace-pre-wrap"
			>
				{{ summary }}
			</div>

			<div
				v-if="replies.length > 0"
				role="group"
				aria-label="Suggested replies"
				class="flex flex-wrap gap-2"
			>
				<button
					v-for="(r, i) in replies"
					:key="i"
					type="button"
					class="text-left text-xs px-3 py-2 rounded-lg border border-border-subtle hover:border-brand hover:bg-bg-surface max-w-xs"
					@click="emit('use-reply', r)"
				>
					{{ r }}
				</button>
			</div>
		</div>
	</div>
</template>
