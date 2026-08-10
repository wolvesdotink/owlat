import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { coreCatalogEntries, coreCatalogKinds } from './catalogSource';

/**
 * Docs-lint for `docs/abstractions.md`, which declares itself "single source of
 * truth for the provider/adapter interfaces in Owlat".
 *
 * A source-of-truth page that nothing checks is a page that silently rots: it
 * still listed three send adapters after `smtp` shipped and after the plugin
 * platform opened an operator-installed transport seam. Every list on that page
 * that has a code-side counterpart is pinned to the code here.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

function read(relativePath: string): string {
	return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

const abstractions = read('docs/abstractions.md');

/**
 * The keys of a `const <NAME> = { … } as const;` registry, read from the
 * registry's own source.
 *
 * One helper for both registries on the page: they are declared identically, so
 * the parsing assumptions (top-level tab indentation, `} as const;` terminator)
 * live in one place. Two copies of this is how a reformat gets fixed for one
 * registry and leaves the other silently matching nothing — inside the file
 * whose whole job is noticing drift.
 */
function registryKeys(relativePath: string, declaration: string): string[] {
	const source = read(relativePath);
	const start = source.indexOf(declaration);
	expect(start, `${relativePath} no longer declares ${declaration}`).toBeGreaterThan(-1);
	const body = source.slice(start, source.indexOf('} as const;', start));
	const keys = [...body.matchAll(/^\t([a-z][a-zA-Z0-9]*): /gm)].map((match) => match[1]!);
	expect(keys.length, `no keys parsed out of ${declaration}`).toBeGreaterThan(1);
	return keys;
}

describe('docs/abstractions.md: the send-provider row matches the registry', () => {
	const kinds = coreCatalogKinds();

	// Non-triviality is `registryKeys`'s own assertion (a parse that matched
	// nothing must not silently agree with an empty row), stated once there
	// rather than restated per registry. What is left here is membership: `smtp`
	// is the adapter whose absence from the page is what started this file.
	it('parses the smtp adapter out of the registry', () => {
		expect(kinds).toContain('smtp');
	});

	it('lists exactly the core adapters the registry ships', () => {
		const row = abstractions.split('\n').find((line) => line.startsWith('| Send providers '));
		expect(row, 'the send-provider row is gone').toBeDefined();
		const listed = [...row!.matchAll(/`([a-z][a-zA-Z0-9]*)`/g)].map((match) => match[1]!);
		expect([...listed].sort()).toEqual([...kinds].sort());
	});

	it('points at the operator-installed plugin transport seam', () => {
		expect(abstractions).toContain('sendProviders/pluginProvider.ts');
		expect(abstractions).toContain('plugin.<pluginId>.<localId>');
		const adapter = 'apps/api/convex/lib/sendProviders/pluginProvider.ts';
		expect(existsSync(resolve(repoRoot, adapter))).toBe(true);
	});

	it('lists exactly the catalog values the plugin tier may not reach', () => {
		// The page's plugin-tier paragraph enumerates the values whose prerequisites
		// live in backend code. That list SHRANK in the seams plan's P3.2 —
		// `domainVerification: 'api'` moved from refused to DERIVED — and the page
		// kept the old sentence while its own P3.2 section a hundred lines below
		// said the opposite: the repo's inventory of record contradicting itself
		// within one page, which is worse than either half being wrong alone.
		//
		// Pinned against the composition-time refusal rather than restated as prose,
		// so a third refused value (or a second one becoming derivable) fails here
		// instead of quietly making the paragraph false again.
		const catalog = read('apps/api/convex/lib/sendProviders/catalog.ts');
		const refusal = /function assertPluginDispatchSemanticsAreGeneral[\s\S]*?\n}/.exec(catalog);
		expect(refusal, 'the composition-time refusal is gone').not.toBeNull();
		expect(refusal![0]).toContain("'accepted'");
		expect(refusal![0]).toContain("'idempotency-key'");
		expect(refusal![0]).not.toContain('domainVerification');

		// Wrapping-insensitive: the claim is the sentence, not where the paragraph
		// happens to break.
		const unwrapped = abstractions.replace(/\s+/g, ' ');
		expect(unwrapped).toContain(
			"`acceptanceSemantics: 'accepted'` and `messageIdSource: 'idempotency-key'` — are not in this tier's unions at all"
		);
		// And the derivation the refusal does NOT cover has to be stated, because
		// that is the fact codegen implements.
		expect(unwrapped).toContain('`hasProviderFeedback` and `domainVerification` are DERIVED');
		expect(read('packages/plugin-codegen/src/renderSendTransport.ts')).toContain(
			"domainVerification: transport.domainIdentity === undefined ? undefined : 'api'"
		);
	});
});

