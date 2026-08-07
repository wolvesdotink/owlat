/**
 * THE CATALOG'S JOINS, PINNED — the seams plan's P1.3.
 *
 * P1.1 made the catalog the single DECLARATION (D1). What it could not make
 * single is the set of things a declaration has to be JOINED to before it means
 * anything: a `requiredEnvVars` name is a promise that `lib/env.ts` can read that
 * variable and that the setup surfaces push it into the Convex function runtime;
 * a `kind` is a promise that an adapter exists; `hasProviderFeedback: true` is a
 * promise that the bounces have somewhere to land. Each of those joins lived in a
 * different file, and until now each was kept by a human remembering to make it —
 * the N+1 checklist in §4 of the plan, executed by hand.
 *
 * Every failure they let through is SILENT and LATE:
 *
 *   env var not in `EnvKey`        the adapter cannot read its own credential,
 *                                  so the kind resolves as configured and then
 *                                  fails on every send
 *   env var not in the push list   the operator sets it, `convex env set` never
 *                                  carries it, and the feature is simply off
 *   kind without an adapter        `providerFor` throws inside dispatch
 *   feedback without an adapter    the kind sends, and every bounce and
 *                                  complaint it generates is dropped on the
 *                                  floor — the arm looks CLEAN to the ramp
 *                                  controller precisely because its bad news
 *                                  has no route home
 *
 * None of those is observable from the catalog, from the adapter, or from any
 * one module's own suite: each is a fact about a PAIR. So this file asserts the
 * pairs, over the catalog rather than over a list of kinds somebody maintains —
 * a sixth provider is covered the day its entry lands.
 *
 * ONE PAIR IS NOT HERE: `providerFeedback.webhookPath` vs. the route the backend
 * registers. `feedbackRoutes.test.ts`, in this directory, already owns that join
 * and asserts it in both directions by walking the REAL router
 * (`http.getRoutes()`). A second copy here — however phrased — would be the
 * weaker of the two and would rot separately, so this file stops at "the adapter
 * exists and has the shape the router's handler needs".
 *
 * NEITHER IS THE FOURTH JOIN THIS PIECE OWNS — `setupProbe` vs. the validators
 * and surfaces that keep it — because none of its three halves can be asked from
 * a Convex module. They are, and each says which side it binds:
 *
 *   packages/shared/src/__tests__/sendProviderCatalog.test.ts
 *     ("names a real validator on every setup probe, and only where one exists")
 *     descriptor → `setupValidators.ts`: the named validator resolves to a
 *     callable export, so a typo or a rename cannot ship. It lives beside the
 *     declaration because that is the package holding both.
 *   apps/web/server/api/delivery/__tests__/validate-transport-probes.test.ts
 *     descriptor → the SHIPPED endpoint: every declared probe reaches the
 *     validator its descriptor names, and every kind without one is refused
 *     rather than quietly accepted.
 *   apps/web/app/composables/__tests__/relayCredentialDraft.test.ts
 *     ("offers a live check for %s only when its entry declares a setup probe")
 *     descriptor → the BROWSER: `canValidateLive` — and therefore the editor's
 *     test button — is true exactly for the kinds that declare a probe.
 *
 * Nothing in `apps/api` may import a Nitro route or a Vue composable, so this
 * file cannot restate any of the three. It names them instead, because a reader
 * auditing P1.3 from here would otherwise read three joins and conclude the
 * fourth was dropped.
 *
 * WHAT IS NOT A JOIN AT ALL stays with the declaration. Rules relating one part
 * of an entry to another part of the SAME entry — a credential field's variables
 * against that entry's `requiredEnvVars`/`optionalEnvVars`, for instance — need
 * nothing from Convex, and `packages/shared/src/__tests__/sendProviderCatalog.test.ts`
 * states each of them once, whole, in the package an author edits to declare a
 * sixth provider.
 *
 * SCOPE: THE CORE TIER, deliberately. A bundled plugin transport declares its
 * env keys in its manifest (the host asserts their presence — plan §4, the
 * plugin column of the N+1 checklist), carries its own executable module through
 * the generated registry, and will receive its feedback on
 * `/webhooks/plugin/<pluginId>` once Wave 2's P2.2 ships. Holding the hosted
 * tier to the core tier's joins would fail a promise this wave has not made yet.
 * The adapter assertions below run over the COMPOSED catalog, because
 * `providerFor` must answer for both tiers today; the env and feedback ones run
 * over the core entries, and say so.
 */

