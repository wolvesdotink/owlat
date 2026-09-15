/**
 * What the desktop app is currently doing about updates, as one module-level
 * reactive singleton (the same shape as `useDesktopAppSettings`).
 *
 * The update run itself lives in `lib/desktop/updater.client.ts` — a boot
 * plugin and a `window` event listener, neither of which is a component — so
 * the progress it produces has nowhere component-shaped to live. This is that
 * place: the run writes, the Updates card on the device page reads, and a card
 * that mounts halfway through a download still shows the download.
 *
 * Deliberately has no fetching of its own. Anything here was put here by the
 * run; a component that mounts before the first check sees `idle`.
 */
import type { UpdateProgress } from '@owlat/desktop/src/updater';

export type DesktopUpdatePhase =
	| 'idle'
	| 'checking'
	| 'downloading'
	| 'ready'
	| 'upToDate'
	| 'error';

/** The failure kinds the Rust bridge distinguishes (see apps/desktop/src/updater.ts). */
export type DesktopUpdateErrorKind = 'network' | 'signature' | 'unknown';

/** `GET /api/desktop/update-policy` — what the active instance offers. */
export interface DesktopUpdatePolicySummary {
	mode: 'latest' | 'pinned' | 'paused';
	channel: 'stable' | 'prerelease';
	pinnedVersion: string | null;
	requiredVersion: string | null;
	deferHours: number;
	latestVersion: string | null;
	latestPublishedAt: number | null;
	checkedAt: number | null;
}

/**
 * Who decided which version this app installs: the instance it is connected to,
 * or GitHub's latest release (no workspace, a non-https workspace, or an
 * instance that predates server-managed updates).
 */
export type DesktopUpdateSource =
	| { kind: 'github' }
	| { kind: 'server'; host: string; policy: DesktopUpdatePolicySummary };

const phase = ref<DesktopUpdatePhase>('idle');
const version = ref<string | null>(null);
const notes = ref<string | null>(null);
const downloadedBytes = ref(0);
const totalBytes = ref<number | null>(null);
const errorKind = ref<DesktopUpdateErrorKind | null>(null);
const lastCheckedAt = ref<number | null>(null);
const source = ref<DesktopUpdateSource | null>(null);

export function useDesktopUpdateState() {
	/** Null while the download's total size is unknown (no `Content-Length`). */
	const percent = computed<number | null>(() => {
		const total = totalBytes.value;
		if (!total || total <= 0) return null;
		return Math.min(100, Math.round((downloadedBytes.value / total) * 100));
	});

	function setSource(next: DesktopUpdateSource): void {
		source.value = next;
	}

	function markChecking(): void {
		phase.value = 'checking';
		errorKind.value = null;
	}

	function markUpToDate(at: number = Date.now()): void {
		phase.value = 'upToDate';
		version.value = null;
		notes.value = null;
		lastCheckedAt.value = at;
	}

	function markDownloading(next: string, releaseNotes?: string): void {
		phase.value = 'downloading';
		version.value = next;
		notes.value = releaseNotes ?? null;
		downloadedBytes.value = 0;
		totalBytes.value = null;
		lastCheckedAt.value = Date.now();
	}

	/** Fold one streamed progress event into the counters. */
	function applyProgress(event: UpdateProgress): void {
		if (event.kind === 'started') {
			downloadedBytes.value = 0;
			totalBytes.value = event.contentLength ?? null;
			return;
		}
		if (event.kind === 'progress') {
			downloadedBytes.value += event.chunkLength;
		}
	}

	function markReady(next: string): void {
		phase.value = 'ready';
		version.value = next;
		// A finished download has, by definition, fetched everything there was;
		// snap the bar to full so a missing Content-Length cannot leave it short.
		if (totalBytes.value !== null) downloadedBytes.value = totalBytes.value;
	}

	function markFailed(kind: DesktopUpdateErrorKind): void {
		phase.value = 'error';
		errorKind.value = kind;
		lastCheckedAt.value = Date.now();
	}

	return {
		phase: readonly(phase),
		version: readonly(version),
		notes: readonly(notes),
		downloadedBytes: readonly(downloadedBytes),
		totalBytes: readonly(totalBytes),
		errorKind: readonly(errorKind),
		lastCheckedAt: readonly(lastCheckedAt),
		source: readonly(source),
		percent,
		setSource,
		markChecking,
		markUpToDate,
		markDownloading,
		applyProgress,
		markReady,
		markFailed,
	};
}
