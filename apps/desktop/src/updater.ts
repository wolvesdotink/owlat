/**
 * Desktop auto-updater bridge.
 *
 * Thin wrapper over the `updater_*` Tauri commands (src-tauri/src/updater.rs).
 * The check, the download and the restart are three separate steps here because
 * the endpoint is chosen by the web layer — it asks the active workspace which
 * version to install — and because the app now shows progress and offers a
 * restart instead of silently applying an update on next launch.
 *
 * Nothing is swallowed: every command rejects with an {@link UpdateError}
 * carrying a kind, so the caller can stay quiet about a flaky network and still
 * say something about a bundle that failed its signature check.
 */
import { invoke, Channel } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type UpdateErrorKind = 'network' | 'signature' | 'unknown';

/**
 * A failed updater command. Rust rejects with `"<kind>: <message>"` (see
 * `updater_error` there); `error` is that kind, `message` the rest.
 */
export class UpdateError extends Error {
	readonly error: UpdateErrorKind;

	constructor(error: UpdateErrorKind, message: string) {
		super(message);
		this.name = 'UpdateError';
		this.error = error;
	}
}

const ERROR_KINDS: UpdateErrorKind[] = ['network', 'signature', 'unknown'];

function isKind(value: string): value is UpdateErrorKind {
	return (ERROR_KINDS as string[]).includes(value);
}

/** Turn whatever a rejected `invoke` produced into a typed {@link UpdateError}. */
export function toUpdateError(cause: unknown): UpdateError {
	const raw = typeof cause === 'string' ? cause : ((cause as Error)?.message ?? String(cause));
	const split = raw.indexOf(': ');
	if (split > 0) {
		const kind = raw.slice(0, split);
		if (isKind(kind)) return new UpdateError(kind, raw.slice(split + 2));
	}
	return new UpdateError('unknown', raw);
}

export interface UpdateCheckResult {
	version: string;
	/** Release notes from the manifest, when it carries any. */
	notes?: string;
}

export type UpdateProgress =
	/** `contentLength` is absent when the server sent no `Content-Length`. */
	| { kind: 'started'; contentLength?: number }
	| { kind: 'progress'; chunkLength: number }
	| { kind: 'finished' };

/**
 * The Tauri updater endpoint for an instance: its manifest route, with the
 * placeholders the updater substitutes per machine. Only the origin of
 * `siteUrl` is used, so a workspace stored with a path or a trailing slash
 * still produces the one canonical URL.
 */
export function buildUpdateEndpoint(siteUrl: string): string {
	const { origin } = new URL(siteUrl);
	return `${origin}/api/desktop/update/{{target}}/{{arch}}/{{current_version}}`;
}

/**
 * Check for an update. `null` uses the GitHub endpoint compiled into the app
 * (no workspace, an instance that does not manage updates, or a plain-http dev
 * server); a string points the check at that instance instead.
 *
 * Resolves to `null` when there is nothing to install — including the case
 * where the instance is deliberately holding this client where it is.
 */
export async function checkForUpdate(endpoint: string | null): Promise<UpdateCheckResult | null> {
	try {
		const found = await invoke<{ version: string; notes?: string | null } | null>('updater_check', {
			endpoint,
		});
		if (!found) return null;
		return { version: found.version, ...(found.notes ? { notes: found.notes } : {}) };
	} catch (e) {
		throw toUpdateError(e);
	}
}

/**
 * Download and install the update the last check found, reporting progress.
 * The bytes are verified against the app's minisign public key by the plugin
 * before anything is written, whoever named the release.
 */
export async function installUpdate(onProgress: (event: UpdateProgress) => void): Promise<void> {
	const channel = new Channel<UpdateProgress>();
	channel.onmessage = onProgress;
	try {
		await invoke('updater_install', { onEvent: channel });
	} catch (e) {
		throw toUpdateError(e);
	}
}

/** Relaunch into the freshly installed version. Does not return on success. */
export async function restartApp(): Promise<void> {
	try {
		await invoke('updater_restart');
	} catch (e) {
		throw toUpdateError(e);
	}
}

/**
 * Show the native "update ready" notification. macOS and Linux render the
 * `actionLabel` button and emit the restart request picked up by
 * {@link onUpdateRestartRequest}; every other target shows a plain
 * notification and leaves the restart to the in-app button.
 *
 * Resolves `false` when the command is unavailable (an older shell), so the
 * caller can fall back to a plain notification rather than say nothing.
 */
export async function notifyUpdateReady(
	title: string,
	body: string,
	actionLabel: string
): Promise<boolean> {
	try {
		await invoke('updater_notify_ready', { title, body, actionLabel });
		return true;
	} catch (e) {
		console.warn('[desktop] Update notification failed:', e);
		return false;
	}
}

/** Subscribe to "Restart now" chosen from the native notification. */
export async function onUpdateRestartRequest(cb: () => void): Promise<UnlistenFn | null> {
	try {
		return await listen<{ action: string }>('updater-action', (e) => {
			if (e.payload.action === 'restart') cb();
		});
	} catch (e) {
		console.warn('[desktop] Could not listen for update actions:', e);
		return null;
	}
}
