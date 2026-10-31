import { onMounted, onUnmounted } from 'vue';

/**
 * Wire the advertised `s` (Save) shortcut to an editor's save while it is
 * mounted. The shortcut is registered with `ignoreInputs`, so it never fires
 * while a text field is focused; `canSave` additionally no-ops it when
 * nothing changed or a save is already in flight.
 */
export function useEditorSaveShortcut(canSave: () => boolean, save: () => Promise<void>): void {
	const { registerSaveShortcut, unregisterShortcut } = useKeyboardShortcuts();
	onMounted(() => {
		registerSaveShortcut(() => {
			if (canSave()) void save();
		});
	});
	onUnmounted(() => {
		unregisterShortcut('global.save');
	});
}
