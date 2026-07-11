/**
 * First-run setup wizard — draft persistence.
 *
 * The `/setup/*` steps share their collected config through Nuxt `useState`,
 * which a refresh or a back-out of the wizard wipes. To survive that, the
 * composable mirrors the draft into `sessionStorage`; these are the pure,
 * unit-testable serialise/parse helpers plus the storage key, kept in a sibling
 * of `useSetupWizard.ts` so that file stays under the file-size budget.
 *
 * sessionStorage (not localStorage) is deliberate: the collected secrets —
 * provider keys, the admin password, the setup token — are scoped to the tab and
 * never outlive the setup session. The composable clears the entry on a
 * successful launch.
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
	return JSON.stringify(draft);
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
	if (isAdminDraft(record['admin'])) draft.admin = record['admin'];
	if (typeof record['isMigrationMode'] === 'boolean') {
		draft.isMigrationMode = record['isMigrationMode'];
	}
	if (typeof record['token'] === 'string') draft.token = record['token'];
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