import {
	CORE_SEND_PROVIDER_CATALOG_ENTRIES,
	SEND_TRANSPORT_KINDS,
	credentialFieldEnvVars,
	type CoreSendProviderCatalogEntry,
	type CoreSendProviderKind,
	type TransportCredentialEnvKey,
} from '@owlat/shared';
import { CONVEX_RUNTIME_ENV_KEYS } from '@owlat/shared/convexRuntimeEnv';
import { describe, expect, it } from 'vitest';
import type { EnvKey } from '../../env';
import { SEND_PROVIDER_CATALOG, hasProviderFeedbackFor } from '../catalog';
import { SEND_PROVIDERS, providerFor } from '../index';
import type { SendProviderModule } from '../types';

/**
 * The core entries, as the shipped list — the only tier these joins bind.
 *
 * Widened to the CONSUMER's view of an entry (the exported const keeps its
 * literal types, which is what the compile-time env-key assertion below needs).
 * Every optional capability field is optional on this type, which is exactly the
 * reading a real caller gets.
 */
const CORE_ENTRIES: readonly CoreSendProviderCatalogEntry[] = CORE_SEND_PROVIDER_CATALOG_ENTRIES;

/** Every kind in the COMPOSED catalog: core entries plus any bundled plugin. */
const COMPOSED_KINDS = SEND_PROVIDER_CATALOG.map((entry) => entry.kind);

// ---------------------------------------------------------------------------
// 1. Env variables — the catalog names them, `lib/env.ts` reads them, and the
//    setup surfaces push them.
// ---------------------------------------------------------------------------

type CoreEntry = (typeof CORE_SEND_PROVIDER_CATALOG_ENTRIES)[number];

/**
 * The names one entry declares OPTIONAL, or nothing when it declares none.
 *
 * A helper with a naked type parameter rather than an inline conditional,
 * because only a naked parameter DISTRIBUTES over the union of entries: written
 * inline, `CoreEntry extends { optionalEnvVars: … }` asks whether EVERY entry
 * has the property, SES does not, and the whole thing collapses to `never` —
 * a silently empty assertion rather than a failing one.
 */
type OptionalEnvVarOf<Entry> = Entry extends {
	readonly optionalEnvVars: readonly (infer Name)[];
}
	? Name
	: never;

/** Every env variable the core catalog names, as a TYPE. */
type DeclaredEnvVar =
	| CoreEntry['requiredEnvVars'][number]
	| OptionalEnvVarOf<CoreEntry>
	| TransportCredentialEnvKey;

/**
 * THE FIRST JOIN, AT COMPILE TIME: every name the catalog declares is a member
 * of the `EnvKey` union, so it can be read through `lib/env.ts` at all.
 *
 * The assignment is the assertion — a literal the union does not carry is not
 * assignable, and `tsc --noEmit -p convex/tsconfig.json` (which includes this
 * directory) fails NAMING THE OFFENDING LITERAL, which is all a runtime restating
 * of the same question could add.
 *
 * There is no such restating, and that is deliberate: the runtime case below asks
 * about `CONVEX_RUNTIME_ENV_KEYS`, and `apps/setup-cli/scripts/check-env-keys-sync.sh`
 * holds that list EQUAL to `EnvKey` minus the `CONVEX_SITE_URL` built-in (not
 * merely contained in it). So a name the catalog declares and `lib/env.ts` cannot
 * read is caught twice over — here, by type, and there, by value — without this
 * file parsing another module's source to find out. Reading the union out of
 * `env.ts` with a regex would add a third copy of that script's extractor, and
 * one that can only ever OVER-match: a block comment quoting an example name
 * would silently enlarge the union and stop the check rejecting anything.
 */
const _declaredEnvVarsAreReadableEnvKeys: EnvKey = null as unknown as DeclaredEnvVar;
void _declaredEnvVarsAreReadableEnvKeys;

interface DeclaredVariable {
	readonly kind: string;
	readonly name: string;
	/** Which declaration named it — the half a failure message needs. */
	readonly field: string;
}