/**
 * A `### `-level section of the page, heading to next heading.
 *
 * BOUNDED BY `## ` TOO, because the LAST `###` under a `##` has no `###` after
 * it: without the second bound its "section" runs to the end of the page and
 * swallows every following top-level section, so a table added three sections
 * away fails the assertion on this one.
 */
function pageSection(heading: string): string {
	const start = abstractions.indexOf(heading);
	expect(start, `the ${heading} section is gone`).toBeGreaterThan(-1);
	const ends = ['\n### ', '\n## ']
		.map((marker) => abstractions.indexOf(marker, start + 1))
		.filter((index) => index !== -1);
	return abstractions.slice(start, ends.length === 0 ? undefined : Math.min(...ends));
}

/** The `### Sending-domain identity providers` section, heading to next heading. */
function sendingDomainSection(): string {
	return pageSection('### Sending-domain identity providers');
}

/**
 * The sending-domain provider registry is the second provider seam on the page,
 * and the one the page used to omit entirely while listing the older
 * `EmailProvider` factory it long outgrew. Same treatment as the send-provider
 * row above: the kinds are read from the registry, so a fourth adapter folder
 * that never reaches the docs fails here rather than being discovered by the
 * next person who trusts the page.
 */
describe('docs/abstractions.md: the sending-domain provider section matches the registry', () => {
	const kinds = registryKeys('apps/api/convex/providers/domainIdentity.ts', 'const primary = {');
	const section = sendingDomainSection();

	// Same split as the send-provider block above: `registryKeys` owns the
	// non-vacuity assertion, this case owns membership.
	it('parses the ses adapter out of the registry', () => {
		expect(kinds).toContain('ses');
	});

	it('lists exactly the sending-domain adapters the registry ships', () => {
		// Anchored on the ENUMERATION rather than on punctuation. The previous
		// version matched any all-lowercase code span followed by `,` or `)`
		// anywhere in the section, so an ordinary prose edit ("a kind declaring
		// `api`, …") failed the test as a registry mismatch — blaming the registry
		// for a sentence.
		const enumeration = /one adapter folder per kind \(([^)]+)\)/.exec(section);
		expect(enumeration, 'the section no longer enumerates the adapter folders').not.toBeNull();
		const listed = [...enumeration![1]!.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
		expect(listed.sort()).toEqual([...kinds].sort());
	});

	it('names the capability that decides which adapters must prove a relay domain', () => {
		// The page's claim is that the obligation is DECLARED and compile-enforced;
		// these are the two names a reader has to be able to grep for.
		expect(abstractions).toContain("domainVerification: 'api' | 'none'");
		expect(abstractions).toContain('RelayProvingProviderModule');
		const types = 'apps/api/convex/domains/providers/types.ts';
		expect(existsSync(resolve(repoRoot, types))).toBe(true);
		expect(read(types)).toContain('export type RelayProvingProviderModule');
	});

	it('names the second registry and the host-owned half of the plugin tier', () => {
		// The page's P3.2 claim is that there are TWO questions with two registries:
		// the closed primary union above, and the composed relay-identity one a
		// bundled plugin transport joins. A reader who conflates them widens the
		// wrong one, so both names have to be greppable — and both have to exist.
		expect(section).toContain('relayIdentityProviderFor');
		expect(section).toContain('RelayIdentityProviderModule');
		const registry = read('apps/api/convex/domains/providers/index.ts');
		expect(registry).toContain('export function relayIdentityProviderFor');
		expect(read('apps/api/convex/domains/providers/relayIdentityTypes.ts')).toContain(
			'export interface RelayIdentityProviderModule'
		);
		// And it is NOT on the primary contract: the two questions live in two files
		// so that widening one cannot be done by editing the other.
		expect(read('apps/api/convex/domains/providers/types.ts')).not.toContain(
			'export interface RelayIdentityProviderModule'
		);

		// The freshness bound is the one thing at this tier a manifest may not
		// declare, and the page says so by name. Asserted against the constant, so
		// a later move of it to the contract fails here rather than leaving the page
		// promising a fence that no longer exists.
		expect(section).toContain('PLUGIN_RELAY_PROOF_MAX_AGE_MS');
		const state = 'apps/api/convex/domains/providers/plugin/state.ts';
		expect(existsSync(resolve(repoRoot, state))).toBe(true);
		expect(read(state)).toContain('export const PLUGIN_RELAY_PROOF_MAX_AGE_MS');
		expect(read('packages/plugin-kit/src/sendTransportDomainIdentity.ts')).not.toContain(
			'maxProofAgeMs'
		);
	});

	it('keeps the sibling-table claim honest about the readers outside the adapters', () => {
		// The section used to say an SES-shaped READ of the frozen sibling sat
		// OUTSIDE `domains/providers/`, and pinned that in both directions against
		// `providerRoutes.ts`. It no longer does, so the guard flips with it: the
		// page now claims the read half is encapsulated, and that claim is a fact
		// about WHERE the sibling read lives.
		const routes = read('apps/api/convex/providerRoutes.ts');
		const stillReadsTheSibling = routes.includes("query('sendingDomainSesIdentities')");
		expect(stillReadsTheSibling, 'the SES sibling read is back outside the adapters').toBe(false);
		expect(read('apps/api/convex/domains/providers/ses/relayIdentityView.ts')).toContain(
			"query('sendingDomainSesIdentities')"
		);
		// The two names a reader has to be able to grep for: the seam a kind
		// implements, and the one query that walks the registry asking it.
		expect(section).toContain('describeRelayIdentity');
		expect(section).toContain('listRelayDomainIdentities');
		expect(read('apps/api/convex/domains/providers/relayIdentityTypes.ts')).toContain(
			'describeRelayIdentity?('
		);
		expect(section).toContain('sendingDomainSesIdentities');
		expect(section).toContain('sendingDomainRelayIdentities');
	});

	it('names the forward-provisioning effect exactly while it is a hand-written list', () => {
		// The page's warning that registering an adapter does not by itself put a
		// kind on the FORWARD relay-provisioning path is a fact about
		// `domains/lifecycle.ts` — true only while
		// `provision_relay_identity_if_enabled` schedules from a hand-written list
		// of relay kinds. So, like the two sibling-table claims around it, it is
		// asserted against that file in BOTH directions: while such a list is there
		// the page must name the effect; while it is a registry walk (as it is
		// today) the page must NOT, rather than telling the next author that a new
		// kind's `ensureRelayIdentity` is unreachable on the forward path when it
		// is not. The guard is what keeps a reintroduced if-chain from landing
		// silently.
		const lifecycle = read('apps/api/convex/domains/lifecycle.ts');
		const stillAHandWrittenList = lifecycle.includes("relayKinds.has('ses')");
		expect(section.includes('provision_relay_identity_if_enabled')).toBe(stillAHandWrittenList);
	});

	it('keeps the sibling-table claim honest about the writers outside the adapters', () => {
		// The write half is the one a developer adding relay kind #4 acts on: the
		// page must not let them believe `writeIdentity` is the whole write path
		// while the relay provisioning inserts the row from `sesRelayMutations.ts`
		// (it still does — no card owns folding that insert behind the adapter).
		// Pinned in BOTH directions against that file, so that the page must stop
		// naming it the moment the insert moves — the same treatment the reader
		// half gets above.
		const mutations = read('apps/api/convex/domains/sesRelayMutations.ts');
		const stillWritesOutsideTheAdapter = mutations.includes("insert('sendingDomainSesIdentities'");
		expect(section.includes('sesRelayMutations')).toBe(stillWritesOutsideTheAdapter);
	});

	it('marks the superseded EmailProvider row as legacy rather than as a peer seam', () => {
		// The row sits ABOVE this section in the canonical provider table, so a
		// developer adding provider #4 reads it first. There is no `EmailProvider`
		// interface left in the tree; leaving the row unqualified is how someone
		// writes an implementation of it instead of an adapter folder.
		const row = abstractions.split('\n').find((line) => line.startsWith('| `EmailProvider`'));
		expect(row, 'the EmailProvider row is gone — drop this case with it').toBeDefined();
		expect(row).toContain('superseded');
		expect(row).toContain('domains/providers/');
	});
});

