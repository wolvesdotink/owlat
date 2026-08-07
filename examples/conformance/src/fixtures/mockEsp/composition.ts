/**
 * The fixture's COMPOSED artifacts — what codegen would actually write for the
 * Mock ESP bundle, read back as data.
 *
 * The parity suite drives the shipped core modules, and a core module reads the
 * generated catalogs. So the values it is given must be the ones codegen emits,
 * not a hand-written approximation of them: a hand-written entry would keep
 * passing after a renderer stopped carrying `instanceEnvVars`, `credentialFields`
 * or the derived `hasProviderFeedback`, and the whole claim of P3.3 is that a
 * plugin's DECLARATION reaches routing, ramp and the UI unaltered.
 *
 * The catalogs are EVALUATED rather than pattern-matched, for the reason the
 * sibling suites give: each is data-only by construction, so reading it back
 * asserts the values the host loads instead of the text a grep matched. The
 * reading itself — and the guard that fails loudly if an artifact ever stops
 * being data-only — is `../../generatedArtifact`, shared with the two sibling
 * suites that need the same thing.
 *
 * THE MODULE REGISTRIES ARE NOT EVALUATED, and cannot be: codegen emits import
 * statements against the published package specifier `@acme/mock-esp`, which is
 * not installed (deliberately — see the manifest's header). The suite supplies
 * the fixture's real module objects in their place, which is the same shape the
 * generated registry holds and the same one every core-side plugin suite mocks.
 *
 * SO ONE THING HERE STAYS PINNED AS TEXT rather than as code, and it is named
 * rather than implied: nothing in this repository resolves a real send-transport
 * module import, because `plugins.config.ts` is empty and none of the three
 * reference plugins contributes a `sendTransports` bucket. The emitted import
 * statements are asserted by `plugin-codegen`'s own render suite and by no suite
 * as executable code. P5.3 — the first real plugin provider, listed in
 * `plugins.config.ts` — is the piece that closes it. See this package's README.
 */

import { composeBundledPlugins, type BundledPlugin } from '@owlat/plugin-host';
import { renderPluginComposition } from '@owlat/plugin-codegen';
import { validatePluginManifest } from '@owlat/plugin-kit';
import { evaluateGeneratedArtifact } from '../../generatedArtifact';
import { MOCK_ESP_PACKAGE_NAME, mockEspPlugin } from './manifest';

/** One evaluated generated catalog, as an array of plain entries. */
export type GeneratedEntries = readonly Record<string, unknown>[];

export interface MockEspComposition {
	/**
	 * `bundledPluginComposition` — the ROSTER the generated `plugins.generated.ts`
	 * holds, which is literally `composeBundledPlugins([...])` over the manifest
	 * (`plugin-codegen/src/render.ts`). Exposed rather than restated at the mock:
	 * a hand-written roster would keep declaring a flag requirement the manifest
	 * had dropped, and the authorization path that reads it would keep passing for
	 * a reason the bundle no longer carries.
	 */
	readonly roster: readonly BundledPlugin[];
	/** `BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG` as codegen would emit it. */
	readonly sendTransports: GeneratedEntries;
	/** `BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_CATALOG`. */
	readonly webhooks: GeneratedEntries;
	/** `BUNDLED_PLUGIN_SEND_TRANSPORT_DOMAIN_IDENTITY_CATALOG`. */
	readonly domainIdentities: GeneratedEntries;
}

/** One evaluated catalog, through the package's single artifact reader. */
function evaluateCatalog(source: string, constName: string): GeneratedEntries {
	return evaluateGeneratedArtifact(source, constName) as GeneratedEntries;
}

let cached: MockEspComposition | undefined;

/**
 * The composition, computed once — the ONE entry point.
 *
 * Memoized because the five `vi.mock` factories in the parity suite each need it
 * and each runs in its own module-resolution frame; recomposing per factory would
 * run the renderer five times over the same manifest for no added proof, and two
 * public entry points (memoized and not) would only ever be an invitation to use
 * the wrong one.
 */
export function mockEspComposition(): MockEspComposition {
	cached ??= composeMockEsp();
	return cached;
}

/**
 * Run the REAL host composition and the REAL renderer over the fixture manifest,
 * and read the three send-transport catalogs back.
 *
 * Validation is asserted here rather than in a test case so every consumer of
 * the composition fails at the same place with the same message: a fixture that
 * stopped validating is a broken fixture, not a failing proof obligation.
 */
function composeMockEsp(): MockEspComposition {
	const validated = validatePluginManifest(mockEspPlugin);
	if (!validated.ok) {
		throw new Error(
			`the Mock ESP manifest must validate: ${validated.issues
				.map((issue) => `${issue.path} ${issue.message}`)
				.join('; ')}`
		);
	}
	const roster = composeBundledPlugins([
		{ packageName: MOCK_ESP_PACKAGE_NAME, manifest: validated.manifest },
	]);
	const rendered = renderPluginComposition(roster);
	return {
		roster,
		sendTransports: evaluateCatalog(
			rendered.sendTransportCatalog,
			'BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG'
		),
		webhooks: evaluateCatalog(
			rendered.sendTransportWebhookCatalog,
			'BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_CATALOG'
		),
		domainIdentities: evaluateCatalog(
			rendered.sendTransportDomainIdentityCatalog,
			'BUNDLED_PLUGIN_SEND_TRANSPORT_DOMAIN_IDENTITY_CATALOG'
		),
	};
}
