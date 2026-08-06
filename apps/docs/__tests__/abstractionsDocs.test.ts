import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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
	const kinds = registryKeys(
		'apps/api/convex/lib/sendProviders/index.ts',
		'export const SEND_PROVIDERS = {'
	);

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
});

/** The `### Sending-domain identity providers` section, heading to next heading. */
function sendingDomainSection(): string {
	const heading = '### Sending-domain identity providers';
	const start = abstractions.indexOf(heading);
	expect(start, 'the sending-domain provider section is gone').toBeGreaterThan(-1);
	const end = abstractions.indexOf('\n### ', start + 1);
	return abstractions.slice(start, end === -1 ? undefined : end);
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
	const kinds = registryKeys(
		'apps/api/convex/domains/providers/index.ts',
		'export const SENDING_DOMAIN_PROVIDERS = {'
	);
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

	it('keeps the sibling-table claim honest about the readers outside the adapters', () => {
		// The section says an SES-shaped READ of the frozen sibling still sits
		// outside `domains/providers/`. That exception is a fact about
		// `providerRoutes.ts`, so it is asserted against that file in BOTH
		// directions: while the read is still there the page must name it, and
		// once P1.2 makes the read generic the page must stop.
		const routes = read('apps/api/convex/providerRoutes.ts');
		const stillReadsTheSibling = routes.includes("query('sendingDomainSesIdentities')");
		expect(section.includes('listDeliverabilityRelayDomains')).toBe(stillReadsTheSibling);
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
