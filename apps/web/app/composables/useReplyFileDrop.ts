/**
 * Drop files on a conversation to reply with them (see utils/replyFileDrop).
 *
 * Three parts share module state:
 *  - `vReplyDrop` marks an element (a list row, the reader) as the drop target
 *    for one conversation and handles the browser's drag events on it;
 *  - `useReplyDropHost` runs once in the dashboard shell: it draws the hint,
 *    takes desktop (Tauri) window drops, and turns a drop into queued files
 *    plus the navigation into Answer mode;
 *  - `useReplyDropDelivery` runs on the Answer mode pages and hands the queued
 *    files to the reply's own attachment pipeline, once.
 *
 * Module state rather than `useState`: it holds `File` objects and callbacks,
 * there is only ever one drag in the air, and none of it may be serialised.
 */
import type { Directive } from 'vue';
import { isNavigationFailure } from 'vue-router';
import { useAnswerModeNav } from '~/composables/useAnswerMode';
import { osFileDropClaimed } from '~/composables/useDropZone';
import { useDesktopContext } from '~/composables/useDesktopContext';
import {
	createReplyDropQueue,
	draggedFileCount,
	isFileDrag,
	type ReplyDropRef,
	type ReplyDropTarget,
} from '~/utils/replyFileDrop';

/** The conversation under a file drag right now, and where to draw the hint. */
export interface ReplyDropHover {
	target: ReplyDropTarget;
	/** Files in the drag, or null when the platform does not say. */
	count: number | null;
	rect: { top: number; left: number; width: number; height: number };
}

const hover = shallowRef<ReplyDropHover | null>(null);
/** The element the hover belongs to: a leave or a claim elsewhere clears only its own. */
let hoverEl: Element | null = null;

const queueVersion = ref(0);
const queue = createReplyDropQueue(() => {
	queueVersion.value += 1;
});

const targets = new WeakMap<Element, ReplyDropTarget>();

/** The host's drop handler; no host mounted means drops are left alone. */
let dropHandler: ((target: ReplyDropTarget, files: File[]) => void) | null = null;

const DROP_ATTR = 'data-reply-drop';

function showHover(el: Element, target: ReplyDropTarget, count: number | null) {
	const box = el.getBoundingClientRect();
	// A tall reader scrolls past the viewport: the hint centres on what is visible.
	const top = Math.max(box.top, 0);
	const bottom = Math.min(box.bottom, window.innerHeight);
	hoverEl = el;
	hover.value = {
		target,
		count,
		rect: { top, left: box.left, width: box.width, height: Math.max(bottom - top, 0) },
	};
}

function clearHover(el?: Element) {
	if (el && hoverEl !== el) return;
	hoverEl = null;
	hover.value = null;
}

function onDragOver(event: DragEvent) {
	const el = event.currentTarget as HTMLElement;
	const target = targets.get(el);
	if (!target || !isFileDrag(event.dataTransfer)) return;
	// An inner zone (a composer's own drop area) already took this drag.
	if (event.defaultPrevented) {
		clearHover(el);
		return;
	}
	event.preventDefault();
	if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
	showHover(el, target, draggedFileCount(event.dataTransfer));
}

function onDragLeave(event: DragEvent) {
	const el = event.currentTarget as HTMLElement;
	// Moving onto a child of the target is not leaving it.
	const into = event.relatedTarget;
	if (into instanceof Node && el.contains(into)) return;
	clearHover(el);
}

function onDrop(event: DragEvent) {
	const el = event.currentTarget as HTMLElement;
	const target = targets.get(el);
	if (!target || event.defaultPrevented || !isFileDrag(event.dataTransfer)) return;
	event.preventDefault();
	clearHover();
	const files = Array.from(event.dataTransfer?.files ?? []);
	if (files.length > 0) dropHandler?.(target, files);
}

function bindTarget(el: HTMLElement, target: ReplyDropTarget | null | undefined) {
	if (target) {
		targets.set(el, target);
		el.setAttribute(DROP_ATTR, '');
	} else {
		targets.delete(el);
		el.removeAttribute(DROP_ATTR);
		clearHover(el);
	}
}

/**
 * `v-reply-drop="target"`: the element takes a file drop as a reply to
 * `target`; null (a draft, a reply that cannot carry files) leaves it inert.
 * The value is re-read on every update, so a recycled virtual-list row always
 * answers for the conversation it shows now.
 */
export const vReplyDrop: Directive<HTMLElement, ReplyDropTarget | null | undefined> = {
	mounted(el, binding) {
		bindTarget(el, binding.value);
		el.addEventListener('dragenter', onDragOver);
		el.addEventListener('dragover', onDragOver);
		el.addEventListener('dragleave', onDragLeave);
		el.addEventListener('drop', onDrop);
	},
	updated(el, binding) {
		bindTarget(el, binding.value);
	},
	beforeUnmount(el) {
		bindTarget(el, null);
		el.removeEventListener('dragenter', onDragOver);
		el.removeEventListener('dragover', onDragOver);
		el.removeEventListener('dragleave', onDragLeave);
		el.removeEventListener('drop', onDrop);
	},
};

