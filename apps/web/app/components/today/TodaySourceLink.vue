<script setup lang="ts">
import type { TodaySource } from '~/utils/todayDigest';
import { TODAY_PEEK, type TodayPeekControls } from '~/utils/todayPeek';

/**
 * A summarised phrase that quietly links to the email(s) it came from.
 *
 * At rest it reads as plain text: nearly every line on Today is one of these,
 * and a dotted underline on all of them was noise. Hover and keyboard focus
 * underline it and tint it. There is deliberately no marker after it: sender initials or a bare
 * count next to a sentence read as debug output. Who and how many are in the
 * accessible name and in the preview. Hover or keyboard focus shows that
 * preview after a short delay; click / Enter opens the email in Today's side
 * panel; ⌘/Ctrl-click opens the full conversation.
 */
const props = defineProps<{ text: string; sources: TodaySource[] }>();
const { t } = useI18n();
const peek = inject(TODAY_PEEK, null) as TodayPeekControls | null;

const first = computed(() => props.sources[0] ?? null);
const accessibleLabel = computed(() => {
	const s = first.value;
	if (!s) return props.text;
	return props.sources.length > 1
		? t('components.today.source.many', { count: props.sources.length, subject: s.subject })
		: t('components.today.source.one', {
				from: s.fromName || s.fromAddress,
				subject: s.subject || t('components.shell.noSubject'),
			});
});

const HOVER_DELAY_MS = 300;
const previewOpen = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;
function schedulePreview() {
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => (previewOpen.value = true), HOVER_DELAY_MS);
}
function hidePreview() {
	if (timer) clearTimeout(timer);
	timer = null;
	previewOpen.value = false;
}
onBeforeUnmount(hidePreview);

function open(event: MouseEvent | KeyboardEvent, index = 0) {
	hidePreview();
	const fullThread = 'metaKey' in event && (event.metaKey || event.ctrlKey);
	if (fullThread) {
		peek?.openThread(props.sources[index] ?? props.sources[0]!);
		return;
	}
	peek?.open(props.sources, index);
}

function when(at: number): string {
	return formatCompactRelativeTime(at);
}
</script>

<template>
	<span class="relative" @mouseleave="hidePreview">
		<a
			href="#"
			class="cursor-pointer rounded-sm decoration-brand underline-offset-[3px] transition-colors hover:bg-brand-subtle hover:underline focus-visible:bg-brand-subtle focus-visible:underline focus-visible:outline-none"
			:aria-label="`${text} — ${accessibleLabel}`"
			@click.prevent="open($event)"
			@keydown.enter.prevent="open($event)"
			@mouseenter="schedulePreview"
			@focus="schedulePreview"
			@blur="hidePreview"
			>{{ text }}</a
		>

		<Transition
			enter-active-class="transition duration-(--motion-fast)"
			enter-from-class="opacity-0 translate-y-0.5"
			leave-active-class="transition duration-(--motion-fast)"
			leave-to-class="opacity-0"
		>
			<span
				v-if="previewOpen && first"
				role="tooltip"
				class="absolute left-0 top-full z-(--z-dropdown,40) mt-2 block w-80 rounded-xl border border-border-subtle bg-bg-elevated p-3 text-left shadow-lg"
				@mouseenter="previewOpen = true"
			>
				<template v-if="sources.length === 1">
					<span class="flex items-center gap-2">
						<span class="truncate text-xs font-medium text-text-primary">{{
							first.fromName || first.fromAddress
						}}</span>
						<span class="ml-auto shrink-0 text-2xs text-text-tertiary">{{ when(first.at) }}</span>
					</span>
					<span class="mt-1 block truncate text-xs font-medium text-text-secondary">{{
						first.subject || t('components.shell.noSubject')
					}}</span>
					<span v-if="first.snippet" class="mt-1 line-clamp-3 block text-xs text-text-tertiary">{{
						first.snippet
					}}</span>
					<span class="mt-2 flex items-center gap-2 text-2xs text-text-tertiary">
						<kbd class="font-mono">⏎</kbd> {{ t('components.today.source.open') }}
						<kbd class="ml-2 font-mono">⌘⏎</kbd> {{ t('components.today.source.fullThread') }}
					</span>
				</template>
				<template v-else>
					<button
						v-for="(source, index) in sources"
						:key="source.id"
						type="button"
						class="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-bg-surface"
						@click="open($event, index)"
					>
						<span class="truncate text-xs text-text-primary">{{
							source.subject || t('components.shell.noSubject')
						}}</span>
						<span class="ml-auto shrink-0 text-2xs text-text-tertiary">{{ when(source.at) }}</span>
					</button>
				</template>
			</span>
		</Transition>
	</span>
</template>