/**
 * The feedback plane is the third provider seam on the page, and the newest
 * (the seams plan's P2.1 replaced four hand-wired `httpAction` files with this
 * registry). Same treatment as the two seams above — the kinds are read from the
 * registry, so an adapter that never reaches the docs fails here rather than
 * being discovered by the next person who trusts the page.
 */
describe('docs/abstractions.md: the feedback adapter section matches the registry', () => {
	const kinds = coreCatalogEntries()
		.filter((entry) => entry.body.includes('hasProviderFeedback: true'))
		.map((entry) => entry.kind);
	const feedbackSection = pageSection('### Provider feedback (webhook) adapters');

	// `registryKeys` owns the non-vacuity assertion; this case owns membership.
	// `mandrill` is the kind whose arrival is what made a fourth copy of the same
	// two-line entry point untenable.
	it('parses the mandrill adapter out of the registry', () => {
		expect(kinds).toContain('mandrill');
	});

	it('lists exactly the feedback adapters the registry ships', () => {
		const enumeration = /one adapter file per kind \(([^)]+)\)/.exec(feedbackSection);
		expect(enumeration, 'the section no longer enumerates the adapter files').not.toBeNull();
		const listed = [...enumeration![1]!.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
		expect(listed.sort()).toEqual([...kinds].sort());
	});

	it('names the capability that decides which kinds must ship an adapter', () => {
		// The page's claim is that the obligation is DECLARED and compile-enforced;
		// this is the name a reader has to be able to grep for, and the file that
		// has to still contain it.
		expect(feedbackSection).toContain('FeedbackReportingSendProviderKind');
		const catalog = 'apps/api/convex/lib/sendProviders/catalog.ts';
		expect(existsSync(resolve(repoRoot, catalog))).toBe(true);
		expect(read(catalog)).toContain('export type FeedbackReportingSendProviderKind');
	});

	it('still states the static-route rule, and points at a gate that exists', () => {
		// The page's other claim is that each kind's route is WRITTEN OUT rather
		// than derived, because those URLs are already pasted into provider
		// consoles we do not own. This case deliberately does NOT re-assert that
		// against `http.ts`: the assertion lives once, in
		// `apps/api/convex/lib/sendProviders/__tests__/feedbackRoutes.test.ts` —
		// the package whose change would break it, and the one
		// `scripts/ci-select-affected.sh` selects for an apps/api pull request.
		// A copy here could only restate it as `/webhooks/${kind}`, which is the
		// derivation the seam exists to forbid: the day a renamed kind keeps its
		// old URL — the exact case this protects — the copy would fail demanding
		// a route under the NEW name, i.e. a second route, and the console would
		// still be pointing at the first.
		//
		// What the page uniquely owes a reader is that the rule is still written
		// down beside a gate that still exists.
		expect(feedbackSection).toContain('routes stay static and per kind');
		const gate = 'apps/api/convex/lib/sendProviders/__tests__/feedbackRoutes.test.ts';
		expect(feedbackSection).toContain('__tests__/feedbackRoutes.test.ts');
		expect(existsSync(resolve(repoRoot, gate))).toBe(true);
	});
});

