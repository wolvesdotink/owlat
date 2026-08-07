/**
 * The `send-provider` template's generator contract (the seams plan's P3.4).
 *
 * WHAT THIS SUITE OWNS AND WHAT IT DOES NOT. It owns the GENERATOR: determinism,
 * the emitted file set, the package export map that codegen provenance-verifies,
 * and the environment-variable naming rule the manifest validator holds a
 * declaration to — asserted through `@owlat/plugin-kit`'s own predicate rather
 * than against a copied regex, so a tightened namespace lands here.
 *
 * It does NOT own the claim that the emitted bundle WORKS. That claim is only
 * meaningful against the shipped host, and it is
 * `examples/conformance/src/__tests__/scaffoldedProviderConformance.test.ts`,
 * which writes this generator's output to a directory, imports it, composes it
 * through the real host and renderer, and drives the result through routing,
 * dispatch, the feedback route and the identity registry — unmodified.
 */

import { join } from 'node:path';
import { isPluginSendTransportEnvVar, parsePluginId } from '@owlat/plugin-kit';
import type { PluginPackageName } from '@owlat/plugin-host';
import { describe, expect, it } from 'vitest';
import { buildScaffold, parseScaffoldTemplate, SCAFFOLD_TEMPLATES } from '../scaffold';
import { PluginCliError } from '../errors';
import {
	SEND_PROVIDER_MODULE_EXPORTS,
	sendProviderEnvVars,
	sendProviderNames,
} from '../scaffoldSendProvider';

const root = '/workspace';
const targetDir = join(root, 'examples', 'plugins', 'acme-relay');
const id = parsePluginId('acme-relay');
const packageName = '@acme/owlat-relay' as PluginPackageName;

function scaffold() {
	return buildScaffold(root, targetDir, id, packageName, 'send-provider');
}

function file(path: string): string {
	const content = scaffold().get(path);
	if (content === undefined) throw new Error(`the template emits no ${path}`);
	return content;
}

describe('parseScaffoldTemplate', () => {
	it('accepts every declared template and names the set on a miss', () => {
		for (const template of SCAFFOLD_TEMPLATES) {
			expect(parseScaffoldTemplate(template)).toBe(template);
		}
		expect(() => parseScaffoldTemplate('sendprovider')).toThrow(PluginCliError);
		expect(() => parseScaffoldTemplate('sendprovider')).toThrow(/Unknown template/);
	});
});

