<script lang="ts">
/**
 * A styled tooltip for the one control in its default slot:
 *
 *     <UiTooltip :text="t('reader.archive')">
 *       <button :aria-label="t('reader.archive')" @click="archive">…</button>
 *     </UiTooltip>
 *
 * Unlike the native `title` it replaces, it opens on keyboard focus as well as
 * on hover, stays while the pointer moves onto it, closes on Escape, and can
 * show the control's shortcut (`shortcut="E"` or a `#shortcut` slot, which is
 * where an app's own shortcut chip goes).
 *
 * UiTooltip renders the control itself as its root, with no wrapper element,
 * so the control's layout, classes, refs, listeners and modifiers are
 * untouched, attributes given to UiTooltip land on the control, and a
 * component whose root is a UiTooltip still has that control as its `$el` (and
 * can still sit inside a `<Transition>`). The bubble is mounted into its own
 * container on `<body>` only while it is open.
 *
 * The tooltip describes the control; it is never its name. An icon-only
 * control still needs its own `aria-label`, because the tooltip is not in the
 * DOM until it opens and never opens on touch.
 */
import {
	Comment,
	Fragment,
	Text,
	cloneVNode,
	defineComponent,
	getCurrentInstance,
	h,
	onBeforeUnmount,
	onMounted,
	onUpdated,
	ref,
	render,
	shallowRef,
	useId,
	type PropType,
	type VNode,
} from 'vue';
import { useEscapeLayer } from '../../composables/useEscapeLayer';
import { placeTooltip } from '../../utils/tooltipPlacement';
import {
	TOOLTIP_CLOSE_DELAY_MS,
	claimTooltip,
	releaseTooltip,
	tooltipOpenDelay,
} from '../../utils/tooltipDelay';

/** A slot entry that renders something (not a `v-if` placeholder or template whitespace). */
function renders(node: VNode): boolean {
	if (node.type === Comment) return false;
	if (node.type === Text) return String(node.children ?? '').trim() !== '';
	return true;
}

/** Keyboard focus, not the focus a click gives a button. */
function focusVisible(element: Element): boolean {
	try {
		return element.matches(':focus-visible');
	} catch {
		return true;
	}
}

type Placement = { top: number; left: number; side: 'top' | 'bottom' };

