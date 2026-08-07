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

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	isPluginSendTransportEnvVar,
	parsePluginId,
	PLUGIN_SEND_TRANSPORT_CAPABILITY,
} from '@owlat/plugin-kit';
import type { PluginPackageName } from '@owlat/plugin-host';
import { describe, expect, it } from 'vitest';
import { toCamelCase } from '../names';
import { buildScaffold, parseScaffoldTemplate, SCAFFOLD_TEMPLATES } from '../scaffold';
import { PluginCliError } from '../errors';
import {
	SCAFFOLD_FORMATTED_ID_MAX_LENGTH,
	SEND_PROVIDER_ENV_CONSTANTS,
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
		const env = sendProviderEnvVars(sendProviderNames(id));
		for (const name of [env.apiKey, env.region, env.webhookSecret]) {
			expect(isPluginSendTransportEnvVar(name), `${name} is not a legal transport variable`).toBe(
				true
			);
		}
		// The enablement switch is the PLUGIN's, not the transport's: it is read
		// unsuffixed and the validator refuses it in the transport's own lists.
		expect(file('src/manifest.ts')).toContain(`${SEND_PROVIDER_ENV_CONSTANTS.enabled},`);
		expect(file('src/envNames.ts')).toContain(`'${env.enabled}'`);
	});

	/**
	 * THE NAMESPACE LIVES IN THE VALUE, THE ROLE IN THE IDENTIFIER — and the two
	 * halves of that split are joined here.
	 *
	 * The emitted constants are named for what they are (`API_KEY_ENV`) so no line
	 * width grows with the plugin id, which only works while `envNames.ts` binds
	 * each of those identifiers to the id-derived variable name the manifest
	 * validator and the host actually resolve. A generator that renamed one side
	 * would emit a package that does not compile, or — worse — one that compiles
	 * against a variable no deployment sets.
	 */
	it('binds each role-named constant to the namespaced variable it stands for', () => {
		const env = sendProviderEnvVars(sendProviderNames(id));
		const envNames = file('src/envNames.ts');
		for (const role of ['apiKey', 'region', 'webhookSecret', 'enabled'] as const) {
			expect(envNames).toContain(
				`export const ${SEND_PROVIDER_ENV_CONSTANTS[role]} = '${env[role]}';`
			);
		}
		// And every module that reads one imports it from there rather than spelling
		// the string — the rename that would otherwise fail silently.
		for (const path of ['src/manifest.ts', 'src/convex/transport.ts']) {
			expect(file(path), `${path} spells a variable name instead of importing it`).not.toContain(
				`'${env.apiKey}'`
			);
			expect(file(path)).toContain(SEND_PROVIDER_ENV_CONSTANTS.apiKey);
		}
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
			const env = sendProviderEnvVars(sendProviderNames(parsed));
			for (const name of [env.apiKey, env.region, env.webhookSecret]) {
				expect(isPluginSendTransportEnvVar(name), `${name} rejected for id ${candidate}`).toBe(
					true
				);
			}
		}
	);

	/**
	 * EVERY IDENTIFIER FROM THE ONE INPUT. The emitted manifest exports
	 * `<camel>Plugin` and the emitted `index.ts` re-exports it by name, so a second
	 * source for the camel-case form is a package that does not compile. The
	 * derivation is asserted through the shipped `toCamelCase` rather than against a
	 * spelled expectation, and the join is read off the two emitted files.
	 */
	it('derives every identifier from the plugin id alone', () => {
		const names = sendProviderNames(id);
		expect(names.camel).toBe(toCamelCase(id));
		expect(file('src/manifest.ts')).toContain(`export const ${names.camel}Plugin = definePlugin({`);
		expect(file('src/index.ts')).toBe(`export { ${names.camel}Plugin } from './manifest';\n`);
	});

	/**
	 * PRIVATE AT BOTH TEMPLATES, because `create` cannot emit anywhere else:
	 * `resolveTargetDir` refuses a directory outside the workspace and the default
	 * is `examples/plugins/<id>`, so what the generator writes is always a workspace
	 * member — one `release:cut` would version and `changeset publish` would publish
	 * beside the real packages. `private` is what stops that, and the emitted
	 * manifest is workspace-bound anyway (`workspace:*`, `catalog:`), so publishing
	 * is the last step of MOVING OUT rather than a step on its own.
	 *
	 * The emitted README is what carries that, so it is read here: a template that
	 * dropped `private` without teaching the move-out would ship the accident, and
	 * one that kept `private` without documenting the removal would leave an author
	 * with a package npm refuses and no sentence explaining why.
	 */
	it('emits a private package and tells its author how to publish one', () => {
		for (const manifest of [
			file('package.json'),
			buildScaffold(root, targetDir, id, packageName).get('package.json')!,
		]) {
			expect(JSON.parse(manifest)).toEqual(expect.objectContaining({ private: true }));
		}
		const readme = file('README.md');
		expect(readme).toContain('delete `"private": true`');
		expect(readme).toContain('`workspace:*`');
		// The manifest really does carry what the README says to replace, so the
		// instruction cannot go stale against the file it describes.
		const manifest = JSON.parse(file('package.json')) as Record<string, Record<string, string>>;
		expect(Object.values(manifest['dependencies'] ?? {})).toContain('workspace:*');
		expect(Object.values(manifest['devDependencies'] ?? {})).toContain('catalog:');
	});

	/**
	 * ALREADY FORMATTED, PROVED WITH THE REPOSITORY'S OWN FORMATTER.
	 *
	 * `create` scaffolds INTO this workspace (`resolveTargetDir` allows nothing
	 * else), and `scripts/check-format.sh` collects untracked files — so an emitted
	 * bundle that is not oxfmt-clean fails `bun run lint` for an author who has not
	 * yet typed a character. Asserting it with the real binary rather than a line
	 * counter is what makes it a claim about the gate rather than about widths: the
	 * checked config, the checked width, the checked quote and tab rules.
	 *
	 * THE LONG ID IS THE POINT of the second case. Every emitted identifier that
	 * could grow with the plugin id was deliberately named for its role instead, and
	 * a template edit that reintroduced an id-derived one would pass at `acme-relay`
	 * and fail here.
	 */
	describe('is oxfmt-clean as emitted', () => {
		const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
		const oxfmt = join(repositoryRoot, 'node_modules', '.bin', 'oxfmt');

		it.each([
			['acme-relay', 'the id the authoring guide tells an author to scaffold'],
			['a'.repeat(SCAFFOLD_FORMATTED_ID_MAX_LENGTH), 'the longest id the bound covers'],
		])('emits formatted TypeScript for %s (%s)', async (candidate) => {
			expect(existsSync(oxfmt), `${oxfmt} is missing; run bun install`).toBe(true);
			const parsed = parsePluginId(candidate);
			// Generated for the DEFAULT target directory, because the paths that
			// position depends on (`tsconfig.json`'s `extends`, the vitest alias) are
			// themselves lines the formatter measures.
			const files = buildScaffold(
				repositoryRoot,
				join(repositoryRoot, 'examples', 'plugins', parsed),
				parsed,
				packageName,
				'send-provider'
			);
			const directory = await mkdtemp(join(tmpdir(), 'owlat-scaffold-format-'));
			try {
				const written: string[] = [];
				for (const [path, content] of files) {
					if (!path.endsWith('.ts')) continue;
					const absolute = join(directory, ...path.split('/'));
					await mkdir(dirname(absolute), { recursive: true });
					await writeFile(absolute, content, 'utf8');
					written.push(absolute);
				}
				expect(written.length).toBeGreaterThan(8);
				const result = spawnSync(
					oxfmt,
					['--config', join(repositoryRoot, 'oxfmtrc.json'), '--check', ...written],
					{ encoding: 'utf8' }
				);
				expect(
					result.status,
					`${result.stdout ?? ''}${result.stderr ?? ''}`.replaceAll(directory, '<scaffold>')
				).toBe(0);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		});
	});

	/**
	 * THE CAPABILITY, THROUGH THE KIT'S OWN CONSTANT rather than the string. It is
	 * what the guide's sample shows, and a scaffolded manifest that spelled the
	 * literal would teach an author to hand-write a value the kit already exports.
	 */
	it('declares its capability through the exported constant', () => {
		expect(file('src/manifest.ts')).toContain(
			'import { definePlugin, PLUGIN_SEND_TRANSPORT_CAPABILITY }'
		);
		expect(file('src/manifest.ts')).toContain('capabilities: [PLUGIN_SEND_TRANSPORT_CAPABILITY]');
		expect(PLUGIN_SEND_TRANSPORT_CAPABILITY).toBe('send:transport');
	});

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
