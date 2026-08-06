/**
 * ONE FIELD VOCABULARY, TWO PACKAGES — the pin behind the decision P1.1 closed.
 *
 * The seams plan asked whether a core provider's `credentialFields` (D5) should
 * reuse the plugin platform's `settingsSchema` field kinds exactly or invent its
 * own; the answer shipped is the plan's recommendation, the same five base kinds
 * spelled identically plus two composites (`region-select`, `host-port`). That
 * decision only pays off while the spellings actually match: one renderer draws
 * a plugin's `secret` field and a core provider's the same way, and P3.1 gives
 * plugin transports the same capability metadata core kinds have.
 *
 * NEITHER PACKAGE CAN HOLD THE PIN. `packages/shared` must not depend on
 * `@owlat/plugin-kit` (the plugin platform is a layer above it, and the catalog
 * module ships in the web client bundle), and plugin-kit is zero-dependency by
 * design. `apps/api` imports both, so the assertion lives here — where a
 * plugin-kit widening or rename becomes a red suite at the moment it happens
 * rather than a credential field that renders blank on a real form because the
 * core renderer has no branch for the kind it was handed.
 *
 * Asserted twice on purpose: at the TYPE level (the assignment below fails to
 * compile if plugin-kit's union grows a member the send catalog has no spelling
 * for) and at RUN time (the same claim about the values, so a suite run catches
 * it even where the type check has not run yet).
 *
 * WHAT THIS PIN DOES NOT COVER — read before assuming one component can draw
 * both tiers: it compares KIND NAMES only, never the per-kind property sets, and
 * those diverge today. `envVar` is on every send-provider credential field and on
 * plugin-kit's `secret` field alone; the `string` kinds carry `placeholder` here
 * and `maxLength` there. The full list, with the reason for each, is the "WHAT
 * 'SPELLED IDENTICALLY' COVERS" note in
 * `packages/shared/src/sendProviderCredentialFields.ts`. Reconciling the shapes
 * is P3.1's job; this file only keeps the vocabularies from drifting apart in the
 * meantime.
 */

import { SETTINGS_FIELD_KINDS, type PluginSettingsFieldKind } from '@owlat/plugin-kit';
import {
	SEND_PROVIDER_CREDENTIAL_FIELD_KINDS,
	type SendProviderCredentialFieldKind,
} from '@owlat/shared';
import { describe, expect, it } from 'vitest';

/**
 * Compile-time: every plugin settings field kind IS a send-provider credential
 * field kind. One-directional by design — the composites are ours, and the
 * plugin platform is not required to grow them.
 */
const _pluginKindsAreCredentialKinds: readonly SendProviderCredentialFieldKind[] =
	SETTINGS_FIELD_KINDS;
void _pluginKindsAreCredentialKinds;

/** Compile-time, the other assignability that must hold for the base five. */
type _BaseFiveAgree = PluginSettingsFieldKind extends SendProviderCredentialFieldKind
	? true
	: false;
const _baseFiveAgree: _BaseFiveAgree = true;
void _baseFiveAgree;

describe('send-provider credential fields reuse the plugin settings vocabulary', () => {
	it('spells every plugin settings field kind identically', () => {
		const credentialKinds = new Set<string>(SEND_PROVIDER_CREDENTIAL_FIELD_KINDS);
		expect(
			SETTINGS_FIELD_KINDS.filter((kind) => !credentialKinds.has(kind)),
			'plugin-kit declares a settings field kind the send-provider credential ' +
				'vocabulary has no spelling for — add it to ' +
				'packages/shared/src/sendProviderCredentialFields.ts (and give the ' +
				'renderer a branch) rather than letting the two tiers diverge'
		).toEqual([]);
	});

	it('adds exactly the two composites the decision sanctions', () => {
		const pluginKinds = new Set<string>(SETTINGS_FIELD_KINDS);
		expect(SEND_PROVIDER_CREDENTIAL_FIELD_KINDS.filter((kind) => !pluginKinds.has(kind))).toEqual([
			'region-select',
			'host-port',
		]);
	});
});
