/**
 * First-run setup wizard — draft persistence.
 *
 * The `/setup/*` steps share their collected config through Nuxt `useState`,
 * which a refresh or a back-out of the wizard wipes. To survive that, the
 * composable mirrors the draft into `sessionStorage`; these are the pure,
 * unit-testable serialise/parse helpers plus the storage key, kept in a sibling
 * of `useSetupWizard.ts` so that file stays under the file-size budget.
 *
 * sessionStorage (not localStorage) is deliberate: the persisted draft is scoped
 * to the tab and never outlives the setup session, and the composable clears the
 * entry on a successful launch.
 *
 * SECURITY — the two bearer secrets are NEVER persisted. The admin password and
 * the one-time setup token live only in `useState` for the tab's lifetime;
 * `serializeSetupDraft` strips them before anything reaches sessionStorage, and
 * `parseSetupDraft` refuses to surface them even out of a legacy entry that
 * predates this rule. A refresh restores everything else; those two are
 * re-entered. This keeps an XSS payload or a shared-device inspector from lifting
 * a live admin credential / setup token back out of storage. (Provider API keys
 * in `env` are still persisted so the provider step survives a reload; that is a
 * deliberate, narrower tradeoff than exposing the account password and the
 * privileged setup token.)
 */

import type { FeatureFlagState } from '@owlat/shared/featureFlags';
import type { AdminDraft } from './useSetupWizard';

/**
 * sessionStorage key the wizard draft round-trips through. Namespaced and
 * versioned so a future shape change can be ignored rather than mis-read.
 */
export const SETUP_DRAFT_STORAGE_KEY = 'owlat.setup.wizard.v1';

/** Everything the wizard collects across its steps, as one serialisable unit. */
export interface SetupDraft {
	flags: FeatureFlagState;
	env: Record<string, string>;
	admin: AdminDraft;
	isMigrationMode: boolean;
	/**
	 * One-time setup token minted by `owlat setup`. Echoed in the `X-Setup-Token`
	 * header on the privileged setup endpoints (validate-provider, apply).
	 */
	token: string;
}

export function serializeSetupDraft(draft: SetupDraft): string {
	// Strip the two bearer secrets before persisting: the one-time setup `token`
	// is dropped entirely, and the admin `password` is blanked. Everything else
	// round-trips so a refresh restores the draft. See the module header.
	const { token: _token, admin, ...rest } = draft;
	const safeAdmin: AdminDraft = { ...admin, password: '' };
	return JSON.stringify({ ...rest, admin: safeAdmin });
}

function isStringRecord(value: unknown): value is Record<string, string> {
	if (typeof value !== 'object' || value === null) return false;
	return Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string');
}

function isBooleanRecord(value: unknown): value is FeatureFlagState {
	if (typeof value !== 'object' || value === null) return false;
	return Object.values(value as Record<string, unknown>).every((v) => typeof v === 'boolean');
}

function isAdminDraft(value: unknown): value is AdminDraft {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v['email'] === 'string' &&
		typeof v['name'] === 'string' &&
		typeof v['password'] === 'string'
	);
}

/**
 * Parse a persisted wizard draft, tolerating absence and corruption: a missing
 * or malformed payload (or any field of the wrong shape) yields `null`/an
 * omitted key so a bad sessionStorage entry can never crash the wizard — the
 * caller falls back to defaults. Only known, well-typed fields are surfaced.
 */
export function parseSetupDraft(raw: string | null | undefined): Partial<SetupDraft> | null {
	if (!raw) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	const record = parsed as Record<string, unknown>;
	const draft: Partial<SetupDraft> = {};
	if (isBooleanRecord(record['flags'])) draft.flags = record['flags'];
	if (isStringRecord(record['env'])) draft.env = record['env'];
	if (isAdminDraft(record['admin'])) {
		// Defense-in-depth: even a legacy entry that predates the no-persist rule
		// must never hand a stored password back to the wizard. Blank it on read.
		draft.admin = { ...record['admin'], password: '' };
	}
	if (typeof record['isMigrationMode'] === 'boolean') {
		draft.isMigrationMode = record['isMigrationMode'];
	}
	// The setup `token` is intentionally never restored from storage — it is never
	// persisted (see serialize) and a stale stored copy is ignored, not trusted.
	return draft;
}

/** Read + parse the persisted draft, guarded for SSR / storage-less contexts. */
export function readSetupDraft(): Partial<SetupDraft> | null {
	if (typeof sessionStorage === 'undefined') return null;
	try {
		return parseSetupDraft(sessionStorage.getItem(SETUP_DRAFT_STORAGE_KEY));
	} catch {
		return null;
	}
}