const DECLARED_VARIABLES: readonly DeclaredVariable[] = CORE_ENTRIES.flatMap((entry) => [
	...entry.requiredEnvVars.map((name) => ({ kind: entry.kind, name, field: 'requiredEnvVars' })),
	...(entry.optionalEnvVars ?? []).map((name) => ({
		kind: entry.kind,
		name,
		field: 'optionalEnvVars',
	})),
	...entry.credentialFields.flatMap((field) =>
		credentialFieldEnvVars(field).map((name) => ({
			kind: entry.kind,
			name,
			field: `credentialFields.${field.key}`,
		}))
	),
]);

describe('every env variable the catalog declares is one the deployment can carry', () => {
	it('declares at least one variable per kind, so the check below has subjects', () => {
		// THE ANCHOR. `DECLARED_VARIABLES` is walked off the entries, so a catalog
		// shape change that stopped producing names would leave the case below
		// filtering an empty list and passing for every kind.
		expect([...new Set(DECLARED_VARIABLES.map((variable) => variable.kind))].sort()).toEqual(
			[...SEND_TRANSPORT_KINDS].sort()
		);
	});

	it.each(CORE_ENTRIES.map((entry) => entry.kind))(
		'%s names only variables the setup surfaces push into the function runtime',
		(kind) => {
			// The half of the promise whose failure is invisible: a self-hoster sets
			// the variable in `.env`, the deployment's env store never receives it,
			// `getOptional` returns undefined, and the transport is simply off with no
			// error anywhere.
			//
			// It is also the runtime half of "lib/env.ts can read it", because
			// `apps/setup-cli/scripts/check-env-keys-sync.sh` holds this list EQUAL to
			// the `EnvKey` union minus the `CONVEX_SITE_URL` built-in. A name missing
			// from both lists fails here; a name in `EnvKey` alone fails that script.
			const runtime = new Set<string>(CONVEX_RUNTIME_ENV_KEYS);
			const unpushed = DECLARED_VARIABLES.filter(
				(variable) => variable.kind === kind && !runtime.has(variable.name)
			);
			expect(
				unpushed.map((variable) => `${variable.field}: ${variable.name}`),
				'add these to CONVEX_RUNTIME_ENV_KEYS in packages/shared/src/convexRuntimeEnv.ts ' +
					'AND to the EnvKey union in apps/api/convex/lib/env.ts (check-env-keys-sync.sh ' +
					'keeps the two equal) — a variable left out of the push list reaches the ' +
					'container but never the Convex function sandbox, so the operator sets it and ' +
					'nothing happens'
			).toEqual([]);
		}
	);
});

// ---------------------------------------------------------------------------
// 2. Adapters — every catalog kind has an executable send module.
// ---------------------------------------------------------------------------

/**
 * THE COMPLETENESS GUARD, KEYED OFF THE SHARED CATALOG.
 *
 * `lib/sendProviders/index.ts` carries the same mapped type, and until P1.1 it
 * was keyed off a union declared in this app. It now reads `@owlat/shared`
 * through a chain of re-exports (`../types` → `../catalog` → `./catalogTypes`),
 * which is easy to break back the other way without any test noticing: the
 * registry would keep compiling against whatever local union replaced it.
 *
 * This restates the guard against the union IMPORTED FROM THE CATALOG'S OWN
 * PACKAGE, so the two can only agree if the backend's kind union really is the
 * catalog's. Declaring an entry in `packages/shared` without adding its adapter
 * folder fails HERE at build time even if the backend re-grew a union of its own.
 */
const _adapterPerCatalogKind: { [K in CoreSendProviderKind]: SendProviderModule<K> } =
	SEND_PROVIDERS;
void _adapterPerCatalogKind;