/** One source's row as its own module declares it. */
interface DeclaredSignalSource {
	readonly key: string;
	readonly kind: string;
	readonly behaviour: string;
}

/**
 * Resolve an `absence:` expression to the behaviour it declares.
 *
 * Two forms exist in the tree and both have to be followed, because a parser
 * that gave up on one would silently agree with whatever the page happened to
 * say for those rows: an INLINE object literal (read the `behaviour:` inside
 * it) and a CALL to a local absence builder — `COUNTER_ABSENCE(…)`,
 * `sndsAbsence(…)`, `yahooAbsence(…)` — whose own definition, in the same
 * module, declares the behaviour every call site gets.
 */
function absenceBehaviour(source: string, expression: string, after: number): string {
	const behaviourAfter = (from: number, what: string): string => {
		const match = /behaviour: '([a-z]+)'/.exec(source.slice(from));
		expect(match, `no absence behaviour found for ${what}`).not.toBeNull();
		return match![1]!;
	};
	if (expression.startsWith('{')) return behaviourAfter(after, 'an inline absence');
	const helper = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(expression)?.[1];
	expect(helper, `unparsable absence expression: ${expression}`).toBeDefined();
	const definition = new RegExp(`(?:const|function) ${helper}\\b`).exec(source);
	expect(definition, `${helper} is not defined in the module that calls it`).not.toBeNull();
	return behaviourAfter(definition!.index, helper!);
}

