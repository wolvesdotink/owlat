/**
 * Launch-at-login bridge (tauri-plugin-autostart).
 */
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';

export async function getAutostartEnabled(): Promise<boolean> {
	try {
		return await isEnabled();
	} catch {
		return false;
	}
}

export async function setAutostartEnabled(on: boolean): Promise<void> {
	try {
		if (on) await enable();
		else await disable();
	} catch (e) {
		console.warn('[desktop] autostart toggle failed:', e);
	}
}