describe('every catalog kind has an adapter', () => {
	it('registers exactly the catalog’s core kinds — no more, no fewer', () => {
		// Derived from the catalog rather than pinned to a literal list: a sixth
		// entry has to bring its adapter with it, on the day it is declared.
		expect(Object.keys(SEND_PROVIDERS).sort()).toEqual([...SEND_TRANSPORT_KINDS].sort());
	});

	it.each(COMPOSED_KINDS)('%s resolves to a module that names itself', (kind) => {
		// The COMPOSED catalog, because this is the lookup `dispatch.ts` performs
		// for whatever kind a resolved transport id carries — a bundled plugin
		// entry with no executable module is a boot failure by design, and this is
		// the assertion that says so out loud.
		const module = providerFor(kind);
		expect(module.kind).toBe(kind);
		expect(typeof module.sendEmail).toBe('function');
		expect(module.retryDelays.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// 3. Feedback — every kind that says it reports outcomes ships the ADAPTER that
//    parses them. (The ROUTE those events arrive on is `feedbackRoutes.test.ts`'s
//    join, against the real router.) Wave 2's P2.1 turns this into a mapped-type
//    registry guard; until then it is this.
// ---------------------------------------------------------------------------

/**
 * The inbound adapters, by file stem.
 *
 * Globbed rather than imported by name: the point of the assertion is that a
 * kind's adapter EXISTS, and a static import list would be the same hand-kept
 * table the guard is replacing (and would not compile once it was wrong, which
 * is a worse failure than a named test).
 */
const INBOUND_ADAPTER_LOADERS: Record<string, () => Promise<Record<string, unknown>>> =
	Object.fromEntries(
		Object.entries(import.meta.glob('../../../webhooks/adapters/*.ts')).map(([path, load]) => [
			path.split('/').pop()!.replace(/\.ts$/, ''),
			load as () => Promise<Record<string, unknown>>,
		])
	);

/**
 * The two sides of the question, asked through the accessor the rest of the
 * backend reads — never off the raw field, so an entry that stopped declaring
 * the capability lands on the fail-closed side rather than on neither.
 */
const FEEDBACK_KINDS = SEND_TRANSPORT_KINDS.filter((kind) => hasProviderFeedbackFor(kind));
const SILENT_KINDS = SEND_TRANSPORT_KINDS.filter((kind) => !hasProviderFeedbackFor(kind));

describe('every kind that declares provider feedback ships the adapter that parses it', () => {
	it('finds the kinds on both sides of the question', () => {
		// Neither list may be empty, or one of the two suites below would pass by
		// having no subject at all. WHICH kinds declare feedback is pinned per kind
		// by `packages/shared/src/__tests__/sendProviderCatalog.test.ts` and by
		// `registry.test.ts`'s composed-catalog projection; restating the roster
		// here would make a sixth kind a three-file literal edit for a fact this
		// file does not own. What this file needs is only that both suites have
		// subjects — and that the accessor partitions the kinds, so a kind cannot
		// fall out of both by answering neither.
		expect(FEEDBACK_KINDS.length).toBeGreaterThan(0);
		expect(SILENT_KINDS.length).toBeGreaterThan(0);
		expect([...FEEDBACK_KINDS, ...SILENT_KINDS].sort()).toEqual([...SEND_TRANSPORT_KINDS].sort());
	});

	it.each([...FEEDBACK_KINDS])('%s ships an inbound adapter', async (kind) => {
		const load = INBOUND_ADAPTER_LOADERS[kind];
		expect(
			load,
			`hasProviderFeedback: true promises somewhere for ${kind}'s bounces and complaints ` +
				`to land, so webhooks/adapters/${kind}.ts must exist — without it the arm sends ` +
				'and its bad news is dropped, which reads to the ramp controller as a CLEAN arm'
		).toBeDefined();

		const adapter = (await load!())[`${kind}Adapter`] as Record<string, unknown> | undefined;
		expect(adapter, `webhooks/adapters/${kind}.ts must export ${kind}Adapter`).toBeDefined();
		// The `InboundAdapter` / `InboundBatchAdapter` contract, at runtime: the
		// registry P2.1 builds will key on exactly this shape.
		expect(adapter!['source'], 'the adapter must identify itself by its catalog kind').toBe(kind);
		expect(typeof adapter!['verifySignature']).toBe('function');
		const single = typeof adapter!['parseEvent'] === 'function';
		const batch = typeof adapter!['parseEvents'] === 'function';
		expect(single !== batch, 'exactly one of parseEvent / parseEvents').toBe(true);
	});

	it.each([...SILENT_KINDS])(
		'%s declares no feedback and ships no adapter to contradict it',
		(kind) => {
			// The converse, and it is not pedantry: an adapter with no declaration
			// behind it is a route whose events never reach the measurement plane's
			// confidence grading, because that reads `hasProviderFeedbackFor`.
			expect(INBOUND_ADAPTER_LOADERS[kind]).toBeUndefined();
		}
	);
});
