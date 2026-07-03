<script setup lang="ts">
import { api } from '@owlat/api';

const props = defineProps<{
	isOpen: boolean;
}>();

const emit = defineEmits<{
	close: [];
}>();

type QuerySource =
	| { kind: 'knowledge'; id: string; title: string; entryType: string }
	| { kind: 'file'; id: string; title: string; filename: string };

const question = ref('');
const inputRef = ref<HTMLInputElement | null>(null);
const result = ref<{ answer: string; sources: QuerySource[] } | null>(null);

const { run: askMutation, isLoading } = useBackendOperation(api.quickQuery.ask, {
	label: 'Run query',
	type: 'action',
});

// Reset state when panel opens
watch(() => props.isOpen, (open) => {
	if (open) {
		question.value = '';
		result.value = null;
		nextTick(() => {
			inputRef.value?.focus();
		});
	}
});

const handleSubmit = async () => {
	const q = question.value.trim();
	if (!q || isLoading.value) return;

	result.value = null;

	const response = await askMutation({ question: q });
	if (response === undefined) return;
	result.value = response ?? null;
};

const handleKeydown = (e: KeyboardEvent) => {
	if (e.key === 'Escape') {
		e.preventDefault();
		emit('close');
	}
};
</script>

<template>
	<Teleport to="body">
		<!-- Backdrop -->
		<Transition
			enter-active-class="transition-opacity duration-150"
			enter-from-class="opacity-0"
			enter-to-class="opacity-100"
			leave-active-class="transition-opacity duration-150"
			leave-from-class="opacity-100"
			leave-to-class="opacity-0"
		>
			<div
				v-if="isOpen"
				class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50"
				@click="emit('close')"
			/>
		</Transition>

		<!-- Panel -->
		<Transition
			enter-active-class="transition-all duration-200"
			enter-from-class="opacity-0 scale-95"
			enter-to-class="opacity-100 scale-100"
			leave-active-class="transition-all duration-150"
			leave-from-class="opacity-100 scale-100"
			leave-to-class="opacity-0 scale-95"
		>
			<div
				v-if="isOpen"
				class="fixed inset-x-4 top-[12%] mx-auto max-w-2xl bg-bg-elevated border border-border-default rounded-xl shadow-2xl z-50 overflow-hidden"
				@keydown="handleKeydown"
			>
				<!-- Input -->
				<div class="flex items-center gap-3 px-4 py-3 border-b border-border-subtle">
					<Icon name="lucide:sparkles" class="w-5 h-5 text-brand flex-shrink-0" />
					<input
						ref="inputRef"
						v-model="question"
						type="text"
						placeholder="Ask anything about your knowledge and files..."
						class="flex-1 bg-transparent text-text-primary placeholder-text-tertiary outline-none text-base"
						@keydown.enter="handleSubmit"
					/>
					<button
						v-if="question"
						class="p-1 text-text-tertiary hover:text-text-primary transition-colors"
						@click="question = ''"
					 aria-label="Clear question">
						<Icon name="lucide:x" class="w-4 h-4" />
					</button>
					<kbd class="hidden sm:inline-flex items-center px-2 py-1 text-xs text-text-tertiary bg-bg-surface border border-border-subtle rounded">
						ESC
					</kbd>
				</div>

				<!-- Results area -->
				<div class="max-h-[60vh] overflow-y-auto">
					<!-- Loading -->
					<div v-if="isLoading" class="px-4 py-8 text-center text-text-tertiary">
						<Icon name="lucide:loader-2" class="w-6 h-6 animate-spin mx-auto mb-2 text-brand" />
						<p class="text-sm">Searching your knowledge and files...</p>
					</div>

					<!-- Result -->
					<div v-else-if="result" class="p-4">
						<QueryResult
							:answer="result.answer"
							:sources="result.sources"
						/>
					</div>

					<!-- Empty state -->
					<div v-else class="px-4 py-8 text-center text-text-tertiary">
						<Icon name="lucide:message-circle-question" class="w-8 h-8 mx-auto mb-2 opacity-50" />
						<p class="text-sm">Ask a question across your knowledge and files</p>
						<p class="text-xs mt-1">Press Enter for a synthesized, cited answer</p>
					</div>
				</div>

				<!-- Footer -->
				<div class="px-4 py-2 border-t border-border-subtle bg-bg-surface text-xs text-text-tertiary flex items-center gap-4">
					<span class="flex items-center gap-1">
						<kbd class="px-1 py-0.5 bg-bg-elevated border border-border-subtle rounded text-[10px]">↵</kbd>
						Search
					</span>
					<span class="flex items-center gap-1">
						<kbd class="px-1 py-0.5 bg-bg-elevated border border-border-subtle rounded text-[10px]">ESC</kbd>
						Close
					</span>
					<span class="ml-auto flex items-center gap-1">
						<kbd class="px-1 py-0.5 bg-bg-elevated border border-border-subtle rounded text-[10px]">
							<span class="text-xs">⌘</span>⇧K
						</kbd>
						Toggle
					</span>
				</div>
			</div>
		</Transition>
	</Teleport>
</template>
