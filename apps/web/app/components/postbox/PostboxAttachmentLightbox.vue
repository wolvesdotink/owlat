<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, nextTick } from 'vue';
import { formatCompactFileSize } from '~/utils/formatters';

/**
 * Apple-style Quick Look overlay for previewable attachments (image/* and
 * application/pdf). Fullscreen dim backdrop, arrow-key + chevron navigation
 * between the message's previewable parts, filename/size header with Download
 * and "Open in new tab" fallback actions.
 *
 * The parent owns extraction (raw .eml fetch + MIME part decode) and passes it
 * in via `loadPart`; this component only manages the blob object URLs — one
 * live URL at a time, revoked on navigation and on close (no leaks).
 *
 * Focus is trapped inside the dialog while open and restored to the opener on
 * close via the shared useModalFocus composable (same behavior as UiModal).
 */

export interface LightboxAttachment {
	filename: string;
	contentType: string;
	size: number;
	partIndex?: string;
}

const props = defineProps<{
	/** The previewable attachments of one message, in display order. */
	attachments: LightboxAttachment[];
	/** Index of the attachment that was clicked. */
	initialIndex: number;
	/** Extracts one part as a Blob (null = not found / fetch failed). */
	loadPart: (att: LightboxAttachment) => Promise<Blob | null>;
}>();

const emit = defineEmits<{
	close: [];
	/** Reuses the parent's existing download path. */
	download: [att: LightboxAttachment];
}>();

const containerRef = ref<HTMLElement | null>(null);
const activeIndex = ref(
	Math.min(Math.max(props.initialIndex, 0), Math.max(props.attachments.length - 1, 0))
);
const objectUrl = ref<string | null>(null);
const isLoading = ref(false);
const loadFailed = ref(false);

const current = computed(() => props.attachments[activeIndex.value]);
const isPdf = computed(() => current.value?.contentType === 'application/pdf');
const hasPrev = computed(() => activeIndex.value > 0);
const hasNext = computed(() => activeIndex.value < props.attachments.length - 1);

function revokeObjectUrl() {
	if (objectUrl.value) {
		URL.revokeObjectURL(objectUrl.value);
		objectUrl.value = null;
	}
}

// Guards against out-of-order resolution when the user navigates faster than
// parts extract: only the latest request may publish its URL.
let loadToken = 0;

async function loadActivePart() {
	const att = current.value;
	revokeObjectUrl();
	if (!att) return;
	const token = ++loadToken;
	isLoading.value = true;
	loadFailed.value = false;
	try {
		const blob = await props.loadPart(att);
		if (token !== loadToken) return;
		if (blob) objectUrl.value = URL.createObjectURL(blob);
		else loadFailed.value = true;
	} catch {
		// Extraction failure degrades to the in-overlay error state; the
		// attachment row's download action stays available.
		if (token === loadToken) loadFailed.value = true;
	} finally {
		if (token === loadToken) isLoading.value = false;
	}
}

watch(activeIndex, () => void loadActivePart(), { immediate: true });

function goPrev() {
	if (hasPrev.value) activeIndex.value -= 1;
}

function goNext() {
	if (hasNext.value) activeIndex.value += 1;
}

// Drives useModalFocus: flipping it off restores focus to the opener BEFORE
// the parent unmounts us (the composable's watcher can't run after unmount).
const focusActive = ref(true);

async function close() {
	focusActive.value = false;
	await nextTick();
	emit('close');
}

useModalFocus(containerRef, focusActive, () => void close());

function onKeydown(event: KeyboardEvent) {
	if (event.key === 'ArrowLeft') {
		event.preventDefault();
		goPrev();
	} else if (event.key === 'ArrowRight') {
		event.preventDefault();
		goNext();
	}
}

function openInNewTab() {
	if (objectUrl.value) window.open(objectUrl.value, '_blank', 'noopener');
}

onBeforeUnmount(() => {
	// Invalidate any in-flight load so it can't publish a URL after unmount.
	loadToken += 1;
	revokeObjectUrl();
});
</script>

<template>
	<Teleport to="body">
		<div
			ref="containerRef"
			class="fixed inset-0 z-[100] flex flex-col bg-black/85"
			role="dialog"
			aria-modal="true"
			:aria-label="current ? `Preview of ${current.filename}` : 'Attachment preview'"
			tabindex="-1"
			@keydown="onKeydown"
			@click.self="close()"
		>
			<header class="flex items-center gap-3 px-4 py-3 text-white/90">
				<div class="min-w-0 flex-1">
					<p class="truncate text-sm font-medium">{{ current?.filename }}</p>
					<p class="text-xs text-white/60">
						<template v-if="current">{{ formatCompactFileSize(current.size) }}</template>
						<template v-if="attachments.length > 1">
							· {{ activeIndex + 1 }} of {{ attachments.length }}
						</template>
					</p>
				</div>
				<button
					type="button"
					class="p-2 rounded hover:bg-white/10 disabled:opacity-40"
					title="Open in new tab"
					aria-label="Open in new tab"
					:disabled="!objectUrl"
					@click="openInNewTab"
				>
					<Icon name="lucide:external-link" class="w-4 h-4" />
				</button>
				<button
					v-if="current"
					type="button"
					class="p-2 rounded hover:bg-white/10"
					:title="`Download ${current.filename}`"
					:aria-label="`Download ${current.filename}`"
					@click="emit('download', current)"
				>
					<Icon name="lucide:download" class="w-4 h-4" />
				</button>
				<button
					type="button"
					class="p-2 rounded hover:bg-white/10"
					title="Close preview"
					aria-label="Close preview"
					@click="close()"
				>
					<Icon name="lucide:x" class="w-4 h-4" />
				</button>
			</header>

			<div class="relative flex-1 min-h-0 flex items-center justify-center px-14 pb-6" @click.self="close()">
				<button
					v-if="hasPrev"
					type="button"
					class="absolute left-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white"
					title="Previous attachment"
					aria-label="Previous attachment"
					@click="goPrev"
				>
					<Icon name="lucide:chevron-left" class="w-5 h-5" />
				</button>

				<div v-if="isLoading" class="flex flex-col items-center gap-2 text-white/70">
					<Icon name="lucide:loader-2" class="w-6 h-6 animate-spin" />
					<p class="text-sm">Loading preview…</p>
				</div>
				<p v-else-if="loadFailed || !objectUrl" class="text-sm text-white/70">
					Preview unavailable — use Download instead.
				</p>
				<img
					v-else-if="!isPdf"
					:src="objectUrl"
					:alt="current?.filename"
					class="max-w-full max-h-full object-contain rounded shadow-2xl"
				/>
				<object
					v-else
					:data="objectUrl"
					type="application/pdf"
					class="w-full h-full rounded bg-white"
					:aria-label="`PDF preview of ${current?.filename}`"
				>
					<p class="p-4 text-sm text-text-primary">
						This browser can't embed PDFs —
						<button type="button" class="underline" @click="openInNewTab">open in a new tab</button>
						instead.
					</p>
				</object>

				<button
					v-if="hasNext"
					type="button"
					class="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white"
					title="Next attachment"
					aria-label="Next attachment"
					@click="goNext"
				>
					<Icon name="lucide:chevron-right" class="w-5 h-5" />
				</button>
			</div>
		</div>
	</Teleport>
</template>
