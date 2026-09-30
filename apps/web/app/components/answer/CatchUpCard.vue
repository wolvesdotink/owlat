<script setup lang="ts">
/**
 * The catch-up card at the top of Answer mode's conversation (plan §03): what
 * happened, what they want, and the files that went back and forth.
 *
 *  - "Catching up": two to four sentences, oldest to newest, each with a small
 *    date marker per day it draws on (at most three). A marker scrolls to that
 *    day's first source message and highlights it.
 *  - "They are asking for": the asks, ticked as the draft covers them. A short
 *    "why" follows a tick only when the check said why.
 *  - "Files in this thread": every attachment exchanged, as chips. Click one to
 *    attach it to the reply, or drag it onto the composer.
 *
 * A short thread with two or more asks gets the checklist alone (the backend
 * sends no sentences then). While the first answer is on its way the card is a
 * quiet skeleton; with nothing to show it renders nothing.
 */
import type { CatchUp } from '~/composables/useAnswerCatchUp';
import { formatCompactFileSize } from '~/utils/formatters';
import {
	THREAD_FILE_DRAG_TYPE,
	threadFilesOf,
	type ThreadFile,
	type ThreadFileSource,
} from '~/utils/answerThreadFiles';

/** The most date markers one sentence gets. */
const MAX_MARKERS = 3;

export interface CatchUpMessage extends ThreadFileSource {
	fromName?: string | null;
	fromAddress: string;
}

const props = withDefaults(
	defineProps<{
		catchUp: CatchUp | null;
		loading?: boolean;
		/** The loaded messages, for the markers' dates and the file chips. */
		messages: readonly CatchUpMessage[];
		/** Ask ids the draft covers. */
		covered?: readonly string[];
		/** A short reason per covered ask ("attached"), when the check gave one. */
		hints?: Readonly<Record<string, string>>;
		/** The file being attached right now (its `key`). */
		attaching?: string | null;
		/** Whether a chip can attach (the composer is there). */
		canAttach?: boolean;
	}>(),
	{ loading: false, covered: () => [], hints: () => ({}), attaching: null, canAttach: true }
);

const emit = defineEmits<{
	/** Scroll to a source message and highlight it. */
	reveal: [messageId: string];
	attach: [file: ThreadFile];
}>();

const { t, locale } = useI18n();

const byId = computed(() => new Map(props.messages.map((m) => [m._id, m])));
const sentences = computed(() => props.catchUp?.sentences ?? []);
const asks = computed(() => props.catchUp?.asks ?? []);
const asksOnly = computed(() => sentences.value.length === 0);
const files = computed(() => (asksOnly.value ? [] : threadFilesOf(props.messages)));
const coveredSet = computed(() => new Set(props.covered));
const hasContent = computed(() => sentences.value.length > 0 || asks.value.length > 0);

const shortDate = computed(
	() => new Intl.DateTimeFormat(locale.value, { day: 'numeric', month: 'short' })
);
function dateOf(timestamp: number): string {
	return shortDate.value.format(new Date(timestamp));
}

const since = computed(() => {
	const first = props.messages.reduce<number | null>(
		(min, m) => (min === null || m.receivedAt < min ? m.receivedAt : min),
		null
	);
	return first === null ? null : dateOf(first);
});

const meta = computed(() => {
	const count = props.catchUp?.messageCount ?? props.messages.length;
	return since.value
		? t('components.answer.catchUp.meta', { count, date: since.value }, count)
		: t('components.answer.mode.messageCount', { count }, count);
});

/**
 * The markers of one sentence: its known sources, oldest first, one per day,
 * at most three. Two sources from the same day would render as two identical
 * chips ("Sep 3 Sep 3") that scroll to different messages; the day's first
 * message stands for it.
 */
function markersOf(sourceIds: readonly string[]) {
	const seenDates = new Set<string>();
	return sourceIds
		.map((id) => byId.value.get(id))
		.filter((m): m is CatchUpMessage => m !== undefined)
		.sort((a, b) => a.receivedAt - b.receivedAt)
		.map((m) => ({ message: m, date: dateOf(m.receivedAt) }))
		.filter(({ date }) => !seenDates.has(date) && !!seenDates.add(date))
		.slice(0, MAX_MARKERS)
		.map(({ message: m, date }) => ({
			id: m._id,
			date,
			label: t('components.answer.catchUp.marker', { sender: m.fromName || m.fromAddress, date }),
		}));
}

function onDragStart(event: DragEvent, file: ThreadFile) {
	if (!event.dataTransfer) return;
	event.dataTransfer.effectAllowed = 'copy';
	event.dataTransfer.setData(THREAD_FILE_DRAG_TYPE, JSON.stringify(file));
}

const titleId = useId();
</script>