export default defineComponent({
	name: 'UiTooltip',
	inheritAttrs: false,
	props: {
		/** The tooltip's text. Without it (and without a `#content` slot) no tooltip opens. */
		text: { type: String, default: undefined },
		/** A shortcut shown beside the text, already formatted for the platform. */
		shortcut: { type: String, default: undefined },
		side: { type: String as PropType<'top' | 'bottom'>, default: 'top' },
		disabled: { type: Boolean, default: false },
	},
	setup(props, { slots, attrs }) {
		const id = `ui-tooltip-${useId()}`;
		const appContext = getCurrentInstance()?.appContext ?? null;
		const open = ref(false);
		const position = shallowRef<Placement | null>(null);
		// Bumped when UiTooltip re-renders while open, so the bubble (its own
		// render root) picks up slot content its parent replaced.
		const revision = ref(0);
		const bubble = ref<HTMLElement | null>(null);

		let triggerVNode: VNode | null = null;
		let trigger: HTMLElement | null = null;
		let host: HTMLElement | null = null;
		let openTimer: ReturnType<typeof setTimeout> | undefined;
		let closeTimer: ReturnType<typeof setTimeout> | undefined;
		let hovering = false;
		let focused = false;
		// A press (or an Escape) hides the tooltip until the pointer leaves or
		// focus moves on, so clicking a control does not bring its label back.
		let suppressed = false;
		let describedBy: { value: string | null } | null = null;

		const owner = { close: () => hide() };

		function hasContent(): boolean {
			return !props.disabled && (Boolean(props.text) || Boolean(slots['content']));
		}

		function clearTimers() {
			clearTimeout(openTimer);
			clearTimeout(closeTimer);
		}

		function show() {
			clearTimers();
			if (!hasContent() || !trigger || open.value) return;
			claimTooltip(owner);
			position.value = null;
			open.value = true;
			mountBubble();
			linkDescription();
			// Only while open: a page holds hundreds of closed tooltips.
			window.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
			window.addEventListener('resize', onViewportChange, { passive: true });
			place();
		}

		function hide() {
			clearTimers();
			if (!open.value) return;
			open.value = false;
			window.removeEventListener('scroll', onViewportChange, { capture: true });
			window.removeEventListener('resize', onViewportChange);
			unlinkDescription();
			unmountBubble();
			releaseTooltip(owner);
		}

		function scheduleOpen() {
			clearTimers();
			const delay = tooltipOpenDelay();
			if (delay === 0) show();
			else openTimer = setTimeout(show, delay);
		}

		function scheduleClose() {
			clearTimeout(openTimer);
			if (!open.value) return;
			clearTimeout(closeTimer);
			closeTimer = setTimeout(() => {
				if (!hovering && !focused) hide();
			}, TOOLTIP_CLOSE_DELAY_MS);
		}

		/**
		 * The tooltip describes the control while it is open. Not when it only
		 * repeats the control's name: "Archive, button, Archive" helps nobody.
		 */
		function linkDescription() {
			if (!trigger) return;
			const label = trigger.getAttribute('aria-label')?.trim();
			if (!slots['content'] && label && label === props.text?.trim()) return;
			const current = trigger.getAttribute('aria-describedby');
			describedBy = { value: current };
			trigger.setAttribute('aria-describedby', current ? `${current} ${id}` : id);
		}

		function unlinkDescription() {
			if (!describedBy || !trigger) return;
			if (describedBy.value === null) trigger.removeAttribute('aria-describedby');
			else trigger.setAttribute('aria-describedby', describedBy.value);
			describedBy = null;
		}

		function place() {
			if (!open.value || !trigger || !bubble.value) return;
			const next = placeTooltip({
				anchor: trigger.getBoundingClientRect(),
				width: bubble.value.offsetWidth,
				height: bubble.value.offsetHeight,
				viewport: { width: window.innerWidth, height: window.innerHeight },
				side: props.side,
			});
			const current = position.value;
			if (current?.top === next.top && current.left === next.left && current.side === next.side)
				return;
			position.value = next;
		}

		function onPointerEnter(event: PointerEvent) {
			// A tap is the control's action, never a request for its label.
			if (event.pointerType === 'touch') return;
			hovering = true;
			if (!suppressed) scheduleOpen();
		}

		function onPointerLeave(event: PointerEvent) {
			if (event.pointerType === 'touch') return;
			hovering = false;
			suppressed = false;
			scheduleClose();
		}

		function onPointerDown() {
			suppressed = true;
			hide();
		}

		function onFocusIn() {
			focused = true;
			if (suppressed || !trigger || !focusVisible(trigger)) return;
			show();
		}

		function onFocusOut(event: FocusEvent) {
			const next = event.relatedTarget;
			if (next instanceof Node && trigger?.contains(next)) return;
			focused = false;
			if (!hovering) {
				suppressed = false;
				hide();
			}
		}

		function onBubbleEnter() {
			hovering = true;
			clearTimeout(closeTimer);
		}

		function onBubbleLeave() {
			hovering = false;
			scheduleClose();
		}

		// A scroll or resize moves the control out from under a fixed bubble.
		function onViewportChange() {
			hide();
		}

		const listeners = [
			['pointerenter', onPointerEnter],
			['pointerleave', onPointerLeave],
			['pointerdown', onPointerDown],
			['focusin', onFocusIn],
			['focusout', onFocusOut],
		] as const;

		function bind(next: HTMLElement | null) {
			if (next === trigger) return;
			if (trigger) {
				hide();
				for (const [type, listener] of listeners)
					trigger.removeEventListener(type, listener as EventListener);
			}
			trigger = next;
			hovering = false;
			focused = false;
			suppressed = false;
			if (!trigger) return;
			for (const [type, listener] of listeners)
				trigger.addEventListener(type, listener as EventListener);
		}

		/** The control's element: the slot's element, or the root element of its component. */
		function sync() {
			const element = triggerVNode?.el;
			bind(element instanceof HTMLElement ? element : null);
			if (open.value) {
				revision.value += 1;
				place();
			}
		}

		onMounted(sync);
		onUpdated(sync);
		onBeforeUnmount(() => {
			bind(null);
			clearTimers();
		});

		useEscapeLayer(open, () => {
			suppressed = true;
			hide();
		});

		function renderBubble(): VNode {
			const shortcut = slots['shortcut']
				? h('span', { class: 'ui-tooltip-shortcut empty:hidden' }, slots['shortcut']())
				: props.shortcut
					? h('kbd', { class: 'ui-tooltip-shortcut' }, props.shortcut)
					: null;
			const placed = position.value;
			return h(
				'div',
				{
					id,
					ref: bubble,
					role: 'tooltip',
					class:
						'ui-tooltip fixed z-(--z-tooltip) flex max-w-xs items-center gap-2 rounded-md border border-border-subtle bg-bg-elevated px-2 py-1 text-xs leading-snug text-text-primary shadow-md',
					'data-side': placed?.side ?? props.side,
					style: placed
						? { top: `${placed.top}px`, left: `${placed.left}px` }
						: { top: '0px', left: '0px', visibility: 'hidden' },
					onPointerenter: onBubbleEnter,
					onPointerleave: onBubbleLeave,
				},
				[h('span', { class: 'min-w-0' }, slots['content']?.() ?? props.text), shortcut]
			);
		}

		const Bubble = defineComponent({
			name: 'UiTooltipBubble',
			setup: () => () => {
				void revision.value;
				return renderBubble();
			},
		});

		function mountBubble() {
			host = document.createElement('div');
			document.body.appendChild(host);
			const vnode = h(Bubble);
			// The app's globals (components, i18n) for the slot content.
			vnode.appContext = appContext;
			render(vnode, host);
		}

		function unmountBubble() {
			if (!host) return;
			render(null, host);
			host.remove();
			host = null;
		}

		return () => {
			const children = slots['default']?.() ?? [];
			const index = children.findIndex(renders);
			triggerVNode = index === -1 ? null : cloneVNode(children[index]!, attrs);
			if (children.length === 1) return triggerVNode ?? children[0];
			const out = children.slice();
			if (triggerVNode) out[index] = triggerVNode;
			return h(Fragment, out);
		};
	},
});
</script>
