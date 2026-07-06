/**
 * Manual connection-code fallback for the desktop sign-in handshake.
 *
 * The happy path hands the one-time token back via the `owlat://auth` deep
 * link, but that link cannot always be delivered — macOS only routes custom
 * schemes to a *bundled, Launch-Services-registered* app (so `tauri dev`
 * binaries never receive it), and some browsers refuse to open custom schemes
 * at all. As a fallback, /desktop/connect displays the same payload as a
 * copyable code the user pastes into the desktop app's connect form.
 *
 * Format: `<state>:<ott>` — the CSRF state nonce the desktop minted for this
 * handshake, then the one-time token. The token is base64url (no `:`), but we
 * still split on the FIRST separator so a future token alphabet change can't
 * corrupt the parse.
 */

export function formatConnectionCode(state: string, ott: string): string {
	return `${state}:${ott}`;
}

export function parseConnectionCode(raw: string): { state: string; ott: string } | null {
	const trimmed = raw.trim();
	const sep = trimmed.indexOf(':');
	if (sep === -1) return null;
	const state = trimmed.slice(0, sep);
	const ott = trimmed.slice(sep + 1);
	if (!state || !ott) return null;
	return { state, ott };
}
