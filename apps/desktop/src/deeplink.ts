/**
 * Deep-link bridge.
 *
 * Surfaces both the cold-start URL (`getCurrent`) and live URLs while running
 * (`onOpenUrl`) so the web app can handle `owlat://auth?...` (login handshake),
 * `owlat://thread/...` (navigation) and `mailto:` (default mail handler).
 */
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';

/** URLs the app was launched with (cold start), if any. */
export async function getInitialDeepLinks(): Promise<string[]> {
	try {
		return (await getCurrent()) ?? [];
	} catch (e) {
		console.warn('[desktop] getCurrent deep links failed:', e);
		return [];
	}
}

/** Subscribe to deep links delivered while the app is already running. */
export async function onDeepLink(cb: (urls: string[]) => void): Promise<void> {
	try {
		await onOpenUrl(cb);
	} catch (e) {
		console.warn('[desktop] onOpenUrl registration failed:', e);
	}
}