<template>
	<section
		v-if="loading && !hasContent"
		class="space-y-2 rounded-lg border border-border-subtle bg-bg-elevated p-4"
		:aria-label="t('components.answer.catchUp.loading')"
		aria-busy="true"
		data-testid="catch-up-loading"
	>
		<UiSkeleton class="h-3 w-40" />
		<UiSkeleton class="h-3 w-full" />
		<UiSkeleton class="h-3 w-4/5" />
	</section>

	<section
		v-else-if="catchUp && hasContent"
		class="rounded-lg border border-border-subtle bg-bg-elevated p-4 text-sm"
		:aria-labelledby="titleId"
		data-testid="catch-up-card"
	>
		<template v-if="!asksOnly">
			<p class="flex flex-wrap items-center gap-x-1.5 text-xs text-text-tertiary">
				<Icon name="lucide:sparkles" class="size-3.5 text-brand" aria-hidden="true" />
				<span :id="titleId" class="font-semibold text-text-secondary">
					{{ t('components.answer.catchUp.title') }}
				</span>
				<span aria-hidden="true">·</span>
				<span data-testid="catch-up-meta">{{ meta }}</span>
			</p>
			<p class="mt-2 leading-relaxed text-text-primary" data-testid="catch-up-sentences">
				<template v-for="(sentence, si) in sentences" :key="si">
					<span data-testid="catch-up-sentence">{{ sentence.text }}</span>
					<button
						v-for="marker in markersOf(sentence.sourceMessageIds)"
						:key="marker.id"
						type="button"
						class="ml-1 inline-flex items-center rounded-sm bg-bg-surface px-1 align-baseline text-2xs text-text-tertiary hover:bg-(--surface-2-selected) hover:text-text-primary focus-visible:outline-2 focus-visible:outline-brand"
						:aria-label="marker.label"
						:title="marker.label"
						data-testid="catch-up-marker"
						@click="emit('reveal', marker.id)"
					>
						{{ marker.date }}
					</button>
					{{ ' ' }}
				</template>
			</p>
		</template>

		<div v-if="asks.length > 0" :class="asksOnly ? '' : 'mt-3'">
			<p :id="asksOnly ? titleId : undefined" class="text-xs font-semibold text-text-secondary">
				{{ t('components.answer.catchUp.asksTitle') }}
			</p>
			<ul class="mt-1.5 space-y-1" data-testid="catch-up-asks">
				<li
					v-for="ask in asks"
					:key="ask.id"
					class="flex items-start gap-2"
					:data-covered="coveredSet.has(ask.id)"
					data-testid="catch-up-ask"
				>
					<Icon
						:name="coveredSet.has(ask.id) ? 'lucide:circle-check' : 'lucide:circle'"
						class="mt-0.5 size-4 shrink-0"
						:class="coveredSet.has(ask.id) ? 'text-success' : 'text-text-tertiary'"
						aria-hidden="true"
					/>
					<span class="min-w-0">
						<span class="sr-only">
							{{
								coveredSet.has(ask.id)
									? t('components.answer.catchUp.askCovered')
									: t('components.answer.catchUp.askOpen')
							}}
						</span>
						<span class="text-text-primary">{{ ask.text }}</span>
						<span
							v-if="coveredSet.has(ask.id) && hints[ask.id]"
							class="ml-1.5 text-xs text-text-tertiary"
							data-testid="catch-up-ask-hint"
							>{{ hints[ask.id] }}</span
						>
					</span>
				</li>
			</ul>
		</div>

		<div v-if="files.length > 0" class="mt-3">
			<p class="text-xs font-semibold text-text-secondary">
				{{ t('components.answer.catchUp.filesTitle') }}
			</p>
			<ul class="mt-1.5 flex flex-wrap gap-1.5" data-testid="catch-up-files">
				<li v-for="file in files" :key="file.key">
					<button
						type="button"
						class="inline-flex max-w-64 items-center gap-1.5 rounded-full border border-border-subtle px-2.5 py-1 text-xs text-text-secondary hover:border-text-tertiary hover:bg-bg-surface focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-60"
						:draggable="canAttach"
						:disabled="!canAttach || attaching === file.key"
						:title="t('components.answer.catchUp.attachHint')"
						:aria-label="t('components.answer.catchUp.attachFile', { file: file.filename })"
						data-testid="catch-up-file"
						@click="emit('attach', file)"
						@dragstart="onDragStart($event, file)"
					>
						<Icon
							:name="attaching === file.key ? 'lucide:loader-2' : 'lucide:paperclip'"
							class="size-3.5 shrink-0"
							:class="attaching === file.key ? 'animate-spin motion-reduce:animate-none' : ''"
							aria-hidden="true"
						/>
						<span class="truncate">{{ file.filename }}</span>
						<span class="shrink-0 text-text-tertiary">
							{{ formatCompactFileSize(file.size) }} · {{ dateOf(file.receivedAt) }}
						</span>
					</button>
				</li>
			</ul>
		</div>
	</section>
</template>
