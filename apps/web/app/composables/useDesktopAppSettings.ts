/**
 * Device-scoped desktop app settings (the /desktop/settings surface).
 *
 * Module-level reactive singleton over `settings.json` (tauri-plugin-store,
 * via the apps/desktop settings.ts bridge) — the same shared-state pattern as
 * useDesktopWorkspaces. Reads normalize through `normalizeDesktopSettings`,
 * so consumers always see a complete, typed shape. Writes debounce briefly
 * (coalescing toggle bursts) with a pagehide flush; `pruneWorkspaceSettings`
 * persists immediately because its caller reloads the webview right after.
 *
 * Outside the Tauri runtime the same state round-trips through localStorage,
 * keeping the settings page developable in a plain browser.
 */
import { isDesktopRuntime } from "~/lib/desktop/activeWorkspace";
import {
	defaultDesktopSettings,
	defaultWorkspaceLocalSettings,
	normalizeDesktopSettings,
	type DesktopSettings,
	type GlobalDesktopSettings,
	type WorkspaceLocalSettings,
} from "~/lib/desktop/settingsTypes";

/** localStorage fallback key for the non-Tauri (browser dev) runtime. */
const WEB_FALLBACK_KEY = "owlat:desktop-settings";

const SAVE_DEBOUNCE_MS = 250;

// ---- module-level reactive state (shared across all callers) ----
const settings = ref<DesktopSettings>(defaultDesktopSettings());
const isReady = ref(false);
let loadPromise: Promise<void> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let flushOnHide = false;

type SettingsBridge = typeof import("@owlat/desktop/src/settings");

async function bridge(): Promise<SettingsBridge> {
	return import("@owlat/desktop/src/settings");
}

async function hydrate(): Promise<void> {
	let raw: unknown = null;
	if (isDesktopRuntime()) {
		try {
			raw = await (await bridge()).loadSettingsStore();
		} catch {
			// Bridge unavailable — fall through to defaults.
		}
	} else if (typeof localStorage !== "undefined") {
		try {
			const stored = localStorage.getItem(WEB_FALLBACK_KEY);
			raw = stored ? JSON.parse(stored) : null;
		} catch {
			// Corrupt fallback — defaults.
		}
	}
	settings.value = normalizeDesktopSettings(raw);
	isReady.value = true;
}

/**
 * Ensure the singleton is hydrated and return the current settings. For
 * non-component callers (boot plugin, updater) that need a read before any
 * settings UI mounts.
 */
export async function loadDesktopAppSettings(): Promise<DesktopSettings> {
	loadPromise ??= hydrate();
	await loadPromise;
	return settings.value;
}

async function persistNow(): Promise<void> {
	if (saveTimer !== null) {
		clearTimeout(saveTimer);
		saveTimer = null;
	}
	const snapshot = JSON.parse(JSON.stringify(settings.value)) as DesktopSettings;
	if (isDesktopRuntime()) {
		try {
			await (await bridge()).saveSettingsStore(snapshot);
		} catch {
			// Best-effort; the in-memory state is still authoritative this session.
		}
	} else if (typeof localStorage !== "undefined") {
		try {
			localStorage.setItem(WEB_FALLBACK_KEY, JSON.stringify(snapshot));
		} catch {
			// localStorage unavailable/full — settings just don't survive reload.
		}
	}
}

function persistSoon(): void {
	if (saveTimer !== null) clearTimeout(saveTimer);
	saveTimer = setTimeout(() => void persistNow(), SAVE_DEBOUNCE_MS);
	// A toggle followed by an immediate quit/reload would lose the debounced
	// write — flush whatever is pending when the document goes away.
	if (!flushOnHide && typeof window !== "undefined") {
		flushOnHide = true;
		window.addEventListener("pagehide", () => {
			if (saveTimer !== null) void persistNow();
		});
	}
}

/**
 * Drop a removed workspace's device-local settings (and its startup pin, if
 * set). Persists immediately — the removal flow reloads the webview right
 * after, which would swallow a debounced write.
 */
export async function pruneWorkspaceSettings(workspaceId: string): Promise<void> {
	await loadDesktopAppSettings();
	const { [workspaceId]: _dropped, ...rest } = settings.value.workspaces;
	settings.value.workspaces = rest;
	if (settings.value.global.startupWorkspaceId === workspaceId) {
		settings.value.global.startupWorkspaceId = null;
	}
	await persistNow();
}

export function useDesktopAppSettings() {
	loadPromise ??= hydrate();

	function setGlobal<K extends keyof GlobalDesktopSettings>(
		key: K,
		value: GlobalDesktopSettings[K],
	): void {
		settings.value.global[key] = value;
		persistSoon();
	}

	/** Device-local settings for one workspace (defaults when never touched). */
	function workspaceLocal(workspaceId: string): WorkspaceLocalSettings {
		return settings.value.workspaces[workspaceId] ?? defaultWorkspaceLocalSettings();
	}

	function setWorkspaceLocal<K extends keyof WorkspaceLocalSettings>(
		workspaceId: string,
		key: K,
		value: WorkspaceLocalSettings[K],
	): void {
		settings.value.workspaces = {
			...settings.value.workspaces,
			[workspaceId]: { ...workspaceLocal(workspaceId), [key]: value },
		};
		persistSoon();
	}

	return {
		settings: readonly(settings),
		isReady: readonly(isReady),
		setGlobal,
		workspaceLocal,
		setWorkspaceLocal,
	};
}
