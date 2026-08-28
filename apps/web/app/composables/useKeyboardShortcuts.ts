/**
 * The app-wide keyboard dispatcher.
 *
 * It no longer owns a key map. Chords, scoping and conflict rules live in the
 * one registry (`utils/shortcutRegistry.ts` + `utils/shortcutCatalog.ts`); this
 * composable only binds catalog IDS to handlers and routes a keydown to
 * whichever id the registry says the press means under the scopes currently
 * claimed. That is what makes `g s` "go to Starred" inside the Postbox and "go
 * to Admin" everywhere else without either surface knowing about the other, and
 * what makes the cheat sheet impossible to drift: it is generated from the same
 * catalog this dispatcher resolves against.
 *
 * Sequence chords (`g` then a letter) are generic — a new one is a catalog line,
 * not a change here.
 */

import { isHelpOverlayClaimed } from '~/utils/helpOverlayOwnership';
import { chordFromEvent } from '~/utils/shortcutRegistry';
import {
	activeShortcutScopes,
	isActiveChordPrefix,
	resolveActiveChord,
	shortcutBindings,
} from '~/utils/shortcutScope';
import { SHORTCUT_CATALOG } from '~/utils/shortcutCatalog';

type ShortcutHandler = () => void;

interface ShortcutConfig {
	/** A catalog id (`utils/shortcutCatalog.ts`), never a raw key. */
	id: string;
	handler: ShortcutHandler;
	/** If true, only triggers when no input/textarea is focused */
	ignoreInputs?: boolean;
}

// Which catalog ids currently have a live handler. Module scope: registrations
// outlive the component that made them until it unregisters.
const shortcuts = ref<Map<string, ShortcutConfig>>(new Map());
const isHelpModalOpen = ref(false);
const chordBuffer = ref<string | null>(null);
const chordTimeout = ref<ReturnType<typeof setTimeout> | null>(null);

/** How long a half-finished sequence chord (`g` …) waits for its second key. */
const CHORD_WINDOW_MS = 500;

// Track whether the composable has been initialized
let isInitialized = false;

/**
 * Check if the current focus is on an input element
 */
function isInputFocused(): boolean {
	const activeElement = document.activeElement;
	if (!activeElement) return false;

	const tagName = activeElement.tagName.toLowerCase();
	if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
		return true;
	}

	// Check for contenteditable
	if (activeElement.getAttribute('contenteditable') === 'true') {
		return true;
	}

	return false;
}

function clearChord() {
	if (chordTimeout.value) {
		clearTimeout(chordTimeout.value);
		chordTimeout.value = null;
	}
	chordBuffer.value = null;
}

/** Fire the handler bound to `id`, if any. Reports whether anything ran. */
function dispatch(id: string | null, event: KeyboardEvent): boolean {
	if (!id) return false;
	const config = shortcuts.value.get(id);
	if (!config) return false;
	if (config.ignoreInputs && isInputFocused()) return false;
	event.preventDefault();
	config.handler();
	return true;
}

/**
 * Handle global keydown events
 */
function handleGlobalKeydown(event: KeyboardEvent) {
	// Modifier chords belong to the browser, the OS, and the surfaces that bind
	// their own listeners (⌘K palette, ⌘1–9 workspaces, the composer's ⌘Enter).
	// This dispatcher deliberately never claims one.
	if (event.ctrlKey || event.metaKey || event.altKey) {
		return;
	}

	const key = event.key.toLowerCase();

	// Handle ? for help modal (needs shift). A surface with its own cheat sheet
	// (Postbox) claims the key while it is mounted — otherwise both overlays open
	// on the same press. See utils/helpOverlayOwnership.ts.
	if (event.shiftKey && key === '?') {
		if (!isInputFocused() && !isHelpOverlayClaimed()) {
			event.preventDefault();
			isHelpModalOpen.value = !isHelpModalOpen.value;
			return;
		}
	}

	// Handle Escape - always process for closing modals
	if (key === 'escape') {
		clearChord();
		if (isHelpModalOpen.value) {
			event.preventDefault();
			isHelpModalOpen.value = false;
			return;
		}
		dispatch('global.close', event);
		return;
	}

	// Skip if input is focused (for most shortcuts)
	if (isInputFocused()) {
		return;
	}

	const scopes = activeShortcutScopes();
	const step = chordFromEvent(event);

	// Second half of a sequence chord (`g` then …). Always consumes the key,
	// whether or not the pair is bound — a half-typed `g` must not leak into a
	// single-key action.
	if (chordBuffer.value) {
		const pending = `${chordBuffer.value} ${step}`;
		clearChord();
		dispatch(resolveActiveChord(pending, scopes), event);
		return;
	}

	if (dispatch(resolveActiveChord(step, scopes), event)) return;

	// Not a shortcut on its own, but the start of one: hold it briefly.
	if (isActiveChordPrefix(step, scopes)) {
		event.preventDefault();
		chordBuffer.value = step;
		chordTimeout.value = setTimeout(clearChord, CHORD_WINDOW_MS);
	}
}