describe('the send-provider template', () => {
	it('is deterministic for identical inputs', () => {
		expect([...scaffold().entries()]).toEqual([...scaffold().entries()]);
	});

	it('emits the whole bundle: three executable halves, one declaration, four suites', () => {
		expect([...scaffold().keys()].sort()).toEqual([
			'README.md',
			'package.json',
			'src/__tests__/domainIdentity.test.ts',
			'src/__tests__/manifest.test.ts',
			'src/__tests__/transport.test.ts',
			'src/__tests__/webhook.test.ts',
			'src/convex/domainIdentity.ts',
			'src/convex/transport.ts',
			'src/convex/webhook.ts',
			'src/envNames.ts',
			'src/index.ts',
			'src/manifest.ts',
			'tsconfig.json',
			'vitest.config.ts',
		]);
	});

	it('leaves the minimal template alone', () => {
		// The default is unchanged by this piece, and a caller that omits the
		// template argument still gets it — which is what keeps every shipped
		// `create` invocation behaving exactly as it did.
		const minimal = buildScaffold(root, targetDir, id, packageName);
		expect([...minimal.keys()].sort()).toEqual([
			'README.md',
			'package.json',
			'src/__tests__/manifest.test.ts',
			'src/index.ts',
			'src/manifest.ts',
			'tsconfig.json',
			'vitest.config.ts',
		]);
		expect(JSON.parse(minimal.get('package.json') ?? '{}').exports).toEqual({
			'.': './src/index.ts',
		});
	});

	/**
	 * THE JOIN CODEGEN ENFORCES AT INSTALL TIME, pinned at generation time.
	 *
	 * A contribution's executable half is imported through a condition-independent
	 * package export STRING, and the loader refuses a manifest naming an export the
	 * package does not declare. A template whose manifest and `package.json`
	 * disagreed would scaffold cleanly and fail only once someone tried to bundle
	 * it — so the manifest's export paths are read out of the emitted manifest and
	 * required to be exactly the package's non-root exports.
	 */
	it('exports every module its manifest names, and nothing else', () => {
		const exports = JSON.parse(file('package.json')).exports as Record<string, string>;
		expect(exports['.']).toBe('./src/index.ts');
		expect(exports).toEqual({ '.': './src/index.ts', ...SEND_PROVIDER_MODULE_EXPORTS });

		const declared = [...file('src/manifest.ts').matchAll(/exportPath: '([^']+)'/g)].map(
			(match) => match[1]!
		);
		expect(declared.length).toBe(3);
		expect(new Set(declared)).toEqual(new Set(Object.keys(SEND_PROVIDER_MODULE_EXPORTS)));
		// And each export target is a file this template actually emits.
		for (const target of Object.values(SEND_PROVIDER_MODULE_EXPORTS)) {
			expect(scaffold().has(target.replace(/^\.\//, ''))).toBe(true);
		}
	});

	/**
	 * THE NAMING RULE, ASKED OF THE KIT rather than restated.
	 *
	 * `isPluginSendTransportEnvVar` is the predicate the manifest validator and the
	 * host's artifact re-check both use: the `PLUGIN_` namespace fence, the length
	 * cap, no `__` (which would make a base name addressable as another
	 * transport's instance credential) and no trailing `_`. A generated name that
	 * failed it would produce a package that cannot be validated at all.
	 */
	it("generates transport variables the kit's own fence accepts", () => {
		const env = sendProviderEnvVars(sendProviderNames(id, 'acmeRelay'));
		for (const name of [env.apiKey, env.region, env.webhookSecret]) {
			expect(isPluginSendTransportEnvVar(name), `${name} is not a legal transport variable`).toBe(
				true
			);
		}
		// The enablement switch is the PLUGIN's, not the transport's: it is read
		// unsuffixed and the validator refuses it in the transport's own lists.
		expect(file('src/manifest.ts')).toContain(`${env.enabled}_ENV,`);
		expect(file('src/envNames.ts')).toContain(`'${env.enabled}'`);
	});

	/**
	 * Every id `create` accepts must produce a manifest the kit accepts. The three
	 * shapes below are the ones the fence could plausibly reject — a single-segment
	 * id, one with digits, and the longest id `parsePluginId` allows.
	 */
	it.each([['a'], ['acme2-relay3'], ['a'.repeat(64)], ['x-y-z-w']])(
		'generates legal variables for the id %s',
		(candidate) => {
			const parsed = parsePluginId(candidate);
			const env = sendProviderEnvVars(sendProviderNames(parsed, 'ignored'));
			for (const name of [env.apiKey, env.region, env.webhookSecret]) {
				expect(isPluginSendTransportEnvVar(name), `${name} rejected for id ${candidate}`).toBe(
					true
				);
			}
		}
	);

	it('reads its credentials from the instance configuration, never process.env', () => {
		// The rule that makes named instances mean anything: an environment read in
		// a module resolves the deployment-default instance whichever id the send
		// was addressed to. The template must not teach the wrong shape.
		// A READ, not the word: the emitted prose names `process.env` precisely to
		// tell an author not to use it, and a check that punished the warning would
		// delete the explanation.
		for (const path of [
			'src/convex/transport.ts',
			'src/convex/webhook.ts',
			'src/convex/domainIdentity.ts',
		]) {
			expect(file(path), `${path} reads the environment directly`).not.toMatch(
				/process\.env\s*[.[]/
			);
		}
		expect(file('src/convex/transport.ts')).toContain('config.env[');
		expect(file('src/convex/domainIdentity.ts')).toContain('config.env[');
	});

	it('names every remaining vendor decision as a TODO', () => {
		// The template's promise to its author: what is left is marked where it
		// belongs. A half that carried none would be a half nobody edits.
		for (const path of [
			'src/manifest.ts',
			'src/convex/transport.ts',
			'src/convex/webhook.ts',
			'src/convex/domainIdentity.ts',
		]) {
			expect(file(path), `${path} carries no TODO`).toContain('TODO');
		}
	});
});
