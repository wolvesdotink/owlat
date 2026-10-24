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
 *
 * Input policy follows the chord, not the command: a single key never fires
 * while a text field, editor or IME composition has the keyboard, and a
 * Cmd/Ctrl/Alt chord does unless its registration opts out with
 * `ignoreInputs`. The remapping rules keep that true for remaps too: a
 * single-key command can only be given another single key, a chord command
 * only another chord (`utils/shortcutCapture.ts`).
 *
 * A new window or document `keydown` listener in apps/web is a lint error
 * (`owlat/no-raw-keydown-listener`): bind a catalog id here instead, or give
 * the listener a suppression that says why it cannot be.
 */

import { onScopeDispose } from 'vue';
import { isHelpOverlayClaimed } from '~/utils/helpOverlayOwnership';
import { isImeComposing } from '~/utils/imeComposition';
import { chordFromEvent } from '~/utils/shortcutRegistry';
import {
	activeShortcutScopes,
	beginChord,
	clearPendingChord,
	isActiveChordPrefix,
	pendingChordStep,
	resolveActiveChord,
	shortcutBindings,
} from '~/utils/shortcutScope';
import { SHORTCUT_CATALOG } from '~/utils/shortcutCatalog';

/**
 * Gets the press, for the few commands one id covers several keys of (1 to 9
 * pick the option with that number).
 */
type ShortcutHandler = (event: KeyboardEvent) => void;

interface ShortcutConfig {
	/** A catalog id (`utils/shortcutCatalog.ts`), never a raw key. */
	id: string;
	handler: ShortcutHandler;
	/**
	 * If true, only triggers when no input/textarea is focused. Single keys
	 * never fire in a field anyway; this matters for Cmd/Ctrl/Alt chords.
	 */
	ignoreInputs?: boolean;
	/**
	 * Whether the command can run right now. While it says no the press is not
	 * claimed (no preventDefault) and the next older registration of the same id
	 * gets a look — a panel open over a page can take `j` for as long as it is
	 * open, without unregistering the page's own handler.
	 */
	when?: (event: KeyboardEvent) => boolean;
}

// Each composable owns its registrations. The newest live owner wins; releasing
// it restores the previous owner rather than deleting somebody else's handler.
const shortcuts = new Map<string, { owner: symbol; config: ShortcutConfig }[]>();
const isHelpModalOpen = ref(false);

// The app-wide "?" sheet is a catalog id like any other, so a remap of
// `global.help` moves it. A surface with its own cheat sheet (the Postbox)
// claims the overlay while it is mounted, and this one stands down: otherwise
// both would open on the same press (utils/helpOverlayOwnership.ts).
shortcuts.set('global.help', [
	{
		owner: Symbol('app-wide cheat sheet'),
		config: {
			id: 'global.help',
			handler: () => {
				isHelpModalOpen.value = !isHelpModalOpen.value;
			},
			when: () => !isHelpOverlayClaimed(),
		},
	},
]);

// Track whether the composable has been initialized
let isInitialized = false;

function isEditable(el: EventTarget | null): boolean {
	if (!(el instanceof Element)) return false;
	const tagName = el.tagName.toLowerCase();
	if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') return true;
	return (
		(el as HTMLElement).isContentEditable === true || el.getAttribute('contenteditable') === 'true'
	);
}

/**
 * True while a text field, editor or select has the keyboard: the focused
 * element, or the element the press was aimed at (a key sent to a field that
 * has not taken focus yet still belongs to it).
 */
function isInputFocused(event?: KeyboardEvent): boolean {
	return isEditable(document.activeElement) || isEditable(event?.target ?? null);
}

/**
 * Fire the newest live registration of `id` whose `when` allows it. Reports
 * whether anything ran.
 */
function dispatch(id: string | null, event: KeyboardEvent): boolean {
	if (!id) return false;
	const entries = shortcuts.get(id) ?? [];
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const config = (entries[index] as { config: ShortcutConfig }).config;
		if (config.when && !config.when(event)) continue;
		if (config.ignoreInputs && isInputFocused(event)) return false;
		event.preventDefault();
		config.handler(event);
		return true;
	}
	return false;
}

/**
 * Handle global keydown events
 */
