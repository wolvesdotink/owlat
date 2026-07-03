<script setup lang="ts">
import type { ReplyQueueItem } from '~/utils/postboxReplyQueue';
import { clarificationCardState } from '~/utils/postboxReplyQueue';

/**
 * "Needs your input" Reply Queue card — the Postbox-native clarification loop.
 *
 * When the AI decided a good reply is missing a fact only the owner can supply,
 * the thread carries `clarification.questions`. Each question renders with its
 * sender attribution, inline scoped-option chips (one tap) and a free-text box,
 * so the owner can resolve it without opening the thread. Answering flips the
 * card: 'asking' → 'drafting' (starter reply generating) → 'ready' ("Draft
 * ready", open the composer prefilled).
 *
 * Stateless w.r.t. the server: it emits `answer` with the collected values and
 * the parent drives the mutation + live subscription; the card re-renders as
 * the persisted `clarification` prop advances through the states above.
 */
const props = defineProps<{ item: ReplyQueueItem; submitting?: boolean }>();
const emit = defineEmits<{
	(e: 'answer', answers: { questionId: string; value: string }[]): void;
	(e: 'open-draft', draft: string): void;
	(e: 'open'): void;
	(e: 'done'): void;
}>();

const clarification = computed(() => props.item.clarification);
const state = computed(() => clarificationCardState(clarification.value));
const questions = computed(() => clarification.value?.questions ?? []);

// Per-question working value (chip pick or typed text), keyed by question id.
const values = reactive<Record<string, string>>({});

function pick(questionId: string, option: string) {
	// Tapping the already-selected chip clears it (toggle).
	values[questionId] = values[questionId] === option ? '' : option;
}

const canSubmit = computed(
	() => !props.submitting && questions.value.some((q) => (values[q.id] ?? '').trim().length > 0)
);

function submit() {
	if (!canSubmit.value) return;
	const answers = questions.value
		.filter((q) => (values[q.id] ?? '').trim().length > 0)
		.map((q) => ({ questionId: q.id, value: values[q.id]!.trim() }));
	if (answers.length > 0) emit('answer', answers);
}
</script>

<template>
	<div
		class="px-4 py-3 border-l-2 border-brand/60 bg-brand/[0.03]"
		data-testid="clarification-card"
	>
		<div class="flex items-start gap-3">
			<UiAvatar
				:name="item.fromName"
				:email="item.fromAddress"
				deterministic-color
				size="sm"
				class="flex-shrink-0 mt-0.5"
				aria-hidden="true"
			/>
			<div class="flex-1 min-w-0">
				<div class="flex items-center gap-1.5">
					<span
						class="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide px-1.5 py-px rounded-full bg-brand/10 text-brand"
					>
						<Icon name="lucide:message-circle-question" class="w-3 h-3" />
						{{ state === 'ready' ? 'Draft ready' : 'Needs your input' }}
					</span>
					<span class="truncate text-xs text-text-tertiary">
						{{ item.fromName || item.fromAddress }}
					</span>
				</div>

				<!-- asking: question(s) + chips + free text -->
				<template v-if="state === 'asking'">
					<div v-for="q in questions" :key="q.id" class="mt-2" data-testid="clarification-question">
						<p class="text-sm font-medium text-text-primary">{{ q.text }}</p>
						<div v-if="q.options?.length" class="flex flex-wrap gap-1.5 mt-1.5">
							<button
								v-for="opt in q.options"
								:key="opt"
								type="button"
								data-testid="clarification-chip"
								class="text-xs px-2 py-1 rounded-full border transition-colors"
								:class="
									values[q.id] === opt
										? 'bg-brand text-white border-brand'
										: 'border-border-subtle text-text-secondary hover:bg-bg-elevated'
								"
								@click.stop="pick(q.id, opt)"
							>
								{{ opt }}
							</button>
						</div>
						<input
							v-model="values[q.id]"
							type="text"
							data-testid="clarification-input"
							:placeholder="q.options?.length ? 'Or type an answer…' : 'Type your answer…'"
							class="mt-1.5 w-full text-sm px-2 py-1.5 rounded border border-border-subtle bg-bg-surface focus:outline-none focus:ring-1 focus:ring-brand/40"
							@keydown.enter.stop.prevent="submit"
							@click.stop
						/>
						<p class="mt-1 text-[11px] text-text-tertiary">{{ q.attribution }}</p>
					</div>
					<div class="flex items-center gap-2 mt-2">
						<button
							type="button"
							data-testid="clarification-submit"
							class="text-xs font-medium px-2.5 py-1 rounded bg-brand text-white disabled:opacity-50"
							:disabled="!canSubmit"
							@click.stop="submit"
						>
							<Icon
								v-if="submitting"
								name="lucide:loader-2"
								class="w-3.5 h-3.5 animate-spin inline"
							/>
							<span v-else>Answer</span>
						</button>
						<button
							type="button"
							class="text-xs text-text-tertiary hover:text-text-primary"
							@click.stop="emit('done')"
						>
							Dismiss
						</button>
					</div>
				</template>

				<!-- drafting: answered, starter reply generating. A Dismiss control is
					always present so a failed/slow draft (AI gate off, empty output,
					staleness-skipped persist) never strands the card — the owner can
					clear it and fall back to the plain "Draft reply" button. -->
				<div v-else-if="state === 'drafting'" class="mt-2" data-testid="clarification-drafting">
					<div class="flex items-center gap-2 text-sm text-text-secondary">
						<Icon name="lucide:loader-2" class="w-4 h-4 animate-spin" />
						Drafting your reply…
					</div>
					<button
						type="button"
						data-testid="clarification-drafting-dismiss"
						class="mt-2 text-xs text-text-tertiary hover:text-text-primary"
						@click.stop="emit('done')"
					>
						Dismiss
					</button>
				</div>

				<!-- ready: starter reply available -->
				<template v-else-if="state === 'ready'">
					<p class="mt-2 text-sm text-text-secondary line-clamp-3 whitespace-pre-line">
						{{ clarification?.draft }}
					</p>
					<div class="flex items-center gap-2 mt-2">
						<button
							type="button"
							data-testid="clarification-open-draft"
							class="text-xs font-medium px-2.5 py-1 rounded bg-brand text-white"
							@click.stop="emit('open-draft', clarification?.draft ?? '')"
						>
							Open draft
						</button>
						<button
							type="button"
							class="text-xs text-text-tertiary hover:text-text-primary"
							@click.stop="emit('done')"
						>
							Done
						</button>
					</div>
				</template>
			</div>
		</div>
	</div>
</template>
