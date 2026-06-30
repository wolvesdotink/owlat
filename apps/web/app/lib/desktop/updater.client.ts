/**
 * Desktop auto-update bridge (mirrors deepLink.client.ts). Runs in the actual
 * webview — the previous `apps/desktop/src/main.ts` caller was imported nowhere,
 * so the updater never ran. No-op outside Tauri.
 */

/** Check for an update; notify on install (or, when asked, on already-current). */
export async function runUpdateCheck(opts?: { announce?: boolean }): Promise<void> {
	try {
		const { checkForUpdates } = await import('@owlat/desktop/src/updater');
		const { sendDesktopNotification } = await import('@owlat/desktop/src/notifications');
		const res = await checkForUpdates();
		if (res.updated) {
			await sendDesktopNotification(
				'Update ready',
				`Owlat ${res.version ?? ''} will be applied the next time you restart.`.replace(/\s+/g, ' ').trim()
			);
		} else if (opts?.announce) {
			await sendDesktopNotification('Owlat is up to date', 'You have the latest version.');
		}
	} catch {
		// Not running under Tauri.
	}
}

/**
 * Register update handling: a non-blocking check on boot, plus a manual trigger
 * (the native menu / command palette dispatch `owlat:check-updates`).
 */
export function setupUpdateChecks(): void {
	void runUpdateCheck();
	if (typeof window !== 'undefined') {
		window.addEventListener('owlat:check-updates', () => void runUpdateCheck({ announce: true }));
	}
}
