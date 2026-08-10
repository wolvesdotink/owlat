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
 * THE SHAPES ARE PINNED NOW TOO, for the tier that has to land in the catalog.
 * P3.1 gave a bundled send transport its own `credentialFields`, and a generated
 * entry's descriptors go into the SAME catalog field a core entry's do — so a
 * renderer reading the composed catalog cannot tell which tier wrote them. That
 * only holds if `PluginSendTransportCredentialField` is assignable to
 * `SendProviderCredentialField`, which is the second compile-time assertion
 * below. The plugin platform's own `settingsSchema` field shape is deliberately
 * NOT held to it: it names no `envVar` on four of its five kinds and carries
 * `maxLength` where the catalog carries `placeholder`, differences that belong to
 * a settings form rather than to a credential one. The full list, with the reason
 * for each, is the "WHAT 'SPELLED IDENTICALLY' COVERS" note in
 * `packages/shared/src/sendProviderCredentialFields.ts`.
 */

import {
	PLUGIN_SEND_TRANSPORT_CREDENTIAL_FIELD_KINDS,
	SETTINGS_FIELD_KINDS,
	type PluginSendTransportCredentialField,
	type PluginSendTransportCredentialFieldKind,
	type PluginSettingsFieldKind,
} from '@owlat/plugin-kit';
import {
	SEND_PROVIDER_CREDENTIAL_FIELD_KINDS,
	type SendProviderCredentialField,
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

/**
 * Compile-time, and the one that carries weight at run time: a bundled
 * transport's declared credential descriptor IS a send-provider credential
 * field. The assignment is the assertion — a plugin-kit widening that the shared
 * descriptors have no shape for fails `tsc` here, naming the member, rather than
 * reaching the catalog as a field the renderer cannot draw.
 */
const _pluginDescriptorsAreCatalogDescriptors: readonly SendProviderCredentialField[] =
	[] as readonly PluginSendTransportCredentialField[];
void _pluginDescriptorsAreCatalogDescriptors;

/** And its kind union stays inside the catalog's, composites excluded. */
const _pluginFieldKindsAreCatalogKinds: readonly SendProviderCredentialFieldKind[] =
	[] as readonly PluginSendTransportCredentialFieldKind[];
void _pluginFieldKindsAreCatalogKinds;

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

	it('offers a bundled transport the base five and withholds the composites', () => {
		// A composite carries a RELATIONSHIP between variables that only means
		// something to a renderer that already knows it; a plugin expresses the same
		// configuration as the parts, which is the documented fallback anyway.
		expect([...PLUGIN_SEND_TRANSPORT_CREDENTIAL_FIELD_KINDS]).toEqual([...SETTINGS_FIELD_KINDS]);
	});
});
