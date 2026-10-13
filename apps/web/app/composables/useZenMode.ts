import { readonly, ref } from 'vue';

/**
 * Zen mode: one task, nothing else on screen. The dashboard layout drops the
 * sidebar, the header, the breadcrumbs and the phone tab bar, and each surface
 * narrows itself to the work in front of it (the Postbox shows the open
 * conversation full width, a team thread drops its side cards, the Workbench
 * keeps only what needs an answer).
 *
 * One app-wide flag, deliberately separate from the email builder's focus mode
 * (`useFocusMode`): the builder owns that one (its own button, overlay and Esc)
 * and resets it when the editor unmounts, while Zen outlives navigation — j/k
 * through a mailbox must not drop out of it. It is kept for the tab's session
 * (sessionStorage), so a reload in Zen stays in Zen and a new tab starts calm
 * but not hidden.
 *
 * Enter and leave with Cmd/Ctrl+Shift+F (`global.zen`), the header's Zen
 * button, the avatar menu or ⌘K; leave with "Exit Zen" in the slim bar Zen
 * keeps at the top, or with Esc once nothing above Zen wants it (see
 * `ShellZenExit`).
 */

const ZEN_STORAGE_KEY = 'owlat:zen';

const isZen = ref(false);
let hydrated = false;

function persist(on: boolean) {
	try {
		if (on) sessionStorage.setItem(ZEN_STORAGE_KEY, '1');
		else sessionStorage.removeItem(ZEN_STORAGE_KEY);
	} catch {
		// Storage blocked (private mode, quota): Zen still works for this page.
	}
}

export function useZenMode() {
	if (typeof window !== 'undefined' && !hydrated) {
		hydrated = true;
		try {
			isZen.value = sessionStorage.getItem(ZEN_STORAGE_KEY) === '1';
		} catch {
			isZen.value = false;
		}
	}

	function setZen(on: boolean) {
		if (isZen.value === on) return;
		isZen.value = on;
		persist(on);
	}

	return {
		isZen: readonly(isZen),
		enterZen: () => setZen(true),
		exitZen: () => setZen(false),
		toggleZen: () => setZen(!isZen.value),
	};
}
