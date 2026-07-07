/**
 * Composable for managing global keyboard shortcuts throughout the app.
 *
 * Supports:
 * - Single key shortcuts (?, n, s)
 * - Chord shortcuts (g+c, g+e, g+a)
 * - Escape key for closing modals
 */

type ShortcutHandler = () => void;

interface ShortcutConfig {
	key: string;
	handler: ShortcutHandler;
	description?: string;
	/** If true, only triggers when no input/textarea is focused */
	ignoreInputs?: boolean;
}

// Global state for shortcuts
const shortcuts = ref<Map<string, ShortcutConfig>>(new Map());
const isHelpModalOpen = ref(false);
const chordBuffer = ref<string | null>(null);
const chordTimeout = ref<ReturnType<typeof setTimeout> | null>(null);

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

/**
 * Handle global keydown events
 */
function handleGlobalKeydown(event: KeyboardEvent) {
	// Don't handle if modifier keys are pressed (except for chord sequences)
	if (event.ctrlKey || event.metaKey || event.altKey) {
		return;
	}

	const key = event.key.toLowerCase();

	// Handle ? for help modal (needs shift)
	if (event.shiftKey && key === '?') {
		if (!isInputFocused()) {
			event.preventDefault();
			isHelpModalOpen.value = !isHelpModalOpen.value;
			return;
		}
	}

	// Handle Escape - always process for closing modals
	if (key === 'escape') {
		if (isHelpModalOpen.value) {
			event.preventDefault();
			isHelpModalOpen.value = false;
			return;
		}

		// Check for registered escape handler
		const escapeConfig = shortcuts.value.get('escape');
		if (escapeConfig) {
			event.preventDefault();
			escapeConfig.handler();
			return;
		}
		return;
	}

	// Skip if input is focused (for most shortcuts)
	if (isInputFocused()) {
		return;
	}

	// Handle chord sequences (g+key)
	if (chordBuffer.value === 'g') {
		// Clear the chord timeout
		if (chordTimeout.value) {
			clearTimeout(chordTimeout.value);
			chordTimeout.value = null;
		}

		const chordKey = `g+${key}`;
		const config = shortcuts.value.get(chordKey);
		if (config) {
			event.preventDefault();
			config.handler();
		}

		chordBuffer.value = null;
		return;
	}

	// Start chord sequence with 'g'
	if (key === 'g') {
		event.preventDefault();
		chordBuffer.value = 'g';

		// Clear chord after 500ms if no follow-up key
		chordTimeout.value = setTimeout(() => {
			chordBuffer.value = null;
		}, 500);
		return;
	}

	// Handle single key shortcuts
	const config = shortcuts.value.get(key);
	if (config) {
		if (config.ignoreInputs && isInputFocused()) {
			return;
		}
		event.preventDefault();
		config.handler();
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
	 * Register a keyboard shortcut
	 */
	function registerShortcut(config: ShortcutConfig) {
		shortcuts.value.set(config.key, config);
	}

	/**
	 * Unregister a keyboard shortcut
	 */
	function unregisterShortcut(key: string) {
		shortcuts.value.delete(key);
	}

	/**
	 * Register default navigation shortcuts
	 */
	function registerNavigationShortcuts() {
		// g+d - Go to Dashboard
		registerShortcut({
			key: 'g+d',
			handler: () => router.push('/dashboard'),
			description: 'Go to Dashboard',
			ignoreInputs: true,
		});

		// g+c - Go to Contacts
		registerShortcut({
			key: 'g+c',
			handler: () => router.push('/dashboard/audience/contacts'),
			description: 'Go to Contacts',
			ignoreInputs: true,
		});

		// g+e - Go to Emails
		registerShortcut({
			key: 'g+e',
			handler: () => router.push('/dashboard/send'),
			description: 'Go to Emails',
			ignoreInputs: true,
		});

		// g+a - Go to Automations
		registerShortcut({
			key: 'g+a',
			handler: () => router.push('/dashboard/automations'),
			description: 'Go to Automations',
			ignoreInputs: true,
		});

		// g+m - Go to Campaigns (m for marketing)
		registerShortcut({
			key: 'g+m',
			handler: () => router.push('/dashboard/campaigns'),
			description: 'Go to Campaigns',
			ignoreInputs: true,
		});

		// g+t - Go to Transactional
		registerShortcut({
			key: 'g+t',
			handler: () => router.push('/dashboard/send/transactional'),
			description: 'Go to Transactional',
			ignoreInputs: true,
		});

		// g+s - Go to Settings
		registerShortcut({
			key: 'g+s',
			handler: () => router.push('/dashboard/settings'),
			description: 'Go to Settings',
			ignoreInputs: true,
		});
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
	 * Get all registered shortcuts for display
	 */
	function getRegisteredShortcuts() {
		return Array.from(shortcuts.value.entries()).map(([key, config]) => ({
			key,
			description: config.description || key,
		}));
	}

	/**
	 * Register context-aware 'n' (new) shortcut
	 * Call this in page onMounted, pass cleanup function in onUnmounted
	 */
	function registerNewShortcut(handler: ShortcutHandler) {
		registerShortcut({
			key: 'n',
			handler,
			description: 'New item',
			ignoreInputs: true,
		});
	}

	/**
	 * Register context-aware 's' (save) shortcut
	 * Call this in page/component onMounted for forms/editors
	 */
	function registerSaveShortcut(handler: ShortcutHandler) {
		registerShortcut({
			key: 's',
			handler,
			description: 'Save',
			ignoreInputs: true,
		});
	}

	/**
	 * Register escape handler for closing modals/panels
	 */
	function registerEscapeHandler(handler: ShortcutHandler) {
		registerShortcut({
			key: 'escape',
			handler,
			description: 'Close / Cancel',
		});
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