/**
 * Initialize the global keyboard listener
 */
function initializeKeyboardShortcuts() {
	if (isInitialized || import.meta.server) return;

	document.addEventListener('keydown', handleGlobalKeydown);
	isInitialized = true;
}

// Note: cleanup is automatic when using Vue's onMounted/onUnmounted
// If needed in the future, add a cleanup function export

export function useKeyboardShortcuts() {
	const router = useRouter();

	// Initialize on first use
	onMounted(() => {
		initializeKeyboardShortcuts();
	});

	/**
	 * Bind a handler to a catalog shortcut id. The keys are the registry's
	 * business — a caller that wants a different chord changes the catalog (or
	 * the user remaps it), not this call.
	 */
	function registerShortcut(config: ShortcutConfig) {
		shortcuts.value.set(config.id, config);
	}

	/** Release a catalog id's handler. */
	function unregisterShortcut(id: string) {
		shortcuts.value.delete(id);
	}

	/**
	 * Register default navigation shortcuts
	 */
	function registerNavigationShortcuts() {
		const routes: Record<string, string> = {
			'global.goToDashboard': '/dashboard',
			'global.goToContacts': '/dashboard/audience/contacts',
			'global.goToEmails': '/dashboard/send',
			'global.goToAutomations': '/dashboard/automations',
			'global.goToCampaigns': '/dashboard/campaigns',
			'global.goToTransactional': '/dashboard/send/transactional',
			// g+s routes to the administration area, not the preferences pages.
			'global.goToAdmin': '/dashboard/admin',
		};
		for (const [id, path] of Object.entries(routes)) {
			registerShortcut({ id, handler: () => router.push(path), ignoreInputs: true });
		}
	}

	/**
	 * Open the help modal
	 */
	function openHelpModal() {
		isHelpModalOpen.value = true;
	}

	/**
	 * Close the help modal
	 */
	function closeHelpModal() {
		isHelpModalOpen.value = false;
	}

	/**
	 * The catalog entries that currently have a live handler, with their chords
	 * already resolved. Used by tests to hold the dispatcher and the cheat sheet
	 * to the same list; the sheets themselves render from the catalog directly,
	 * because they document keys that are bound elsewhere too.
	 */
	function getRegisteredShortcuts() {
		return SHORTCUT_CATALOG.filter((def) => shortcuts.value.has(def.id)).map((def) => ({
			id: def.id,
			keys: [...(shortcutBindings.value.byId.get(def.id) ?? [])],
			description: def.labelKey,
		}));
	}

	/**
	 * Register context-aware 'new' shortcut.
	 * Call this in page onMounted, pass cleanup function in onUnmounted
	 */
	function registerNewShortcut(handler: ShortcutHandler) {
		registerShortcut({ id: 'global.newItem', handler, ignoreInputs: true });
	}

	/**
	 * Register context-aware 'save' shortcut.
	 * Call this in page/component onMounted for forms/editors
	 */
	function registerSaveShortcut(handler: ShortcutHandler) {
		registerShortcut({ id: 'global.save', handler, ignoreInputs: true });
	}

	/**
	 * Register escape handler for closing modals/panels
	 */
	function registerEscapeHandler(handler: ShortcutHandler) {
		registerShortcut({ id: 'global.close', handler });
	}

	return {
		isHelpModalOpen,
		registerShortcut,
		unregisterShortcut,
		registerNavigationShortcuts,
		registerNewShortcut,
		registerSaveShortcut,
		registerEscapeHandler,
		openHelpModal,
		closeHelpModal,
		getRegisteredShortcuts,
	};
}
