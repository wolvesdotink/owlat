/**
 * Compose-window bridge.
 *
 * `openCompose` asks the Rust side to open/focus the dedicated compose window
 * (used for `mailto:` links). `closeComposeWindow` lets the compose page close
 * itself after sending/discarding.
 */
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

export async function openCompose(path = '/compose'): Promise<void> {
	try {
		await invoke('open_compose', { path });
	} catch (e) {
		console.warn('[desktop] open compose failed:', e);
	}
}

export async function closeComposeWindow(): Promise<void> {
	try {
		await getCurrentWindow().close();
	} catch (e) {
		console.warn('[desktop] close compose failed:', e);
	}
}
