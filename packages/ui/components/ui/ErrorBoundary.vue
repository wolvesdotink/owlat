<script setup lang="ts">
/**
 * ErrorBoundary — keeps a failure inside the part of the page that failed. When
 * a component in the slot throws, the slot is replaced by a fallback with Retry
 * and the error stops here, so the rest of the page keeps working.
 *
 * Usage:
 *   <UiErrorBoundary :reset-keys="[messageId]">
 *     <YourComponent />
 *   </UiErrorBoundary>
 *
 * - `resetKeys`: a failed boundary renders its slot again once any key changes,
 *   so selecting another message recovers without a Retry. Keys are compared by
 *   value (`Object.is` per entry), never by array identity: a parent passing a
 *   fresh `[id]` literal on every render must not clear a failure.
 * - `capture`: which captured errors this boundary contains. Declined errors
 *   keep propagating to outer boundaries and the app's error handler.
 * - `#fallback="{ error, retry }"` replaces the default fallback markup, and
 *   with it the focus handling below: a custom fallback places focus itself.
 * - The default Retry button unmounts with the fallback it sits in, so after a
 *   Retry focus is placed deliberately instead of falling to <body>: on the
 *   first focusable element of the recovered content, else on the nearest
 *   focusable container around the boundary; after a re-failure, on the new
 *   Retry button. Focus the recovered content took itself (autofocus) stays.
 *
 * The boundary must sit around the component that may fail: a component cannot
 * catch its own setup or render failure.
 *
 * Single-node content is rendered as the boundary's own root, not inside a
 * fragment, so a boundary can be the root of a page under NuxtPage's
 * transition: the transition reaches the page's root element through it,
 * where a fragment root cannot be animated and breaks the page swap.
 */
import {
	Fragment,
	computed,
	getCurrentInstance,
	h,
	nextTick,
	onErrorCaptured,
	ref,
	watch,
	type FunctionalComponent,
	type VNode,
} from 'vue';
import { useUiI18n } from '../../composables/useUiI18n';

// `fallbackMessage` has no default: prop defaults are evaluated outside the
// setup context, where `useUiI18n()` cannot run. It is resolved below instead.
const props = withDefaults(
	defineProps<{
		/** Custom fallback message. Defaults to the localized copy. */
		fallbackMessage?: string;
		/** A second, quieter line under the message. */
		fallbackDetail?: string;
		/** Whether to show a retry button */
		showRetry?: boolean;
		/** Values whose change clears a captured failure. */
		resetKeys?: readonly unknown[];
		/** Return false to let an error pass through. Default: contain every error. */
		capture?: (error: unknown, info: string) => boolean;
		/** Names the boundary in the console line a captured error writes. */
		name?: string;
	}>(),
	{
		fallbackMessage: undefined,
		fallbackDetail: undefined,
		showRetry: true,
		resetKeys: undefined,
		capture: undefined,
		name: undefined,
	}
);

const emit = defineEmits<{
	/** A failure was contained (after it was logged). */
	captured: [error: unknown, info: string];
}>();

const slots = defineSlots<{
	default?: () => unknown;
	fallback?: (scope: { error: unknown; retry: () => void }) => unknown;
}>();

// Vue's patch flags for a v-for fragment (keyed or not). Its length follows
// the data, so unwrapping it would swap the root's shape, and remount the
// content, whenever the list grows from one entry to two. Negative flags are
// special markers (a slot outlet with dynamic content carries BAIL, -2), never
// a bit set.
const LIST_FRAGMENT = 128 | 256;

/**
 * Renders slot content as a single root when it is one node, looking through
 * the fragments `<slot>` outlets wrap content in (the way `<Transition>` reads
 * its child). Content of several nodes keeps its fragment. A compiled slot
 * returns the same number of nodes on every render, so the root's shape stays
 * stable and the content is never remounted by this.
 */
const SlotRoot: FunctionalComponent<{ nodes?: unknown }> = (rootProps) => {
	// A compiled slot returns an array; a hand-written one may return one node.
	const raw = rootProps.nodes;
	let nodes = (Array.isArray(raw) ? raw : raw == null ? [] : [raw]) as VNode[];
	while (nodes.length === 1) {
		const only = nodes[0]!;
		const isOutlet =
			only.type === Fragment &&
			Array.isArray(only.children) &&
			!(only.patchFlag > 0 && only.patchFlag & LIST_FRAGMENT);
		if (!isOutlet) return only;
		nodes = only.children as VNode[];
	}
	return h(Fragment, nodes);
};
SlotRoot.props = ['nodes'];

