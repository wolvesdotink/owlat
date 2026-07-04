<script setup lang="ts">
/**
 * Freeform whole-draft REVISE affordance, shared by the Postbox composer and the
 * inbox review gate. The user types an instruction ("redo but decline politely",
 * "add that the invoice is attached") and the model rewrites the WHOLE draft,
 * streaming the new text in progressively. Advisory: the result is shown with an
 * Apply button and NEVER auto-applied; on any error the existing draft is left
 * untouched (fail-soft). Also the surface for iterating after a clarification.
 */
import { ref, nextTick } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { useDraftReviseConvex } from '~/composables/postbox/useDraftReviseConvex';

const props = defineProps<{
	currentDraft: string;
	threadContext?: string;
	mailboxId?: Id<'mailboxes'>;
	surface: 'compose' | 'review';
	aiEnabled: boolean;
}>();

const emit = defineEmits<{ (e: 'apply', text: string): void }>();

const { showToast } = useToast();
const open = ref(false);
const instruction = ref('');
const inputRef = ref<HTMLInputElement | null>(null);

const revise = useDraftReviseConvex({
	surface: props.surface,
	mailboxId: () => props.mailboxId,
	onError: (m) => showToast(m, 'error'),
});

async function toggle() {
	open.value = !open.value;
	if (open.value) {
		await nextTick();
		inputRef.value?.focus();
	}
}

function submit() {
	const text = instruction.value.trim();
	if (!text) return;
	void revise.start({
		instruction: text,
		currentDraft: props.currentDraft,
		...(props.threadContext ? { threadContext: props.threadContext } : {}),
	});
}

async function apply() {
	const text = await revise.apply();
	if (text !== null) {
		emit('apply', text);
		instruction.value = '';
		open.value = false;
	}
}

async function discard() {
	await revise.reset();
	instruction.value = '';
}
</script>

<template>
	<div v-if="aiEnabled" class="ai-revise">
		<button
			type="button"
			class="btn btn-ghost btn-sm gap-1"
			:aria-expanded="open"
			@click="toggle"
		>
			<Icon name="lucide:wand-2" class="w-3 h-3" />
			Revise…
		</button>

		<div v-if="open" class="ai-revise__panel mt-2 flex flex-col gap-2">
			<div class="flex items-center gap-2">
				<input
					ref="inputRef"
					v-model="instruction"
					type="text"
					class="input input-sm flex-1"
					placeholder="e.g. redo but decline politely"
					:disabled="revise.isStreaming.value"
					@keydown.enter.prevent="submit"
				/>
				<button
					type="button"
					class="btn btn-primary btn-sm"
					:disabled="revise.isStreaming.value || instruction.trim().length === 0"
					@click="submit"
				>
					{{ revise.isStreaming.value ? 'Revising…' : 'Revise' }}
				</button>
			</div>

			<!-- Progressive streamed output / final result -->
			<div
				v-if="revise.isStreaming.value || revise.hasResult.value"
				class="ai-revise__output rounded-md border border-border bg-surface-subtle p-2 text-sm whitespace-pre-wrap"
			>
				{{ revise.displayText.value }}<span v-if="revise.isStreaming.value" class="ai-revise__caret">▍</span>
			</div>

			<p v-if="revise.injectionFlagged.value" class="text-xs text-warning">
				This revision contains text that looks like an embedded instruction — review it before sending.
			</p>

			<div v-if="revise.hasResult.value" class="flex items-center gap-2">
				<button type="button" class="btn btn-primary btn-sm" @click="apply">Apply</button>
				<button type="button" class="btn btn-ghost btn-sm" @click="discard">Discard</button>
			</div>
		</div>
	</div>
</template>
