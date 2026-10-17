<script setup lang="ts">
/**
 * "Why here?" (read on arrival §4.1): one popover that answers from the
 * thread's arrival record (`api.mail.arrival.explain.forThread`): who sent it
 * and how often you open their mail, what decided the placement, its kind,
 * whether it waits for a reply, how deeply it was read and what that cost.
 *
 * Buttons: "That's wrong" opens Fix; "Always here" keeps mail from this
 * sender where this one is (a sender-scope Fix with the current placement);
 * "Senders page" goes to the sender list. Reasons arrive as keys and render
 * from `postbox.<key>`; a key this build has no copy for is left out.
 *
 * Anchored to the element the click came from (the strip link, the header,
 * a Priority row's hover button), below it or flipped above when there is no
 * room; Esc and a click elsewhere close it.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { Placement } from '@owlat/shared/arrival';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import type { PostboxWhyHereTarget } from '~/composables/postbox/usePostboxWhyHere';
import {
	destinationForPlacement,
	usePostboxFixApply,
	type PostboxFixTarget,
} from '~/composables/postbox/usePostboxArrivalExplain';
import { useLocalized } from '~/composables/useLocalized';
import { isAnchorInView, placeAnchoredPanel } from '~/utils/anchoredPanelPlacement';

const target = defineModel<PostboxWhyHereTarget | null>('target', { required: true });
const emit = defineEmits<{ fix: [target: PostboxFixTarget] }>();

const { t, te } = useI18n();
const titleId = useId();
const panel = ref<HTMLElement | null>(null);

const isOpen = computed({
	get: () => target.value !== null,
	set: (value: boolean) => {
		if (!value) target.value = null;
	},
});
useEscapeToClose(isOpen);
useClickOutside([panel, computed(() => target.value?.anchor ?? null)], () => {
	isOpen.value = false;
});

// Focus moves into the popover when it opens and back where it came from when
// it closes (the anchor, else what had focus), so keyboard and screen-reader
// users land in it and are not stranded behind it.
let returnFocus: HTMLElement | null = null;
function restoreFocus(anchor: HTMLElement | null) {
	for (const el of [anchor, returnFocus]) {
		if (!el?.isConnected) continue;
		// An anchor scrolled out of view takes focus where it is, without
		// scrolling the page back to it.
		el.focus({ preventScroll: true });
		if (document.activeElement === el) break;
	}
	returnFocus = null;
}
watch(
	() => target.value,
	async (next, previous) => {
		if (next && !previous) {
			returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			await nextTick();
			panel.value?.focus();
		} else if (!next && previous) {
			restoreFocus(previous.anchor);
		}
	},
	{ immediate: true }
);

const { data: why, isLoading } = useConvexQuery(api.mail.arrival.explain.forThread, () =>
	target.value ? { threadId: target.value.threadId as Id<'mailThreads'> } : 'skip'
);

/**
 * Under the anchor; above it when there is no room below (a lower row on a
 * short window); capped with internal scroll when it fits on neither side.
 * Centred near the top without an anchor. Placed once the panel has rendered
 * (it is measured), again when the record arrives (it grows), and on resize
 * and on any scroll outside the panel, always inside the window. An anchor
 * that a scroll or resize took out of the window closes the popover rather
 * than leaving it pointing at nothing. Written straight onto the element: a
 * reactive style would re-render the panel right after it took focus.
 */
const PANEL_WIDTH = 352;
function place() {
	const el = panel.value;
	if (!el || !target.value) return;
	const anchor = target.value.anchor;
	const viewport = { width: window.innerWidth, height: window.innerHeight };
	const width = Math.min(PANEL_WIDTH, viewport.width - 16);
	const style = anchor?.isConnected
		? placeAnchoredPanel({
				anchor: anchor.getBoundingClientRect(),
				panelHeight: el.scrollHeight,
				panelWidth: PANEL_WIDTH,
				viewport,
			}).style
		: { top: '15vh', left: `${(viewport.width - width) / 2}px`, maxHeight: 'calc(85vh - 8px)' };
	Object.assign(el.style, { top: '', bottom: '', ...style });
}
watch([() => target.value, panel, () => why.value, () => isLoading.value], place, {
	immediate: true,
	flush: 'post',
});
function onViewportChange(event: Event) {
	if (!target.value) return;
	// Scrolling the panel's own content moves nothing it is anchored to.
	if (
		event.type === 'scroll' &&
		event.target instanceof Node &&
		panel.value?.contains(event.target)
	)
		return;
	const anchor = target.value.anchor;
	const viewport = { width: window.innerWidth, height: window.innerHeight };
	if (anchor?.isConnected && !isAnchorInView(anchor.getBoundingClientRect(), viewport)) {
		target.value = null;
		return;
	}
	place();
}
// Capture: a scroll inside any container (the list column) never bubbles to window.
const SCROLL_OPTIONS = { capture: true, passive: true } as const;
onMounted(() => {
	window.addEventListener('resize', onViewportChange);
	window.addEventListener('scroll', onViewportChange, SCROLL_OPTIONS);
});
onBeforeUnmount(() => {
	window.removeEventListener('resize', onViewportChange);
	window.removeEventListener('scroll', onViewportChange, SCROLL_OPTIONS);
});

const placement = computed<Placement | undefined>(
	() => why.value?.placement ?? target.value?.placement
);
const title = computed(() =>
	placement.value
		? t(`postbox.explain.title.${placement.value}`)
		: t('postbox.explain.titleUnknown')
);
const senderName = computed(() => why.value?.sender.displayName || why.value?.sender.address || '');