/**
 * Every signal source a module declares, as `key` / `kind` / absence behaviour.
 *
 * The three fields are declared adjacently and in that order in every source
 * (the ramp's carry a `gate` between the first two), which is what makes a
 * two-regex parse honest here: the page's Kind and Absence columns get the same
 * treatment as its Key column instead of being checked only for plausibility.
 */
function declaredSignalSources(relativePath: string): DeclaredSignalSource[] {
	const source = read(relativePath);
	const declarations = [
		...source.matchAll(
			/\bkey: '([a-z_]+)',\n(?:\s*gate: '[a-z_]+',\n)?\s*kind: '([a-z]+)',\n\s*absence: ([^\n]+)/g
		),
	];
	expect(declarations.length, `no signal sources parsed out of ${relativePath}`).toBeGreaterThan(0);
	return declarations.map((match) => ({
		key: match[1]!,
		kind: match[2]!,
		behaviour: absenceBehaviour(source, match[3]!.trim(), match.index + match[0].length),
	}));
}

/**
 * The signal-source registry is the fourth provider seam on the page and the
 * only one about EVIDENCE rather than dispatch, so the failure mode is the same
 * but the consequence is worse: a source the page omits is a reading an operator
 * does not know the deployment is taking, and an absence row the page invents is
 * a promise about a deployment that never configured it.
 *
 * The registry is keyed by the shared vocabulary rather than by camelCase
 * adapter names, so it needs its own two-line parser rather than `registryKeys`.
 */
