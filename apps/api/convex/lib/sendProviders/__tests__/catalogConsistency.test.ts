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

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const convexRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

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
 * directory) fails naming it. The runtime half below asks the same question of
 * the parsed union so that `vitest` reports it too, with the kind and the field
 * that declared it; a type error on a 90-member union does not say which entry
 * was wrong.
 */
const _declaredEnvVarsAreReadableEnvKeys: EnvKey = null as unknown as DeclaredEnvVar;
void _declaredEnvVarsAreReadableEnvKeys;

/**
 * The `EnvKey` union, read out of its own declaration.
 *
 * A type is not a value, so the runtime half has to parse. The extraction is the
 * one `scripts/check-env-keys-sync.sh` uses (comments stripped, then quoted
 * UPPER_SNAKE tokens between `export type EnvKey =` and its terminating `;`) —
 * and, like that script, it fails loudly rather than quietly matching nothing:
 * see the anchor assertion below.
 */
const ENV_KEY_UNION: ReadonlySet<string> = (() => {
	const source = readFileSync(resolve(convexRoot, 'lib/env.ts'), 'utf8').replace(/\/\/.*$/gm, '');
	const start = source.indexOf('export type EnvKey =');
	const end = source.indexOf(';', start);
	if (start < 0 || end < 0) throw new Error('lib/env.ts no longer declares an EnvKey union');
	return new Set(
		[...source.slice(start, end).matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((match) => match[1]!)
	);
})();

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
	it('reads a real union out of lib/env.ts rather than matching nothing', () => {
		// THE ANCHOR. A parse that lost its footing would return an empty set and
		// make every subset assertion below pass vacuously. `CONVEX_RUNTIME_ENV_KEYS`
		// is a runtime VALUE whose members are all `EnvKey`s (that is exactly what
		// `check-env-keys-sync.sh` enforces), so it is a ~90-name probe of the parse
		// that costs nothing and is not a second copy of anything: this file never
		// asserts the reverse inclusion, which is that script's whole job.
		expect([...CONVEX_RUNTIME_ENV_KEYS].filter((key) => !ENV_KEY_UNION.has(key))).toEqual([]);
	});

	it('declares at least one variable per kind, so the checks below have subjects', () => {
		expect([...new Set(DECLARED_VARIABLES.map((variable) => variable.kind))].sort()).toEqual(
			[...SEND_TRANSPORT_KINDS].sort()
		);
	});

	it.each(CORE_ENTRIES.map((entry) => entry.kind))(
		'%s names only variables lib/env.ts can read',
		(kind) => {
			const unreadable = DECLARED_VARIABLES.filter(
				(variable) => variable.kind === kind && !ENV_KEY_UNION.has(variable.name)
			);
			expect(
				unreadable.map((variable) => `${variable.field}: ${variable.name}`),
				`add these to the EnvKey union in apps/api/convex/lib/env.ts — the ${kind} adapter ` +
					'cannot read a variable that is not in it, so the kind would resolve as ' +
					'configured and then fail on every send'
			).toEqual([]);
		}
	);

	it.each(CORE_ENTRIES.map((entry) => entry.kind))(
		'%s names only variables the setup surfaces push into the function runtime',
		(kind) => {
			// The second half of the same promise, and the one whose failure is
			// invisible: a self-hoster sets the variable in `.env`, the deployment's
			// env store never receives it, `getOptional` returns undefined, and the
			// transport is simply off with no error anywhere.
			const runtime = new Set<string>(CONVEX_RUNTIME_ENV_KEYS);
			const unpushed = DECLARED_VARIABLES.filter(
				(variable) => variable.kind === kind && !runtime.has(variable.name)
			);
			expect(
				unpushed.map((variable) => `${variable.field}: ${variable.name}`),
				'add these to CONVEX_RUNTIME_ENV_KEYS in packages/shared/src/convexRuntimeEnv.ts — ' +
					'a variable left out of the push list reaches the container but never the ' +
					'Convex function sandbox, so the operator sets it and nothing happens'
			).toEqual([]);
		}
	);

	it('never puts a form field on a variable the entry does not declare', () => {
		// The join in the other direction: `requiredEnvVars ∪ optionalEnvVars` is
		// what "this kind needs" MEANS — the presence gate that decides configured,
		// the `.env` skeleton, the docs table. A credential field writing a variable
		// outside it is an input the operator can fill in that no other surface
		// knows exists.
		for (const entry of CORE_ENTRIES) {
			const declared = new Set<string>([
				...entry.requiredEnvVars,
				...(entry.optionalEnvVars ?? []),
			]);
			const orphans = entry.credentialFields
				.flatMap((field) => credentialFieldEnvVars(field))
				.filter((name) => !declared.has(name));
			expect(orphans, entry.kind).toEqual([]);
		}
	});
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
// 3. Feedback — every kind that says it reports outcomes has somewhere to
//    report them. Wave 2's P2.1 turns this into a mapped-type registry guard;
//    until then it is this.
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

/** `POST /webhooks/…`-shaped route registrations, read out of `http.ts`. */
const REGISTERED_ROUTES: readonly string[] = (() => {
	const source = readFileSync(resolve(convexRoot, 'http.ts'), 'utf8');
	const routes: string[] = [];
	for (const match of source.matchAll(/http\.route\(\{([\s\S]*?)\}\);/g)) {
		const block = match[1]!;
		const path = /\bpath:\s*'([^']+)'/.exec(block)?.[1];
		const method = /\bmethod:\s*'([^']+)'/.exec(block)?.[1];
		if (path !== undefined && method !== undefined) routes.push(`${method} ${path}`);
	}
	return routes;
})();

/**
 * The two sides of the question, asked through the accessor the rest of the
 * backend reads — never off the raw field, so an entry that stopped declaring
 * the capability lands on the fail-closed side rather than on neither.
 */
const FEEDBACK_KINDS = SEND_TRANSPORT_KINDS.filter((kind) => hasProviderFeedbackFor(kind));
const SILENT_KINDS = SEND_TRANSPORT_KINDS.filter((kind) => !hasProviderFeedbackFor(kind));

describe('every kind that declares provider feedback can receive it', () => {
	it('parses real routes out of http.ts rather than matching nothing', () => {
		// The same anchor discipline as the env parse: an expression that stopped
		// matching would make the per-kind route assertions vacuous.
		expect(REGISTERED_ROUTES.length).toBeGreaterThan(10);
	});

	it('finds the kinds on both sides of the question', () => {
		// Neither list may be empty, or one of the two suites below would pass by
		// having no subject at all.
		expect([...FEEDBACK_KINDS]).toEqual(['mta', 'ses', 'resend', 'mandrill']);
		expect([...SILENT_KINDS]).toEqual(['smtp']);
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

	it.each([...FEEDBACK_KINDS])('%s has its declared webhook path registered in http.ts', (kind) => {
		// The catalog's `webhookPath` is the URL an operator has already pasted
		// into a provider console, and the delivery page now DERIVES the endpoint
		// it displays from it (P1.2). A declared path with no route serves that
		// operator a 404 for every bounce.
		const declared = CORE_ENTRIES.find((entry) => entry.kind === kind)?.providerFeedback
			?.webhookPath;
		expect(declared, `${kind} declares feedback without a channel`).toBeDefined();
		expect(REGISTERED_ROUTES).toContain(`POST ${declared}`);
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
