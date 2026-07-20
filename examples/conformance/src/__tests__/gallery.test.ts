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
import { parsePluginManifest, PLUGIN_CONTRIBUTION_KINDS } from '@owlat/plugin-kit';
import {
	contributionExportPaths,
	galleryEntry,
	readCoreNavSectionKeys,
	REFERENCE_GALLERY,
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
		// Every bucket with a live host runtime is covered by some reference.
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

	it('gives the Tier-2 connected app no in-process contributions at all', () => {
		const connectedApp = galleryEntry(2);
		expect(connectedApp.hasBundledContributions).toBe(false);
		expect(connectedApp.manifest.contributes).toBeUndefined();
		expect(contributionExportPaths(connectedApp.manifest)).toEqual([]);
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
		readonly exports?: Record<string, unknown>;
	}

	async function readPackageJson(directory: string): Promise<ExamplePackageJson> {
		return JSON.parse(await readRepositoryFile(`${directory}/package.json`)) as ExamplePackageJson;
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
			const root = exports?.['.'];
			expect(typeof root, `${entry.packageName} root export`).toBe('string');
			expect(root as string, entry.packageName).toMatch(/^\.\//);
		}
	});

	it('exposes every contribution module its manifest names, as a real file', async () => {
		for (const entry of REFERENCE_GALLERY) {
			const { exports } = await readPackageJson(entry.directory);
			for (const exportPath of contributionExportPaths(entry.manifest)) {
				const target = exports?.[exportPath];
				expect(typeof target, `${entry.packageName} ${exportPath}`).toBe('string');
				const relative = (target as string).replace(/^\.\//, '');
				await expect(
					access(join(REPOSITORY_ROOT, entry.directory, relative)),
					`${entry.packageName} ${exportPath} -> ${target as string}`
				).resolves.toBeUndefined();
			}
		}
	});
});

describe('gallery capability ceilings', () => {
	it('declares a capability for every contribution bucket a reference uses', () => {
		const requiredCapability: Readonly<Record<string, string>> = {
			agentSteps: 'agent:step',
			automationConditions: 'automation:condition',
			automationSteps: 'automation:step',
			automationTriggers: 'automation:trigger',
			crons: 'scheduler:cron',
			draftStrategies: 'draft:strategy',
			navItems: 'ui:navigation',
			sendGates: 'send:gate',
			settingsPanels: 'ui:settings',
			webhookEvents: 'webhooks:publish',
		};
		for (const entry of REFERENCE_GALLERY) {
			for (const bucket of Object.keys(entry.manifest.contributes ?? {})) {
				const capability = requiredCapability[bucket];
				expect(capability, `${entry.packageName} uses unmapped bucket ${bucket}`).toBeDefined();
				expect(entry.manifest.capabilities, `${entry.packageName}:${bucket}`).toContain(capability);
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
