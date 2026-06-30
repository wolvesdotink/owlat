/**
 * Shell bridge — open a URL in the user's default system browser.
 *
 * Used for the sign-in handshake: the desktop opens the instance's
 * `/desktop/connect` page in the real browser (so cookies + existing login work)
 * and gets a one-time token back via the `owlat://auth` deep link.
 */
import { open } from '@tauri-apps/plugin-shell';

export async function openExternal(url: string): Promise<void> {
	await open(url);
}
