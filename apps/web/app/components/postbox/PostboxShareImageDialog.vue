<script setup lang="ts">
/**
 * "Share as image…": one message as a clean card the person can redact and then
 * copy, save as a PNG or hand to the system share sheet. The preview is the
 * canvas that is exported, so what is on screen is exactly what leaves.
 *
 * Words are redacted by clicking them, or from the keyboard: the preview takes
 * focus, the arrow keys move between words and Space or Enter hides one.
 */
import type { ShareCardRedactionStyle, ShareCardScheme } from '~/utils/postboxShareCardPaint';
import {
	usePostboxShareImage,
	type PostboxShareImageMessage,
} from '~/composables/postbox/usePostboxShareImage';
import { CopyIcon, DownloadIcon, EyeOffIcon, ShareIcon } from '@coolicons/vue';

const props = defineProps<{ message: PostboxShareImageMessage }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const { showToast } = useToast();
const { user } = useAuth();
const { isDark } = useAppTheme();

const share = usePostboxShareImage({
	message: () => props.message,
	ownName: () => user.value?.name,
	noSubject: () => t('components.postbox.postboxShareImage.noSubject'),
	initialScheme: isDark.value ? 'dark' : 'light',
});
const { canvasEl, layout, redacted, card } = share;

const P = 'components.postbox.postboxShareImage';
const schemeOptions = computed(() => [
	{ value: 'light', label: t(`${P}.light`) },
	{ value: 'dark', label: t(`${P}.dark`) },
]);
const styleOptions = computed(() => [
	{ value: 'bar', label: t(`${P}.bar`) },
	{ value: 'blur', label: t(`${P}.blur`) },
]);
const scheme = computed({
	get: () => share.scheme.value,
	set: (value: string) => (share.scheme.value = value as ShareCardScheme),
});
const style = computed({
	get: () => share.style.value,
	set: (value: string) => (share.style.value = value as ShareCardRedactionStyle),
});

function onCanvasClick(event: MouseEvent) {
	const tokenId = share.tokenAtClient(event.clientX, event.clientY);
	if (tokenId !== null) share.toggle(tokenId);
}

// Keyboard: a focus ring over one word, moved with the arrow keys.
const focusedToken = ref<number | null>(null);
const canvasFocused = ref(false);
function onCanvasKeydown(event: KeyboardEvent) {
	const count = card.value.tokens.length;
	if (count === 0) return;
	const current = focusedToken.value ?? -1;
	const moves: Record<string, number> = {
		ArrowRight: current + 1,
		ArrowDown: current + 1,
		ArrowLeft: current - 1,
		ArrowUp: current - 1,
		Home: 0,
		End: count - 1,
	};
	if (event.key in moves) {
		event.preventDefault();
		focusedToken.value = Math.min(count - 1, Math.max(0, moves[event.key] ?? 0));
	} else if ((event.key === ' ' || event.key === 'Enter') && focusedToken.value !== null) {
		event.preventDefault();
		share.toggle(focusedToken.value);
	}
}
// The ring is painted, so a screen reader hears the word under it, and whether
// it is hidden, through a live line instead: the canvas alone exposes no text.
const activeWordId = useId();
const activeTokenAnnouncement = computed(() => {
	const id = focusedToken.value;
	if (!canvasFocused.value || id === null) return '';
	const token = card.value.tokens[id];
	if (!token) return '';
	const params = { word: token.text, position: id + 1, total: card.value.tokens.length };
	return redacted.value.has(id)
		? t(`${P}.activeWordHidden`, params)
		: t(`${P}.activeWordShown`, params);
});
const focusRing = computed(() => {
	const current = layout.value;
	const id = focusedToken.value;
	if (!canvasFocused.value || !current || id === null) return null;
	const fragment = current.fragments.find((f) => f.tokenId === id);
	if (!fragment) return null;
	const pct = (value: number, of: number) => `${(value / of) * 100}%`;
	return {
		left: pct(fragment.x - 2, current.width),
		top: pct(fragment.y, current.height),
		width: pct(fragment.width + 4, current.width),
		height: pct(fragment.lineHeight, current.height),
	};
});

