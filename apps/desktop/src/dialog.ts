/**
 * Native file-picker dialogs (tauri-plugin-dialog).
 */
import { open } from '@tauri-apps/plugin-dialog';
import { homeDir, join } from '@tauri-apps/api/path';

/**
 * Open the system file picker to choose an SSH private key. Starts in
 * `~/.ssh` when it exists (the picker falls back to the last-used location
 * otherwise). Resolves to the absolute path, or null if the user cancelled.
 */
export async function pickSshKeyFile(): Promise<string | null> {
	let defaultPath: string | undefined;
	try {
		defaultPath = await join(await homeDir(), '.ssh');
	} catch {
		// Home directory resolution failed — let the picker use its default.
	}
	const picked = await open({
		title: 'Choose an SSH private key',
		multiple: false,
		directory: false,
		defaultPath,
	});
	return typeof picked === 'string' ? picked : null;
}
