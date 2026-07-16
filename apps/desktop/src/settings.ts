/**
 * Desktop app-settings persistence bridge.
 *
 * Stores device-scoped preferences (update checks, notification toggles,
 * startup workspace, per-workspace mutes) in `settings.json` via
 * tauri-plugin-store. Mirrors workspace.ts: deals in plain JSON so this module
 * stays decoupled from the web app's types — the web side normalizes the raw
 * value (see apps/web lib/desktop/settingsTypes.ts). Secrets never live here.
 */
import { load } from "@tauri-apps/plugin-store";

const FILE = "settings.json";
const KEY = "state";

export async function loadSettingsStore(): Promise<unknown> {
	try {
		const store = await load(FILE);
		return (await store.get<unknown>(KEY)) ?? null;
	} catch (e) {
		console.warn("[desktop] loadSettingsStore failed:", e);
		return null;
	}
}

export async function saveSettingsStore(state: unknown): Promise<void> {
	try {
		const store = await load(FILE);
		await store.set(KEY, state);
		await store.save();
	} catch (e) {
		console.warn("[desktop] saveSettingsStore failed:", e);
	}
}
