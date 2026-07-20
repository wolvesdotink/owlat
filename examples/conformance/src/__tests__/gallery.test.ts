/**
 * Gallery invariants — the properties that make the examples a maintained
 * reference set rather than three unrelated demos.
 *
 * These run over the REAL manifests, so a change to any example is checked here
 * as well as in its own package.
 */

import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeBundledPlugins, createPluginPermissionService } from '@owlat/plugin-host';
import {
	parsePluginManifest,
	PLUGIN_CONTRIBUTION_KINDS,
	PLUGIN_LIVE_CONTRIBUTION_KINDS,
	validatePluginManifest,
} from '@owlat/plugin-kit';
import {
	contributionExportPaths,
	galleryEntry,
	readCoreNavSectionKeys,
	REFERENCE_GALLERY,
	UNCOVERED_LIVE_BUCKETS,
} from '../gallery';
import { readRepositoryFile, REPOSITORY_ROOT } from '../repository';

describe('reference gallery coverage', () => {
	it('ships exactly one maintained reference per tier', () => {
		expect(REFERENCE_GALLERY.map((entry) => entry.tier)).toEqual([1, 2, 3]);
		expect(new Set(REFERENCE_GALLERY.map((entry) => entry.packageName)).size).toBe(3);
		expect(galleryEntry(1).manifest.id).toBe('escalation-guard');
		expect(galleryEntry(2).manifest.id).toBe('slack-approvals');
		expect(galleryEntry(3).manifest.id).toBe('deliverability-lab');
	});

	it('gives every reference a manifest the host validator accepts', () => {
		for (const entry of REFERENCE_GALLERY) {
			expect(() => parsePluginManifest(entry.manifest), entry.packageName).not.toThrow();
		}
	});

	it('keeps every reference off by default so an operator opts in', () => {
		for (const entry of REFERENCE_GALLERY) {
			expect(entry.manifest.flag?.default, entry.packageName).toBe(false);
		}
	});

	it('composes all three into one deployment with stable, id-sorted order', () => {
		const composed = composeBundledPlugins(
			REFERENCE_GALLERY.map((entry) => ({
				packageName: entry.packageName,
				manifest: entry.manifest,
			}))
		);
		expect(composed.map((plugin) => plugin.manifest.id)).toEqual([
			'deliverability-lab',
			'escalation-guard',
			'slack-approvals',
		]);
	});

	it('exercises the real contribution buckets rather than stubbing them', () => {
		const used = new Set(
			REFERENCE_GALLERY.flatMap((entry) => Object.keys(entry.manifest.contributes ?? {}))
		);
		for (const bucket of used) expect(PLUGIN_CONTRIBUTION_KINDS).toContain(bucket);
		// Ten of the twelve buckets with a live host runtime; the two the gallery
		// does not cover are named, with their reason, in UNCOVERED_LIVE_BUCKETS
		// and pinned by the next case.
		expect([...used].sort()).toEqual([
			'agentSteps',
			'automationConditions',
			'automationSteps',
			'automationTriggers',
			'crons',
			'draftStrategies',
			'navItems',
			'sendGates',
			'settingsPanels',
			'webhookEvents',
		]);
	});

	it('leaves exactly the declared live buckets uncovered, for a stated reason', () => {
		// The live set is DERIVED from the kernel's capability-requirement table
		// (@owlat/plugin-kit), never copied: adding a thirteenth live bucket there,
		// or dropping a contribution from a reference manifest, fails here naming
		// the bucket instead of silently widening the gallery's blind spot.
		const covered = new Set(
			REFERENCE_GALLERY.flatMap((entry) => Object.keys(entry.manifest.contributes ?? {}))
		);
		const uncovered = PLUGIN_LIVE_CONTRIBUTION_KINDS.filter((kind) => !covered.has(kind));

		expect([...uncovered].sort()).toEqual(Object.keys(UNCOVERED_LIVE_BUCKETS).sort());
		for (const [bucket, reason] of Object.entries(UNCOVERED_LIVE_BUCKETS)) {
			expect(PLUGIN_LIVE_CONTRIBUTION_KINDS, bucket).toContain(bucket);
			expect(reason.length, `${bucket} must state why it has no reference`).toBeGreaterThan(20);
		}
	});

	it('gives the Tier-2 connected app no in-process contributions at all', () => {
		const connectedApp = galleryEntry(2);
		// Derived from the manifest, never a hand-maintained flag that could go
		// stale: a Tier-2 connected app runs out of process and re-enters Owlat
		// only as a restrict-only hook verdict, so it ships no in-process module.
		expect(connectedApp.manifest.contributes).toBeUndefined();
		expect(contributionExportPaths(connectedApp.manifest)).toEqual([]);
	});

	it('gives every in-process reference at least one contribution module', () => {
		for (const entry of REFERENCE_GALLERY) {
			if (entry.tier === 2) continue;
			expect(contributionExportPaths(entry.manifest).length, entry.packageName).toBeGreaterThan(0);
		}
	});

	it('never lets two references claim the same plugin id, nav href, or event kind', () => {
		const ids = REFERENCE_GALLERY.map((entry) => entry.manifest.id);
		expect(new Set(ids).size).toBe(ids.length);

		const hrefs = REFERENCE_GALLERY.flatMap((entry) => [
			...(entry.manifest.contributes?.navItems ?? []).map((item) => item.href),
			...(entry.manifest.contributes?.settingsPanels ?? []).map((panel) => panel.href),
		]);
		expect(new Set(hrefs).size).toBe(hrefs.length);

		const eventKinds = REFERENCE_GALLERY.flatMap((entry) =>
			(entry.manifest.contributes?.webhookEvents ?? []).map(
				(event) => `plugin.${entry.manifest.id}.${event.id}`
			)
		);
		expect(new Set(eventKinds).size).toBe(eventKinds.length);
	});

	it('targets only core sidebar sections, so no nav entry is silently dropped', async () => {
		// Read from apps/web, not copied: renaming a core section key must turn
		// THIS test red, because the host would start dropping the entry.
		const coreSections = await readCoreNavSectionKeys();
		expect(coreSections).toContain('inbox');

		const sections = REFERENCE_GALLERY.flatMap((entry) =>
			(entry.manifest.contributes?.navItems ?? []).map((item) => item.section)
		);
		expect(sections.length).toBeGreaterThan(0);
		for (const section of sections) expect(coreSections).toContain(section);
	});

	it('keeps every contributed destination an internal dashboard path', () => {
		for (const entry of REFERENCE_GALLERY) {
			const hrefs = [
				...(entry.manifest.contributes?.navItems ?? []).map((item) => item.href),
				...(entry.manifest.contributes?.settingsPanels ?? []).map((panel) => panel.href),
			];
			for (const href of hrefs) expect(href, entry.packageName).toMatch(/^\/dashboard\//);
		}
	});
});

describe('published package shape', () => {
	interface ExamplePackageJson {
		readonly version?: unknown;
		readonly exports?: Record<string, unknown>;
	}

	async function readPackageJson(directory: string): Promise<ExamplePackageJson> {
		return JSON.parse(await readRepositoryFile(`${directory}/package.json`)) as ExamplePackageJson;
	}

	/**
	 * Narrow one export entry to the string it must be, naming the package in the
	 * failure. `expect(typeof x).toBe('string')` asserts but does not narrow, so
	 * without this a non-string export would make the following matcher throw a
	 * TypeError instead of failing the assertion it was written for.
	 */
	function requireStringExport(
		exports: Record<string, unknown> | undefined,
		key: string,
		label: string
	): string {
		const target = exports?.[key];
		if (typeof target !== 'string') {
			throw new Error(
				`${label}: exports[${JSON.stringify(key)}] must be a string, got ${
					target === undefined ? 'nothing' : typeof target
				}`
			);
		}
		return target;
	}

	// The loader (packages/plugin-codegen/src/packageProvenance.ts) resolves a
	// bundled plugin through condition-INDEPENDENT export strings and refuses a
	// conditional root export with `conditional_manifest_export`. The conformance
	// harness installs a fixture built to that rule, so without these two cases a
	// reference could publish a shape the harness never sees and the real loader
	// would refuse.
	it('exposes its manifest through one condition-independent root export', async () => {
		for (const entry of REFERENCE_GALLERY) {
			const { exports } = await readPackageJson(entry.directory);
			const root = requireStringExport(exports, '.', `${entry.packageName} root export`);
			expect(root, entry.packageName).toMatch(/^\.\//);
		}
	});

	// `workspace.ts` installs every fixture at its MANIFEST version and writes
	// that same string into package.json, bun.lock and the integrity input, so
	// the harness only reproduces a published reference while the two agree. The
	// loader does not cross-check them, which is exactly why nothing else would
	// notice them drifting apart.
	it('publishes at the version its manifest declares', async () => {
		for (const entry of REFERENCE_GALLERY) {
			const { version } = await readPackageJson(entry.directory);
			expect(version, `${entry.packageName} package version`).toBe(entry.manifest.version);
		}
	});

	it('exposes every contribution module its manifest names, as a real file', async () => {
		for (const entry of REFERENCE_GALLERY) {
			const { exports } = await readPackageJson(entry.directory);
			for (const exportPath of contributionExportPaths(entry.manifest)) {
				const target = requireStringExport(
					exports,
					exportPath,
					`${entry.packageName} ${exportPath}`
				);
				const relative = target.replace(/^\.\//, '');
				await expect(
					access(join(REPOSITORY_ROOT, entry.directory, relative)),
					`${entry.packageName} ${exportPath} -> ${target}`
				).resolves.toBeUndefined();
			}
		}
	});
});

describe('reference documentation', () => {
	// Each reference README is a tutorial source, so every command it prints in
	// inline code has to be one an operator can actually run. The executable name
	// is READ FROM the CLI package's `bin` rather than copied here: renaming the
	// binary then fails this suite instead of leaving the READMEs telling
	// operators to run a command that does not exist.
	async function shippedCliBinaries(): Promise<readonly string[]> {
		const { bin } = JSON.parse(await readRepositoryFile('packages/plugin-cli/package.json')) as {
			readonly bin?: Record<string, string>;
		};
		const names = Object.keys(bin ?? {});
		expect(names.length, 'packages/plugin-cli declares no bin').toBeGreaterThan(0);
		return names;
	}

	// A `./…` printed in a README's contribution table reads as a subpath import
	// of the published package. A row naming a subpath the package does not export
	// teaches an author to declare a module the loader cannot resolve, so the
	// documented modules are checked against the real `exports` map.
	it('never documents a contribution module the package does not export', async () => {
		for (const entry of REFERENCE_GALLERY) {
			const { exports } = JSON.parse(
				await readRepositoryFile(`${entry.directory}/package.json`)
			) as { readonly exports?: Record<string, unknown> };
			const readme = await readRepositoryFile(`${entry.directory}/README.md`);
			const rows = readme.split('\n').filter((line) => line.startsWith('|'));
			if (entry.manifest.contributes) {
				// A reference that contributes must document what it contributes; the
				// Tier-2 connected app ships no in-process module and no such table.
				expect(
					rows.length,
					`${entry.directory}/README.md documents no contributions`
				).toBeGreaterThan(0);
			}

			for (const row of rows) {
				for (const match of row.matchAll(/`(\.\/[^`]+)`/g)) {
					const documented = match[1];
					if (documented === undefined) continue;
					expect(
						Object.keys(exports ?? {}),
						`${entry.directory}/README.md documents ${documented}`
					).toContain(documented);
				}
			}
		}
	});

	it('only prints Owlat commands the CLI package actually ships', async () => {
		const binaries = await shippedCliBinaries();
		for (const entry of REFERENCE_GALLERY) {
			const readme = await readRepositoryFile(`${entry.directory}/README.md`);
			// Inline-code spans that open an `owlat…` command. The separator keeps
			// `owlat.hook.*` protocol strings, which are not commands, out of it.
			for (const match of readme.matchAll(/`(owlat[ -][^`]*)`/g)) {
				const invocation = match[1];
				if (invocation === undefined) continue;
				const executable = invocation.trim().split(/\s+/)[0];
				expect(binaries, `${entry.directory}/README.md: \`${invocation}\``).toContain(executable);
			}
		}
	});
});

describe('gallery capability ceilings', () => {
	it('declares a capability for every contribution bucket a reference uses', () => {
		// Differential against the shipped validator rather than a hand-written
		// bucket→capability map: for each bucket a reference contributes to, every
		// declared capability is dropped in turn and the manifest re-validated. The
		// capability whose removal makes the validator object at `$.capabilities`
		// IS the one the kernel requires for that bucket — read out of the kernel,
		// so a renamed capability constant keeps this honest instead of pinning a
		// string the host no longer uses.
		for (const entry of REFERENCE_GALLERY) {
			for (const [bucket, contributions] of Object.entries(entry.manifest.contributes ?? {})) {
				const scoped = { ...entry.manifest, contributes: { [bucket]: contributions } };
				expect(validatePluginManifest(scoped).ok, `${entry.packageName}:${bucket}`).toBe(true);

				const required = entry.manifest.capabilities.filter((capability) => {
					const result = validatePluginManifest({
						...scoped,
						capabilities: entry.manifest.capabilities.filter((declared) => declared !== capability),
					});
					return (
						!result.ok &&
						result.issues.some(
							(issue) => issue.path === '$.capabilities' && issue.message.includes(capability)
						)
					);
				});

				expect(required, `${entry.packageName}:${bucket} required capabilities`).toHaveLength(1);
			}
		}
	});

	it('declares an LLM budget exactly when it requests llm:invoke', () => {
		for (const entry of REFERENCE_GALLERY) {
			const wantsLlm = entry.manifest.capabilities.includes('llm:invoke');
			expect(entry.manifest.llmBudget !== undefined, entry.packageName).toBe(wantsLlm);
			if (entry.manifest.llmBudget) {
				expect(entry.manifest.llmBudget.dailyUsd).toBeGreaterThan(0);
			}
		}
	});

	it('grants nothing by default and rejects a grant outside the manifest', () => {
		for (const entry of REFERENCE_GALLERY) {
			const ungranted = createPluginPermissionService({
				pluginId: entry.manifest.id,
				declaredCapabilities: entry.manifest.capabilities,
				grants: [],
			});
			for (const capability of entry.manifest.capabilities) {
				expect(ungranted.has(capability), `${entry.packageName}:${capability}`).toBe(false);
				expect(() => ungranted.require(capability)).toThrow();
			}
			expect(() =>
				createPluginPermissionService({
					pluginId: entry.manifest.id,
					declaredCapabilities: entry.manifest.capabilities,
					grants: [{ capability: 'admin:everything', granted: true }],
				})
			).toThrow();
		}
	});

	it('lets an operator grant narrow — never widen — the declared ceiling', () => {
		const entry = galleryEntry(1);
		const [first, ...rest] = entry.manifest.capabilities;
		if (!first) throw new Error('the Tier-1 reference must declare a capability');
		const firstCapability = first;
		const permissions = createPluginPermissionService({
			pluginId: entry.manifest.id,
			declaredCapabilities: entry.manifest.capabilities,
			grants: [
				{ capability: firstCapability, granted: true },
				...rest.map((capability) => ({ capability, granted: false })),
			],
		});
		expect(permissions.has(firstCapability)).toBe(true);
		for (const capability of rest) expect(permissions.has(capability)).toBe(false);
	});

	it('never lets a reference request an ambient credential capability', () => {
		for (const entry of REFERENCE_GALLERY) {
			for (const capability of entry.manifest.capabilities) {
				expect(capability, entry.packageName).not.toMatch(/(secret|credential|env|admin)/);
			}
		}
	});
});
