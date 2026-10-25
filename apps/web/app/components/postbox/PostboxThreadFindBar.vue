<script setup lang="ts">
/**
 * Find in conversation's bar (⌘F): the query, "3 of 7", previous / next and
 * close, and what the count does not cover yet: messages still being read,
 * bodies that could not be read, encrypted or signed mail that is not
 * searched, and the earlier part of a long thread with its "Search earlier
 * messages". Presentation only; the reader's find controller
 * (usePostboxThreadFind) owns the state.
 *
 * Enter steps forward, Shift+Enter back. Escape closes the bar while it has
 * the keyboard, as the innermost escape layer, so it never closes the
 * conversation (or the overlay it sits in) on the way.
 */
import { useEscapeLayer } from '@owlat/ui/composables/useEscapeLayer';
import type { PostboxThreadFind } from '~/composables/postbox/usePostboxThreadFind';
import { POSTBOX_FIND_MAX_QUERY } from '~/utils/postboxFindSeed';

const props = defineProps<{ find: PostboxThreadFind }>();

const { t } = useI18n();
const inputEl = ref<HTMLInputElement | null>(null);
const hasFocus = ref(false);

const query = computed({
	get: () => props.find.query.value,
	set: (value: string) => {
		props.find.query.value = value;
	},
});

watch(
	() => props.find.focusRequest.value,
	async () => {
		await nextTick();
		inputEl.value?.focus();
		inputEl.value?.select();
	},
	{ flush: 'post' }
);

// A closed bar is gone from the page without a focusout to say so.
watch(
	() => props.find.isOpen.value,
	(open) => {
		if (!open) hasFocus.value = false;
	}
);
useEscapeLayer(
	() => props.find.isOpen.value && hasFocus.value,
	() => props.find.close()
);

function onFocusOut(event: FocusEvent) {
	const next = event.relatedTarget as Node | null;
	if (!next || !(event.currentTarget as HTMLElement).contains(next)) hasFocus.value = false;
}

function onKeydown(event: KeyboardEvent) {
	if (event.key !== 'Enter' || event.isComposing) return;
	event.preventDefault();
	if (event.shiftKey) props.find.previous();
	else props.find.next();
}

const total = computed(() => props.find.total.value);
const coverage = computed(() => props.find.coverage.value);
const canStep = computed(() => total.value > 0);

const countLabel = computed(() => {
	if (!props.find.hasQuery.value) return '';
	if (total.value > 0) {
		const position = props.find.activeIndex.value;
		return position >= 0
			? t('components.postbox.threadFind.position', {
					current: position + 1,
					total: total.value,
				})
			: t('components.postbox.threadFind.matches', { count: total.value }, total.value);
	}
	return coverage.value.pending > 0
		? t('components.postbox.threadFind.searching')
		: t('components.postbox.threadFind.noMatches');
});
const isNoMatch = computed(
	() => props.find.hasQuery.value && total.value === 0 && coverage.value.pending === 0
);
</script>

<template>
	<div
		v-if="find.isOpen.value"
		role="search"
		:aria-label="t('components.postbox.threadFind.label')"
		class="sticky top-2 z-20 mb-3 rounded-md border border-border-subtle bg-bg-elevated px-3 py-2 shadow-sm"
		data-testid="thread-find-bar"
		@focusin="hasFocus = true"
		@focusout="onFocusOut"
	>
		<div class="flex items-center gap-2">
			<Icon
				name="lucide:search"
				class="size-4 flex-shrink-0 text-text-tertiary"
				aria-hidden="true"
			/>
			<input
				ref="inputEl"
				v-model="query"
				type="text"
				enterkeyhint="search"
				:aria-label="t('components.postbox.threadFind.label')"
				:placeholder="t('components.postbox.threadFind.placeholder')"
				:maxlength="POSTBOX_FIND_MAX_QUERY"
				spellcheck="false"
				autocomplete="off"
				class="input-bare min-w-0 flex-1 text-sm"
				data-testid="thread-find-input"
				@keydown="onKeydown"
			/>
			<span
				aria-live="polite"
				class="whitespace-nowrap text-xs tabular-nums"
				:class="isNoMatch ? 'text-error' : 'text-text-tertiary'"
				data-testid="thread-find-count"
				>{{ countLabel }}</span
			>
			<button
				type="button"
				class="rounded p-1 text-text-secondary hover:bg-bg-surface hover:text-text-primary disabled:opacity-40"
				:aria-label="t('components.postbox.threadFind.previous')"
				:title="t('components.postbox.threadFind.previous')"
				:disabled="!canStep"
				data-testid="thread-find-previous"
				@click="find.previous()"
			>
				<Icon name="lucide:chevron-up" class="size-4" aria-hidden="true" />
			</button>
			<button
				type="button"
				class="rounded p-1 text-text-secondary hover:bg-bg-surface hover:text-text-primary disabled:opacity-40"
				:aria-label="t('components.postbox.threadFind.next')"
				:title="t('components.postbox.threadFind.next')"
				:disabled="!canStep"
				data-testid="thread-find-next"
				@click="find.next()"
			>
				<Icon name="lucide:chevron-down" class="size-4" aria-hidden="true" />
			</button>
			<button
				type="button"
				class="rounded p-1 text-text-secondary hover:bg-bg-surface hover:text-text-primary"
				:aria-label="t('components.postbox.threadFind.close')"
				:title="t('components.postbox.threadFind.close')"
				data-testid="thread-find-close"
				@click="find.close()"
			>
				<Icon name="lucide:x" class="size-4" aria-hidden="true" />
			</button>
		</div>
		<div
			v-if="
				find.hasQuery.value &&
				(coverage.failed > 0 ||
					coverage.unsearchable > 0 ||
					(coverage.pending > 0 && total > 0) ||
					find.hasEarlier.value ||
					find.loadingEarlier.value ||
					find.earlierFailed.value)
			"
			class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-xs text-text-tertiary"
			data-testid="thread-find-coverage"
		>
			<span v-if="coverage.pending > 0 && total > 0">{{
				t(
					'components.postbox.threadFind.stillSearching',
					{ count: coverage.pending },
					coverage.pending
				)
			}}</span>
			<span v-if="coverage.failed > 0" class="inline-flex items-center gap-1.5">
				{{ t('components.postbox.threadFind.failed', { count: coverage.failed }, coverage.failed) }}
				<button
					type="button"
					class="text-brand hover:underline"
					data-testid="thread-find-retry"
					@click="find.retry()"
				>
					{{ t('components.postbox.threadFind.retry') }}
				</button>
			</span>
			<span v-if="coverage.unsearchable > 0">{{
				t(
					'components.postbox.threadFind.unsearchable',
					{ count: coverage.unsearchable },
					coverage.unsearchable
				)
			}}</span>
			<span
				v-if="find.hasEarlier.value || find.loadingEarlier.value || find.earlierFailed.value"
				class="inline-flex items-center gap-1.5"
			>
				{{
					find.earlierFailed.value
						? t('components.postbox.threadFind.earlierFailed')
						: t('components.postbox.threadFind.loadedOnly')
				}}
				<button
					type="button"
					class="text-brand hover:underline disabled:opacity-60"
					:disabled="find.loadingEarlier.value"
					data-testid="thread-find-earlier"
					@click="find.searchEarlier()"
				>
					{{
						find.loadingEarlier.value
							? t('components.postbox.threadFind.loadingEarlier')
							: t('components.postbox.threadFind.searchEarlier')
					}}
				</button>
			</span>
		</div>
	</div>
</template>