/** The reply-drop target under a desktop drag at `position` (physical pixels). */
function targetAt(position: { x: number; y: number }): {
	el: Element;
	target: ReplyDropTarget;
} | null {
	if (osFileDropClaimed(position)) return null;
	const dpr = window.devicePixelRatio || 1;
	const hit = document.elementFromPoint(position.x / dpr, position.y / dpr);
	const el = hit?.closest(`[${DROP_ATTR}]`);
	const target = el ? targets.get(el) : undefined;
	return el && target ? { el, target } : null;
}

/**
 * The dashboard shell's half: one per app. Owns the hint, the desktop window
 * drops, the queue's lifetime (cleared when the signed-in account or workspace
 * changes) and the step from a drop to Answer mode.
 */
export function useReplyDropHost() {
	const answerNav = useAnswerModeNav();
	const { user, activeOrganizationId } = useAuth();

	async function open(target: ReplyDropTarget, files: File[]) {
		const id = queue.queue(target, files);
		try {
			const result =
				target.kind === 'message'
					? await answerNav.open(target.id, { kind: target.replyKind ?? null })
					: await answerNav.openTeam(target.id, { messageId: target.messageId ?? null });
			// A guard that stopped the navigation, or a newer one that replaced it.
			if (result === false || isNavigationFailure(result)) queue.remove(id);
		} catch {
			queue.remove(id);
		}
	}

	function drop(target: ReplyDropTarget, files: File[]) {
		if (target.guard) target.guard(() => void open(target, files));
		else void open(target, files);
	}

	watch(
		() => `${user.value?.id ?? ''}:${activeOrganizationId.value ?? ''}`,
		() => queue.clearAll()
	);

	// The drag ended somewhere else (Esc, a drop outside any target).
	const endDrag = () => clearHover();
	onMounted(() => {
		dropHandler = drop;
		window.addEventListener('dragend', endDrag);
		window.addEventListener('drop', endDrag);
	});
	onBeforeUnmount(() => {
		if (dropHandler === drop) dropHandler = null;
		window.removeEventListener('dragend', endDrag);
		window.removeEventListener('drop', endDrag);
		clearHover();
	});

	useDesktopReplyDrops(drop);

	return { hover: readonly(hover) };
}

/**
 * Tauri takes OS file drags itself, so the HTML5 events above never fire on
 * the desktop app: there the drop is placed by its window position. Where it
 * lands is settled as it lands, before the files are read, so a list that
 * re-renders during the read cannot send them to another conversation.
 */
function useDesktopReplyDrops(drop: (target: ReplyDropTarget, files: File[]) => void) {
	if (!useDesktopContext().isDesktop.value) return;
	let count: number | null = null;
	let landed: ReplyDropTarget | null = null;
	let stop: (() => void) | undefined;
	let disposed = false;

	onMounted(async () => {
		const { onWebviewFileDrop } = await import('@owlat/desktop/src/dialog');
		const unsubscribe = await onWebviewFileDrop({
			onEnter: (n) => {
				count = n > 0 ? n : null;
			},
			onOver: (position) => {
				const hit = targetAt(position);
				if (hit) showHover(hit.el, hit.target, count);
				else clearHover();
			},
			onLeave: () => {
				count = null;
				clearHover();
			},
			onDropStart: (position) => {
				landed = targetAt(position)?.target ?? null;
				clearHover();
			},
			onDrop: (files) => {
				const target = landed;
				landed = null;
				count = null;
				if (target && files.length > 0) drop(target, files);
			},
		});
		if (disposed) unsubscribe();
		else stop = unsubscribe;
	});
	onBeforeUnmount(() => {
		disposed = true;
		stop?.();
	});
}

/**
 * The Answer mode page's half: hands the files dropped on its conversation to
 * `deliver` once the reply can take them (`deliver` returns null until then).
 * Each file is delivered once. `refused` says the conversation turned out not
 * to take files (a Team reply on another channel): what waits is dropped and
 * `onRefused` runs. Leaving the page, or moving it to another conversation,
 * forgets what it did not take, so no later visit picks up stale files.
 */
export function useReplyDropDelivery(opts: {
	target: () => ReplyDropRef | null;
	deliver: () => ((files: File[]) => unknown) | null;
	refused?: () => boolean;
	onRefused?: () => void;
}) {
	watch(
		[() => opts.target(), () => opts.deliver(), () => opts.refused?.() ?? false, queueVersion],
		([target, deliver, refused], [before]) => {
			if (before && (!target || before.kind !== target.kind || before.id !== target.id)) {
				queue.clear(before);
			}
			if (!target) return;
			if (refused) {
				if (queue.clear(target)) opts.onRefused?.();
				return;
			}
			if (!deliver) return;
			const files = queue.take(target);
			if (files.length > 0) deliver(files);
		},
		{ immediate: true }
	);
	onBeforeUnmount(() => {
		const target = opts.target();
		if (target) queue.clear(target);
	});
}
