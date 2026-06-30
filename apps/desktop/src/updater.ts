/**
 * Desktop auto-updater.
 *
 * Checks for updates on startup and provides a non-blocking notification
 * when a new version is available.
 */
import { check } from '@tauri-apps/plugin-updater';

export interface UpdateResult {
	/** A newer version was downloaded and will apply on next restart. */
	updated: boolean;
	version?: string;
}

/**
 * Check for updates and install if available. Returns the new version when one
 * was downloaded (apply on next restart). Update signing requires a real
 * `updater.pubkey` in tauri.conf.json (generate with `tauri signer generate`);
 * with an empty pubkey `check()` rejects and this resolves to `{ updated: false }`.
 */
export async function checkForUpdates(): Promise<UpdateResult> {
	try {
		const update = await check();
		if (update) {
			console.info(`[desktop] Update available: v${update.version}`);
			await update.downloadAndInstall();
			return { updated: true, version: update.version };
		}
		console.info('[desktop] App is up to date');
		return { updated: false };
	} catch (e) {
		// Silently handle update check failures — don't block the app.
		console.warn('[desktop] Update check failed:', e);
		return { updated: false };
	}
}
