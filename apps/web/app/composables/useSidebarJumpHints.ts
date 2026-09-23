import type { InjectionKey, Ref } from 'vue';
import { isEditableTarget } from '~/utils/postboxShortcuts';

/**
 * Jump to the first nine conversations in the sidebar with Alt+1…9.
 *
 * Holding Alt for a moment shows the numbers on the rows (a quick chord never
 * flashes them). ⌘1–9 is already the desktop app's workspace switcher, so the
 * sidebar takes Alt instead. The order is the rows' visual order: whatever is
 * rendered with `data-sidebar-jump` inside the sidebar root, top to bottom.
 */
export interface SidebarJumpHints {
	show: Ref<boolean>;
	/** Row key → 1-based jump number (only while `show`). */
	labels: Ref<ReadonlyMap<string, number>>;
}

export const SIDEBAR_JUMP_HINTS: InjectionKey<SidebarJumpHints> = Symbol('sidebar-jump-hints');

const HINT_DELAY_MS = 150;
const MAX_JUMPS = 9;

function jumpTargets(root: HTMLElement | null): HTMLElement[] {
	if (!root) return [];
	return Array.from(root.querySelectorAll<HTMLElement>('[data-sidebar-jump]'))
		.filter((el) => el.offsetParent !== null)
		.slice(0, MAX_JUMPS);
}

export function useSidebarJumpHints(root: Ref<HTMLElement | null>): SidebarJumpHints {
	const show = ref(false);
	const labels = ref<ReadonlyMap<string, number>>(new Map());
	let timer: ReturnType<typeof setTimeout> | null = null;

	const refreshLabels = () => {
		labels.value = new Map(
			jumpTargets(root.value).map((el, index) => [el.dataset['sidebarJump'] ?? '', index + 1])
		);
	};
	const hide = () => {
		if (timer) clearTimeout(timer);
		timer = null;
		show.value = false;
	};

	const onKeydown = (event: KeyboardEvent) => {
		if (event.key === 'Alt' && !event.repeat) {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				refreshLabels();
				show.value = true;
			}, HINT_DELAY_MS);
			return;
		}
		if (!event.altKey || event.metaKey || event.ctrlKey) return;
		const match = /^Digit([1-9])$/.exec(event.code);
		if (!match || isEditableTarget(event.target)) return;
		const target = jumpTargets(root.value)[Number(match[1]) - 1];
		if (!target) return;
		event.preventDefault();
		hide();
		target.click();
	};
	const onKeyup = (event: KeyboardEvent) => {
		if (event.key === 'Alt') hide();
	};

	onMounted(() => {
		window.addEventListener('keydown', onKeydown);
		window.addEventListener('keyup', onKeyup);
		window.addEventListener('blur', hide);
	});
	onBeforeUnmount(() => {
		hide();
		window.removeEventListener('keydown', onKeydown);
		window.removeEventListener('keyup', onKeyup);
		window.removeEventListener('blur', hide);
	});

	const hints = { show, labels };
	provide(SIDEBAR_JUMP_HINTS, hints);
	return hints;
}
