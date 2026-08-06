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

/** The registry keys in `SEND_PROVIDERS`, read from the registry itself. */
function coreSendProviderKinds(): string[] {
	const source = read('apps/api/convex/lib/sendProviders/index.ts');
	const start = source.indexOf('export const SEND_PROVIDERS = {');
	expect(start, 'sendProviders/index.ts no longer declares SEND_PROVIDERS').toBeGreaterThan(-1);
	const body = source.slice(start, source.indexOf('} as const;', start));
	return [...body.matchAll(/^\t([a-z][a-zA-Z0-9]*): /gm)].map((match) => match[1]!);
}

describe('docs/abstractions.md: the send-provider row matches the registry', () => {
	const kinds = coreSendProviderKinds();

	it('derives a non-trivial core adapter set from the registry', () => {
		expect(kinds.length).toBeGreaterThan(1);
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

/** The registry keys in `SENDING_DOMAIN_PROVIDERS`, read from the registry itself. */
function sendingDomainProviderKinds(): string[] {
	const source = read('apps/api/convex/domains/providers/index.ts');
	const start = source.indexOf('export const SENDING_DOMAIN_PROVIDERS = {');
	expect(start, 'domains/providers/index.ts no longer declares the registry').toBeGreaterThan(-1);
	const body = source.slice(start, source.indexOf('} as const;', start));
	return [...body.matchAll(/^\t([a-z][a-zA-Z0-9]*): /gm)].map((match) => match[1]!);
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
	const kinds = sendingDomainProviderKinds();

	it('derives a non-trivial adapter set from the registry', () => {
		expect(kinds.length).toBeGreaterThan(1);
		expect(kinds).toContain('ses');
	});

	it('lists exactly the sending-domain adapters the registry ships', () => {
		const heading = '### Sending-domain identity providers';
		const start = abstractions.indexOf(heading);
		expect(start, 'the sending-domain provider section is gone').toBeGreaterThan(-1);
		const end = abstractions.indexOf('\n### ', start + 1);
		const section = abstractions.slice(start, end === -1 ? undefined : end);
		// The kind list, and only it: an all-lowercase code span closing a
		// comma-or-paren-delimited enumeration. Table and type names in the same
		// section are camelCase, so they cannot be mistaken for a kind.
		const listed = [...section.matchAll(/`([a-z][a-z0-9]*)`(?=[,)])/g)].map((match) => match[1]!);
		expect([...new Set(listed)].sort()).toEqual([...kinds].sort());
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
});