const senderLine = computed(() => {
	const sender = why.value?.sender;
	if (!sender) return '';
	if (sender.delivered === undefined)
		return `${senderName.value} · ${t('postbox.explain.noStats')}`;
	const stats = t(
		'postbox.explain.senderStats',
		{ count: sender.delivered, opened: sender.opened ?? 0 },
		sender.delivered
	);
	return `${senderName.value} · ${stats}`;
});

const decidedLine = computed(() => {
	const value = why.value;
	if (!value) return '';
	if (value.decidedBy === 'sender_status' && value.sender.status) {
		const status = t(`postbox.explain.status.${value.sender.status}`);
		const source = value.sender.statusSource ?? 'default';
		return t(`postbox.explain.decided.senderStatus.${source}`, { status });
	}
	return t(`postbox.explain.decided.${value.decidedBy}`);
});

const kindLine = computed(() => {
	const category = why.value?.category;
	if (!category) return null;
	return `${t(`postbox.senders.kind.${category.label}`)} · ${t(`postbox.explain.categorySource.${category.source}`)}`;
});

const readAsLine = computed(() => {
	const value = why.value;
	if (!value) return '';
	const depth = t(`postbox.explain.depth.${value.depth ?? 'pending'}`);
	const calls = t('postbox.explain.modelCalls', { count: value.modelCalls }, value.modelCalls);
	return `${depth} · ${calls}`;
});

const localized = useLocalized();
const reasonLines = computed(() =>
	(why.value?.reasons ?? [])
		.filter((reason) => te(`postbox.${reason.key}`))
		.map((reason) => localized({ ...reason, key: `postbox.${reason.key}` }))
);

function openFix() {
	const value = why.value;
	if (!value) return;
	emit('fix', {
		messageId: value.messageId,
		senderName: senderName.value,
		...(value.placement ? { placement: value.placement } : {}),
	});
	target.value = null;
}

const { apply, isApplying } = usePostboxFixApply();
async function keepHere() {
	const value = why.value;
	if (!value) return;
	const isApplied = await apply({
		messageId: value.messageId,
		destination: destinationForPlacement(value.placement),
		scope: 'sender',
		senderName: senderName.value,
	});
	if (isApplied) target.value = null;
}
</script>

<template>
	<Teleport to="body">
		<div
			v-if="target"
			ref="panel"
			role="dialog"
			tabindex="-1"
			:aria-labelledby="titleId"
			class="fixed z-50 w-[22rem] max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain rounded-xl border border-border-subtle bg-bg-elevated p-4 text-sm shadow-lg outline-none"
			data-testid="why-here-popover"
		>
			<h3 :id="titleId" class="mb-3 font-semibold text-text-primary">{{ title }}</h3>
			<p v-if="isLoading && !why" class="text-text-tertiary">{{ t('postbox.explain.loading') }}</p>
			<p v-else-if="!why" class="text-text-secondary" data-testid="why-here-empty">
				{{ t('postbox.explain.empty') }}
			</p>
			<template v-else>
				<dl class="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5">
					<dt class="text-text-tertiary">{{ t('postbox.explain.label.sender') }}</dt>
					<dd class="text-text-primary" data-testid="why-here-sender">{{ senderLine }}</dd>
					<dt class="text-text-tertiary">{{ t('postbox.explain.label.decidedBy') }}</dt>
					<dd class="text-text-primary" data-testid="why-here-decided">{{ decidedLine }}</dd>
					<template v-if="kindLine">
						<dt class="text-text-tertiary">{{ t('postbox.explain.label.kind') }}</dt>
						<dd class="text-text-primary">{{ kindLine }}</dd>
					</template>
					<template v-if="why.isReplyNeeded">
						<dt class="text-text-tertiary">{{ t('postbox.explain.label.reply') }}</dt>
						<dd class="text-text-primary">{{ t('postbox.explain.replyNeeded') }}</dd>
					</template>
					<dt class="text-text-tertiary">{{ t('postbox.explain.label.readAs') }}</dt>
					<dd class="text-text-primary" data-testid="why-here-read-as">{{ readAsLine }}</dd>
				</dl>
				<ul
					v-if="reasonLines.length > 0"
					class="mt-3 list-disc space-y-0.5 pl-4 text-xs text-text-secondary"
					data-testid="why-here-reasons"
				>
					<li v-for="line in reasonLines" :key="line">{{ line }}</li>
				</ul>
				<p v-if="why.isFenced" class="mt-2 text-xs text-text-tertiary">
					{{ t('postbox.explain.fenced') }}
				</p>
			</template>
			<div class="mt-4 flex items-center gap-2">
				<template v-if="why">
					<UiButton size="sm" variant="secondary" data-testid="why-here-wrong" @click="openFix">
						{{ t('postbox.explain.action.wrong') }}
					</UiButton>
					<UiButton
						size="sm"
						variant="ghost"
						:loading="isApplying"
						data-testid="why-here-always"
						@click="keepHere"
					>
						{{ t('postbox.explain.action.always') }}
					</UiButton>
				</template>
				<NuxtLink
					to="/dashboard/postbox/senders"
					class="ml-auto text-xs text-brand hover:underline"
					data-testid="why-here-senders"
					@click="target = null"
				>
					{{ t('postbox.explain.action.senders') }}
				</NuxtLink>
			</div>
		</div>
	</Teleport>
</template>