describe('docs/abstractions.md: the signal-source section matches the registry', () => {
	const registrySource = read('apps/api/convex/delivery/signals/registry.ts');
	const declaration = 'export const SIGNAL_SOURCES';
	const start = registrySource.indexOf(declaration);
	expect(start, `the registry no longer declares ${declaration}`).toBeGreaterThan(-1);
	const body = registrySource.slice(start, registrySource.indexOf('\n};', start));
	// The ramp's five are SPREAD in from the record gate evaluation folds, so they
	// are read where they are declared — the shared-vocabulary list — and only the
	// provider feeds are named in the record literal itself.
	const spreadsRampGates = body.includes('...RAMP_GATE_SIGNALS');
	const typesSource = read('apps/api/convex/delivery/signals/types.ts');
	const vocabulary = 'export const RAMP_GATE_SIGNAL_KEYS = [';
	const vocabularyStart = typesSource.indexOf(vocabulary);
	expect(vocabularyStart, `the contract no longer declares ${vocabulary}`).toBeGreaterThan(-1);
	const rampKeys = [
		...typesSource
			.slice(vocabularyStart, typesSource.indexOf('] as const', vocabularyStart))
			.matchAll(/'([a-z_]+)'/g),
	].map((match) => match[1]!);
	const named = [...body.matchAll(/^\t([a-z][a-z_]*): /gm)].map((match) => match[1]!);
	const keys = spreadsRampGates ? [...rampKeys, ...named] : named;
	const section = pageSection('### Deliverability signal sources');

	// The declaring modules, read for all three columns. The registry itself only
	// re-exports the sources, so `kind` and `absence` are where each source is
	// built — which is also where a later piece would change them.
	const declared = new Map<string, DeclaredSignalSource>(
		[
			'apps/api/convex/delivery/signals/rampGateSources.ts',
			'apps/api/convex/delivery/signals/yahooCfl.ts',
			'apps/api/convex/delivery/signals/postmaster.ts',
		].flatMap((path) => declaredSignalSources(path).map((source) => [source.key, source] as const))
	);

	/** The page's table, as key → the Kind and Absence it prints. */
	const tabulated = new Map(
		[...section.matchAll(/^\| `([a-z_]+)`\s*\| `([a-z]+)`\s*\| `([a-z]+)`/gm)].map((match) => [
			match[1]!,
			{ kind: match[2]!, behaviour: match[3]! },
		])
	);

	it('parses the registered sources out of the registry', () => {
		expect(keys.length, 'no keys parsed out of SIGNAL_SOURCES').toBeGreaterThan(1);
		// The provider feeds are the reason the seam declares absence at all,
		// and the ramp's own measurements are the other half of the inventory.
		expect(keys).toEqual(expect.arrayContaining(['yahoo_cfl', 'google_postmaster']));
		expect(keys).toEqual(expect.arrayContaining(['bounce_rate', 'seed_placement']));
		// Registered once, listed once: a key both spread in and named again would
		// silently double a row's worth of expectation.
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('parses a kind and an absence for every registered source', () => {
		// The row parser is the load-bearing half of the two tests below: a
		// declaration it stopped matching would leave that source's Kind and
		// Absence columns unchecked, which is exactly the state this replaced.
		expect([...declared.keys()].sort()).toEqual([...keys].sort());
	});

	it('tabulates exactly the sources the registry declares', () => {
		const listed = [...section.matchAll(/^\| `([a-z_]+)`\s*\|/gm)].map((match) => match[1]!);
		expect(listed.sort()).toEqual([...keys].sort());
		// Every listed row parsed all three columns; a row whose Kind or Absence
		// stopped being a bare code span would otherwise drop out of the comparison.
		expect([...tabulated.keys()].sort()).toEqual(listed.sort());
	});

	it('prints the family and the absence each source actually declares', () => {
		// Not "is one of the three families": a source whose `kind` a later piece
		// changes from `advisory` to `outcome` when it wires SNDS into gate 3 — or
		// an absence flipped from `omit` to `hold` — moves the ramp's share while
		// the page keeps stating the old promise. Both columns are compared per
		// key, the same treatment the key column gets.
		for (const [key, source] of declared) {
			expect(
				['infrastructure', 'outcome', 'advisory'],
				`${key} declares an unknown kind`
			).toContain(source.kind);
			expect(tabulated.get(key), `${key} is missing from the table`).toEqual({
				kind: source.kind,
				behaviour: source.behaviour,
			});
		}
	});

	it('states the two promises the seam is worth having', () => {
		// Non-blocking absence is the invariant; the deferred plugin bucket is the
		// decision a reader would otherwise re-litigate.
		expect(section).toContain('isBlocking: false');
		expect(section).toContain('no plugin bucket');
		const gate = 'apps/api/convex/delivery/signals/__tests__/signalRegistry.test.ts';
		expect(section).toContain('signals/__tests__/signalRegistry.test.ts');
		expect(existsSync(resolve(repoRoot, gate))).toBe(true);
	});
});