const { t } = useUiI18n();

const message = computed(() => props.fallbackMessage ?? t('ui.errorBoundary.message'));

// Boxed so a thrown `null` / `undefined` still counts as a failure.
const failure = ref<{ error: unknown } | null>(null);

onErrorCaptured((err: unknown, _instance, info: string) => {
	if (props.capture && !props.capture(err, info)) return;
	failure.value = { error: err };
	// Surface the error for debugging — the fallback UI hides it otherwise.
	console.error(`[ErrorBoundary${props.name ? `:${props.name}` : ''}] captured (${info}):`, err);
	emit('captured', err, info);
	// Return false to stop propagation to parent error handlers
	return false;
});

function sameKeys(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
	if (a === b) return true;
	if (!a || !b || a.length !== b.length) return false;
	return a.every((key, index) => Object.is(key, b[index]));
}

// Runs before the boundary re-renders, so content that fails again under the
// new keys is caught by that render rather than cleared by this watcher. The
// getter copies the entries: reading each one tracks it, so a key replaced in
// place inside a reactive array resets the boundary as a new array would.
watch(
	() => (props.resetKeys ? [...props.resetKeys] : undefined),
	(next, previous) => {
		if (failure.value && !sameKeys(previous, next)) failure.value = null;
	}
);

function retry() {
	failure.value = null;
}

// Called from the template, inside the boundary's render, as `<slot>` would be.
const content = () => slots.default?.();
const fallbackContent = (error: unknown) => slots.fallback?.({ error, retry });

const instance = getCurrentInstance();
const retryButton = ref<HTMLButtonElement | null>(null);

const FOCUSABLE = [
	'a[href]',
	'button:not([disabled])',
	'input:not([disabled]):not([type="hidden"])',
	'select:not([disabled])',
	'textarea:not([disabled])',
	'[contenteditable="true"]',
	'[tabindex]:not([tabindex="-1"])',
].join(',');

/** The top-level elements a rendered vnode put in the DOM. */
function elementsOf(vnode: VNode | null | undefined): Element[] {
	if (!vnode) return [];
	if (vnode.component) return elementsOf(vnode.component.subTree);
	if (vnode.type !== Fragment) return vnode.el instanceof Element ? [vnode.el] : [];
	const out: Element[] = [];
	for (let node = vnode.el as Node | null; node; node = node.nextSibling) {
		if (node instanceof Element) out.push(node);
		if (node === vnode.anchor) break;
	}
	return out;
}

function focusTargetAfterRetry(): HTMLElement | null {
	if (failure.value) return retryButton.value;
	const roots = elementsOf(instance?.subTree);
	for (const root of roots) {
		const target = root.matches(FOCUSABLE) ? root : root.querySelector(FOCUSABLE);
		if (target instanceof HTMLElement) return target;
	}
	const container = roots[0]?.parentElement?.closest('[tabindex]');
	return container instanceof HTMLElement ? container : null;
}

function retryFromButton() {
	retry();
	void nextTick(() => {
		const active = document.activeElement;
		if (active && active !== document.body) return;
		focusTargetAfterRetry()?.focus();
	});
}
</script>

<template>
	<SlotRoot v-if="!failure" :nodes="content()" />
	<SlotRoot v-else-if="slots.fallback" :nodes="fallbackContent(failure.error)" />
	<div v-else role="alert" class="p-6 border border-error/20 bg-error/5 rounded-lg text-center">
		<div class="flex flex-col items-center gap-3">
			<Icon name="lucide:alert-circle" class="w-8 h-8 text-error" />
			<p class="text-sm text-text-secondary">{{ message }}</p>
			<p v-if="fallbackDetail" class="text-xs text-text-tertiary">{{ fallbackDetail }}</p>
			<button
				v-if="showRetry"
				ref="retryButton"
				type="button"
				class="px-4 py-1.5 text-sm font-medium bg-bg-elevated border border-border-default rounded-md hover:bg-bg-base transition-colors"
				@click="retryFromButton"
			>
				{{ t('ui.actions.retry') }}
			</button>
		</div>
	</div>
</template>
