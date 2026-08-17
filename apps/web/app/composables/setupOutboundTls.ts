/**
 * Outbound-TLS selector surface for the setup wizard and the transport editor.
 *
 * The {@link OutboundTlsMode} values AND their labels are the shared
 * declaration: the catalog's own-MTA entry describes the floor as a `select`
 * credential field (the seams plan's D5), and this module maps that descriptor
 * rather than restating it. Only the `hint` paragraph is written here — a
 * descriptor carries the label a form needs, not the prose a page writes around
 * it — so renaming a mode's label is one edit in
 * `packages/shared/src/sendProviderCatalog.ts`, not two that have to stay equal.
 *
 * The seeding helper is UI-only and lives here for the same reason it always
 * did: split out of `useSetupWizard.ts` to keep that file under the file-size
 * ratchet.
 */

import { OUTBOUND_TLS_MODE_OPTIONS as CATALOG_OUTBOUND_TLS_MODE_OPTIONS } from '@owlat/shared/sendProviderCatalog';
import type { OutboundTlsMode } from '@owlat/shared/outboundTlsMode';

// Re-export the shared outbound-TLS union so the setup step and its tests import
// it alongside the option list; the env contract lives in `@owlat/shared`.
export type { OutboundTlsMode };

/**
 * The one sentence of guidance per mode — the copy this surface owns, keyed by
 * the shared value so a mode with no hint is a compile error rather than a blank
 * caption.
 *
 * This is a module-scope declaration, so each entry holds the message KEY (the
 * i18n registry convention) and the screen that prints the caption resolves it
 * with `t()`.
 */
const OUTBOUND_TLS_MODE_HINTS: Record<OutboundTlsMode, string> = {
	opportunistic: 'shared.setupOutboundTls.hints.opportunistic',
	require: 'shared.setupOutboundTls.hints.require',
	'require-verified': 'shared.setupOutboundTls.hints.requireVerified',
};

/**
 * Human-facing option list for the outbound-TLS selector — the catalog's
 * descriptor, in its order, with this surface's hint key attached.
 */
export const OUTBOUND_TLS_MODE_OPTIONS: {
	value: OutboundTlsMode;
	label: string;
	hint: string;
}[] = CATALOG_OUTBOUND_TLS_MODE_OPTIONS.map((option) => ({
	value: option.value,
	label: option.label,
	hint: OUTBOUND_TLS_MODE_HINTS[option.value],
}));

/**
 * Narrow the active (non-secret) `OUTBOUND_TLS_MODE` — as reported by the status
 * query — to a valid mode for seeding the editor. A previously-chosen floor is
 * preserved; an unset/unknown value falls back to `opportunistic` (the backend
 * default). Used so re-applying a transport edit never silently downgrades a
 * floor an admin already set.
 */
export function seedOutboundTlsMode(current: string | null | undefined): OutboundTlsMode {
	return OUTBOUND_TLS_MODE_OPTIONS.some((o) => o.value === current)
		? (current as OutboundTlsMode)
		: 'opportunistic';
}
