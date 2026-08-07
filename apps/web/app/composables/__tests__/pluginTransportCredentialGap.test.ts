/**
 * THE UNMET HALF OF D5, PINNED AT THE SURFACE THAT OWES IT (the seams plan's
 * P3.3 / acceptance criterion A4).
 *
 * A4 asks that a provider shipped as a PACKAGE "renders its credentials UI".
 * `examples/conformance/src/__tests__/pluginProviderParity.test.ts` proves the
 * plugin's half in full: the bundle declares `credentialFields` in the shared
 * vocabulary, joined to the variables its sends actually read, and the composed
 * catalog entry the BACKEND serves carries them. The host's half is missing, and
 * the reason is one asymmetry — `sendProviderCatalogEntry` (`apps/api`) composes
 * both tiers, while `coreSendProviderCatalogEntry` (`@owlat/shared`) is core-only
 * by construction and by name, and it is the one every surface in this app
 * reaches for. So the descriptors exist and never arrive.
 *
 * WHY A TEST AND NOT A FIX. Closing it means giving `apps/web` a view of the
 * composed catalog — a query plus a lookup, not an architecture change
 * (`delivery/status.ts` already ships a plugin-aware `providerLabel` to this app
 * from the composed catalog, so the road exists). That is a P1.2 follow-up piece.
 * P3.3's card forbids it from editing UI code to make its own proof pass, and
 * rightly: a gap absorbed into a green piece is a gap nobody schedules.
 *
 * WHY THESE ASSERTIONS. They are the three functions the wizard and the in-app
 * transport editor call, plus the list the editor's picker is built from — so any
 * shape of closure turns this red: a fallback added inside `credentialFieldsFor`,
 * a new composed view feeding it, or a plugin-aware kind list. A pin written
 * against the SOURCE TEXT of the core lookup would survive all three and quietly
 * keep claiming a hole the codebase had already filled.
 *
 * WHEN IT GOES RED, DELETE IT. This file has no value except as the receipt for
 * an obligation the Wave-3 gate must not record as met.
 *
 * THE PLAN-OWNER REPORT is `.pipeline/P3.3_CREDENTIALS_UI_GAP.md` (the format
 * `.pipeline/P0.4_RESIDUAL_KIND_LITERALS.md` established): the asymmetry, the
 * four blocked call sites, the named owning card, and the line the wave gate
 * needs — A4 is not met until that card lands. A green suite here is what the
 * absence of the capability looks like, so the gate must read that file rather
 * than this file's exit code.
 */

import { describe, expect, it } from 'vitest';
import {
	credentialFieldsFor,
	seedCredentialValues,
	transportCredentialEnv,
} from '../setupWizardCredentials';
import { RELAY_PROVIDER_OPTIONS } from '../useRelayCredentialDraft';

/**
 * The conformance fixture's composed transport kind, spelled by hand because
 * `apps/web` may not import from `examples/` — bound back to the fixture by the
 * parity suite's own "binds the two out-of-package fixtures" case, which fails if
 * this literal stops naming a kind that composition produces.
 */
const PLUGIN_KIND = 'plugin.mock-esp.relay';

describe('a plugin transport kind reaches no credential surface in this app', () => {
	it('has no credential descriptors to draw', () => {
		expect(credentialFieldsFor(PLUGIN_KIND)).toEqual([]);
	});

	// The blank form is empty for the same reason, which is what an operator would
	// actually see: a connect screen with no fields at all.
	it('seeds an empty form', () => {
		expect(seedCredentialValues(PLUGIN_KIND)).toEqual({});
	});

	// And nothing would leave the browser even if a value were typed — the apply
	// endpoint's allowlist is keyed by the same descriptors.
	it('writes no env patch', () => {
		expect(transportCredentialEnv(PLUGIN_KIND, { PLUGIN_MOCK_ESP_TOKEN: 'tok-live' })).toEqual({});
	});

	// The picker is built from the core-only kind list, so the kind is not even
	// offerable — the earlier failure, and the one an operator meets first.
	it('is not offered by the transport picker', () => {
		expect(RELAY_PROVIDER_OPTIONS.map((option) => option.value)).not.toContain(PLUGIN_KIND);
	});
});