function handleGlobalKeydown(event: KeyboardEvent) {
	if (event.defaultPrevented || isImeComposing(event)) return;
	// A Cmd/Ctrl/Alt chord is claimed only when a live handler is bound to the
	// id it resolves to. The rest stay with the browser, the OS and the surfaces
	// that answer their own (⌘K palette, ⌘1–9 workspaces, the composer's
	// ⌘Enter), and a half-typed sequence chord is left alone.
	if (event.ctrlKey || event.metaKey || event.altKey) {
		dispatch(resolveActiveChord(chordFromEvent(event), activeShortcutScopes()), event);
		return;
	}

	const scopes = activeShortcutScopes();

	// Escape is processed even from a text field: closing things is its job,
	// and a surface's own Escape (Answer mode lets go of the editor first)
	// decides what that means there. The nearest scope's Escape goes first; when
	// nothing there takes it, the app-wide close does.
	if (event.key === 'Escape') {
		clearPendingChord();
		if (isHelpModalOpen.value) {
			event.preventDefault();
			isHelpModalOpen.value = false;
			return;
		}
		const scoped = resolveActiveChord('Escape', scopes);
		if (scoped !== 'global.close' && dispatch(scoped, event)) return;
		dispatch('global.close', event);
		return;
	}

	// Single keys never fire while a field has the keyboard.
	if (isInputFocused(event)) {
		return;
	}

	const step = chordFromEvent(event);

	// Second half of a sequence chord (`g` then …). Always consumes the key,
	// whether or not the pair is bound — a half-typed `g` must not leak into a
	// single-key action. The buffer lives in `shortcutScope` so element-level
	// handlers (the thread list) can stand down for exactly this press instead
	// of triaging on the same key.
	const held = pendingChordStep();
	if (held) {
		clearPendingChord();
		// preventDefault BEFORE dispatching, and whether or not the pair resolves:
		// the pending buffer is already cleared by the time window-level handlers
		// see this press, so `defaultPrevented` is the only signal left telling
		// them the key was the tail of a chord.
		event.preventDefault();
		dispatch(resolveActiveChord(`${held} ${step}`, scopes), event);
		return;
	}

	if (dispatch(resolveActiveChord(step, scopes), event)) return;

	// Not a shortcut on its own, but the start of one: hold it briefly.
	if (isActiveChordPrefix(step, scopes)) {
		event.preventDefault();
		beginChord(step);
	}
}

/**
 * Initialize the global keyboard listener
 */
function initializeKeyboardShortcuts() {
	if (isInitialized || import.meta.server) return;

	// oxlint-disable-next-line owlat/no-raw-keydown-listener -- the app-wide dispatcher every catalog shortcut goes through
	document.addEventListener('keydown', handleGlobalKeydown);
	isInitialized = true;
}

export function useKeyboardShortcuts() {
	const owner = Symbol('shortcut owner');
	const ownedIds = new Set<string>();
	let disposed = false;
	onScopeDispose(() => {
		disposed = true;
		for (const id of ownedIds) unregisterShortcut(id);
	});

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
		if (disposed) return;
		unregisterShortcut(config.id);
		const entries = shortcuts.get(config.id) ?? [];
		entries.push({ owner, config });
		shortcuts.set(config.id, entries);
		ownedIds.add(config.id);
	}

	/** Release a catalog id's handler. */
	function unregisterShortcut(id: string) {
		const entries = shortcuts.get(id)?.filter((entry) => entry.owner !== owner);
		if (entries?.length) shortcuts.set(id, entries);
		else shortcuts.delete(id);
		ownedIds.delete(id);
	}

	/**
	 * Register default navigation shortcuts
	 */
	function registerNavigationShortcuts() {
		const router = useRouter();
		const routes: Record<string, string> = {
			'global.goToDashboard': '/dashboard',
			'global.goToAnswer': '/dashboard/answer',
			'global.goToContacts': '/dashboard/audience/contacts',
			'global.goToEmails': '/dashboard/send',
			'global.goToAutomations': '/dashboard/automations',
			// g+m opens the Marketing workspace on its overview.
			'global.goToCampaigns': '/dashboard/marketing',
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
		return SHORTCUT_CATALOG.filter((def) => shortcuts.has(def.id)).map((def) => ({
			id: def.id,
			keys: [...(shortcutBindings.value.byId.get(def.id) ?? [])],
			description: def.labelKey,
		}));
	}

	/**
	 * Register context-aware 'new' shortcut.
	 * Call this in page setup/onMounted; scope disposal releases it automatically.
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
