/**
 * Outbound-TLS selector surface for the setup wizard and the transport editor.
 *
 * The {@link OutboundTlsMode} values are the shared env contract
 * (`@owlat/shared`); the label/hint copy and the seeding helper are UI-only and
 * live here — split out of `useSetupWizard.ts` to keep that file under the
 * file-size ratchet.
 */

import type { OutboundTlsMode } from '@owlat/shared/outboundTlsMode';

// Re-export the shared outbound-TLS union so the setup step and its tests import
// it alongside the option list; the env contract lives in `@owlat/shared`.
export type { OutboundTlsMode };

/**
 * Human-facing option list for the outbound-TLS selector. The {@link OutboundTlsMode}
 * values are the shared env contract (`@owlat/shared`); the label/hint copy is
 * UI-only and lives here beside the setup wizard.
 */
export const OUTBOUND_TLS_MODE_OPTIONS: {
	value: OutboundTlsMode;
	label: string;
	hint: string;
}[] = [
	{
		value: 'opportunistic',
		label: 'Opportunistic (recommended)',
		hint: 'Encrypt whenever the receiving server offers it, but still deliver if it doesn’t. Safest for reaching everyone.',
	},
	{
		value: 'require',
		label: 'Always encrypt',
		hint: 'Refuse to deliver over an unencrypted connection. A receiver that can’t do TLS won’t get the mail.',
	},
	{
		value: 'require-verified',
		label: 'Always encrypt and verify',
		hint: 'Require encryption and a valid certificate. Strongest, but can bounce mail to receivers with a misconfigured or self-signed certificate.',
	},
];

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
