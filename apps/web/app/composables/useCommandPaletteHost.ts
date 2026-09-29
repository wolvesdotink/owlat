import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import {
	COMMAND_PALETTE_ASK_EVENT,
	COMMAND_PALETTE_OPEN_EVENT,
	type CommandPaletteOpenDetail,
	commandPaletteChord,
} from '~/composables/useCommandPalette';

/**
 * The dashboard layout's stand-in for `AppCommandPalette` until the palette is
 * first needed.
 *
 * The palette pulls in its providers, scopes and search composables, so the
 * layout no longer mounts it at boot. This composable holds the few listeners
 * that can open it — Cmd/Ctrl+K, Cmd/Ctrl+Shift+K (Ask), the shared open event
 * and the Ask verb's event — and on the first one flips `paletteRequested`,
 * remembering what was asked for in `paletteInitialOpen`. The layout then
 * mounts the lazy palette, which opens itself with that detail and emits
 * `ready` once its own listeners are attached; from then on the palette owns
 * every trigger and these listeners are gone.
 *
 * Between the request and `ready` (the palette chunk is loading) the listeners
 * stay up, so the chord keeps suppressing the browser's own Ctrl+K and a later
 * request replaces the pending one instead of being dropped.
 */
export function useCommandPaletteHost() {
	const { isEnabled } = useFeatureFlag();
	const paletteRequested = ref(false);
	const paletteInitialOpen = shallowRef<CommandPaletteOpenDetail | undefined>(undefined);
	let listening = false;

	// Same gate the palette's Ask scope uses: knowledge answers need the flag.
	const isAskAvailable = () => isEnabled('ai.knowledge');

	function request(detail: CommandPaletteOpenDetail) {
		paletteInitialOpen.value = detail;
		paletteRequested.value = true;
	}

	function onKeydown(event: KeyboardEvent) {
		const chord = commandPaletteChord(event);
		if (!chord) return;
		if (chord === 'ask') {
			if (!isAskAvailable()) return;
			event.preventDefault();
			request({ scope: 'ask' });
			return;
		}
		event.preventDefault();
		request({});
	}

	function onOpenEvent(event: Event) {
		request((event as CustomEvent<CommandPaletteOpenDetail>).detail ?? {});
	}

	function onAskEvent() {
		if (isAskAvailable()) request({ scope: 'ask' });
	}

	function detach() {
		if (!listening) return;
		listening = false;
		window.removeEventListener('keydown', onKeydown);
		window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpenEvent);
		window.removeEventListener(COMMAND_PALETTE_ASK_EVENT, onAskEvent);
	}

	onMounted(() => {
		listening = true;
		window.addEventListener('keydown', onKeydown);
		window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpenEvent);
		window.addEventListener(COMMAND_PALETTE_ASK_EVENT, onAskEvent);
	});
	onBeforeUnmount(detach);

	/** The palette is mounted and listening for itself: hand the triggers over. */
	function onPaletteReady() {
		detach();
	}

	return { paletteRequested, paletteInitialOpen, onPaletteReady };
}