const busy = ref(false);
async function run(action: () => Promise<unknown>, successKey: string | null, failKey: string) {
	busy.value = true;
	try {
		const done = await action();
		if (successKey && done !== false) showToast(t(successKey), 'success');
	} catch {
		showToast(t(failKey), 'error');
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<UiModal :open="true" :title="t(`${P}.title`)" size="3xl" @update:open="!$event && emit('close')">
		<div class="flex flex-wrap items-center gap-3 mb-3">
			<UiSegmentedControl
				v-model="scheme"
				size="sm"
				:options="schemeOptions"
				:aria-label="t(`${P}.schemeLabel`)"
			/>
			<UiSegmentedControl
				v-model="style"
				size="sm"
				:options="styleOptions"
				:aria-label="t(`${P}.styleLabel`)"
			/>
			<span class="flex-1" />
			<UiButton variant="secondary" size="sm" type="button" @click="share.hidePersonalDetails()">
				<EyeOffIcon class="w-4 h-4 mr-1.5" />
				{{ t(`${P}.hidePersonal`) }}
			</UiButton>
			<UiButton
				variant="ghost"
				size="sm"
				type="button"
				:disabled="redacted.size === 0"
				@click="share.clearRedactions()"
			>
				{{ t(`${P}.clear`) }}
			</UiButton>
		</div>
		<p class="text-xs text-text-tertiary mb-3">{{ t(`${P}.hint`) }}</p>

		<div class="max-h-[60vh] overflow-y-auto rounded border border-border-subtle bg-bg-surface p-3">
			<div v-if="!layout" class="flex items-center justify-center py-16">
				<UiSpinner size="md" />
				<span class="sr-only">{{ t(`${P}.loading`) }}</span>
			</div>
			<div v-show="layout" class="relative mx-auto max-w-[640px]">
				<canvas
					ref="canvasEl"
					data-share-card
					class="block w-full h-auto cursor-pointer rounded shadow-sm focus:outline-none"
					tabindex="0"
					role="application"
					:aria-label="t(`${P}.canvasLabel`)"
					:aria-describedby="activeWordId"
					@click="onCanvasClick"
					@keydown="onCanvasKeydown"
					@focus="canvasFocused = true"
					@blur="canvasFocused = false"
				/>
				<p :id="activeWordId" class="sr-only" aria-live="polite">
					{{ activeTokenAnnouncement }}
				</p>
				<div
					v-if="focusRing"
					class="pointer-events-none absolute rounded ring-2 ring-brand"
					:style="focusRing"
				/>
			</div>
		</div>
		<p v-if="card.truncated" class="text-xs text-text-tertiary mt-2">{{ t(`${P}.truncated`) }}</p>

		<div class="flex flex-wrap items-center gap-2 mt-4">
			<span class="text-sm text-text-secondary flex-1" aria-live="polite">
				{{ t(`${P}.hiddenCount`, { count: redacted.size }, redacted.size) }}
			</span>
			<UiButton
				v-if="share.canShare"
				variant="secondary"
				type="button"
				:disabled="!layout || busy"
				@click="run(share.share, null, `${P}.shareFailed`)"
			>
				<ShareIcon class="w-4 h-4 mr-1.5" />
				{{ t(`${P}.share`) }}
			</UiButton>
			<UiButton
				variant="secondary"
				type="button"
				:disabled="!layout || busy"
				@click="run(share.save, null, `${P}.saveFailed`)"
			>
				<DownloadIcon class="w-4 h-4 mr-1.5" />
				{{ t(`${P}.save`) }}
			</UiButton>
			<UiButton
				v-if="share.canCopy"
				type="button"
				:disabled="!layout || busy"
				@click="run(share.copy, `${P}.copied`, `${P}.copyFailed`)"
			>
				<CopyIcon class="w-4 h-4 mr-1.5" />
				{{ t(`${P}.copy`) }}
			</UiButton>
		</div>
	</UiModal>
</template>
