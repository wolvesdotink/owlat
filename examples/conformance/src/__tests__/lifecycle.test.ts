/**
 * Lifecycle conformance: clean install -> add -> disable -> upgrade -> remove.
 *
 * Every scenario runs the SHIPPED code against a real disposable deployment:
 * `@owlat/plugin-cli`'s `add`/`remove` (including `--dry-run` capability diffs)
 * rewrite the real `plugins.config.ts`, and `@owlat/plugin-codegen` regenerates
 * the real composition files from the verified, lockfile-pinned manifests.
 *
 * The assertions are about OUTCOMES an operator can observe: which plugins the
 * deployment composes, which contributions the backend and frontend see, what
 * the capability diff says before a change is written, and that codegen's
 * `--check` mode reports staleness rather than silently drifting.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dispatchFinite } from '@owlat/plugin-cli/run';
import { generatePluginComposition, PluginCodegenError } from '@owlat/plugin-codegen';
import {
	composeBundledPlugins,
	getBundledPluginFeatureFlagDefinitions,
	runWithPluginFeatureFlag,
} from '@owlat/plugin-host';
import { galleryEntry, REFERENCE_GALLERY } from '../gallery';
import {
	cleanupDeployments,
	createDeployment,
	createGalleryDeployment,
	fileExists,
	readBundledPackages,
	readWorkspaceFile,
} from '../workspace';

const CONVEX_COMPOSITION = 'apps/api/convex/plugins/plugins.generated.ts';
const NUXT_COMPOSITION = 'apps/web/app/plugins/plugin-composition.generated.ts';
const AGENT_STEP_CATALOG = 'apps/api/convex/plugins/agentStepCatalog.generated.ts';
const AGENT_STEP_MODULES = 'apps/api/convex/plugins/agentStepModules.generated.ts';
const CRON_CATALOG = 'apps/api/convex/plugins/cronCatalog.generated.ts';
const AUTONOMY_GATE_CATALOG = 'apps/api/convex/plugins/autonomyGateCatalog.generated.ts';
const WEBHOOK_EVENT_CATALOG = 'apps/api/convex/plugins/webhookEventCatalog.generated.ts';

const TIER_1 = galleryEntry(1);
const TIER_2 = galleryEntry(2);
const TIER_3 = galleryEntry(3);

function captureIo() {
	const lines: string[] = [];
	const errors: string[] = [];
	return {
		io: { log: (message: string) => lines.push(message), error: (m: string) => errors.push(m) },
		lines,
		errors,
		text: () => lines.join('\n'),
	};
}

async function cli(
	workspaceRoot: string,
	command: string,
	argv: readonly string[]
): Promise<ReturnType<typeof captureIo>> {
	const captured = captureIo();
	await dispatchFinite(command, argv, { workspaceRoot, io: captured.io });
	return captured;
}

afterAll(cleanupDeployments);

describe('clean install', () => {
	it('generates an empty, valid composition when nothing is bundled', async () => {
		const root = await createGalleryDeployment(REFERENCE_GALLERY);
		await generatePluginComposition(root);

		const convex = await readWorkspaceFile(root, CONVEX_COMPOSITION);
		expect(convex).toContain('bundledPluginComposition');
		for (const entry of REFERENCE_GALLERY) expect(convex).not.toContain(entry.manifest.id);
		expect(await readWorkspaceFile(root, NUXT_COMPOSITION)).not.toContain('escalation-guard');
		// A clean checkout is immediately consistent: --check must pass.
		await expect(generatePluginComposition(root, { check: true })).resolves.toBeUndefined();
	});

	it('reports a stale composition instead of silently accepting drift', async () => {
		const root = await createGalleryDeployment(REFERENCE_GALLERY, [TIER_1.packageName]);
		await expect(generatePluginComposition(root, { check: true })).rejects.toBeInstanceOf(
			PluginCodegenError
		);
		await generatePluginComposition(root);
		await expect(generatePluginComposition(root, { check: true })).resolves.toBeUndefined();
	});

	it('refuses a bundled package that is not installed', async () => {
		const root = await createDeployment({ installed: [], bundled: [TIER_1.packageName] });
		await expect(generatePluginComposition(root)).rejects.toMatchObject({
			code: 'dependency_missing',
		});
	});

	it('refuses a bundled package whose lockfile artifact does not match', async () => {
		const root = await createDeployment({
			installed: [{ packageName: TIER_1.packageName, manifest: TIER_1.manifest }],
			bundled: [TIER_1.packageName],
		});
		const lock = JSON.parse(await readWorkspaceFile(root, 'bun.lock')) as {
			packages: Record<string, unknown[]>;
		};
		// Named error rather than `!`: if the harness ever stopped pinning the
		// package in bun.lock, the tamper would apply to undefined and this case
		// would die with a TypeError in its setup instead of reporting that the
		// fixture no longer reproduces a published install.
		const artifact = lock.packages[TIER_1.packageName];
		if (!artifact) {
			throw new Error(`bun.lock has no artifact for ${TIER_1.packageName}`);
		}
		artifact[3] = 'sha512-not-a-real-integrity';
		await writeFile(join(root, 'bun.lock'), JSON.stringify(lock));
		await expect(generatePluginComposition(root)).rejects.toMatchObject({
			code: 'dependency_provenance',
		});
	});
});

describe('add', () => {
	it('previews the capability diff without writing anything on --dry-run', async () => {
		const root = await createGalleryDeployment(REFERENCE_GALLERY);
		const before = await readWorkspaceFile(root, 'plugins.config.ts');

		const preview = await cli(root, 'add', [TIER_1.packageName, '--dry-run']);
		expect(preview.text()).toContain(TIER_1.packageName);
		expect(preview.text()).toContain('agent:step');
		expect(preview.text()).toContain('Dry run');
		expect(await readWorkspaceFile(root, 'plugins.config.ts')).toBe(before);
		expect(await readBundledPackages(root)).toEqual([]);
	});

	it('writes the package, then codegen exposes exactly its contributions', async () => {
		const root = await createGalleryDeployment(REFERENCE_GALLERY);
		await cli(root, 'add', [TIER_1.packageName]);
		expect(await readBundledPackages(root)).toEqual([TIER_1.packageName]);

		await generatePluginComposition(root);
		const convex = await readWorkspaceFile(root, CONVEX_COMPOSITION);
		expect(convex).toContain('escalation-guard');

		expect(await readWorkspaceFile(root, AGENT_STEP_CATALOG)).toContain(
			'plugin.escalation-guard.escalation-check'
		);
		expect(await readWorkspaceFile(root, AGENT_STEP_MODULES)).toContain(
			`${TIER_1.packageName}/agentStep`
		);
		expect(await readWorkspaceFile(root, WEBHOOK_EVENT_CATALOG)).toContain(
			'plugin.escalation-guard.escalation-raised'
		);
		// The Tier-1 reference contributes no cron and no send gate; those catalogs
		// must stay empty rather than inheriting another plugin's entries.
		expect(await readWorkspaceFile(root, CRON_CATALOG)).not.toContain('escalation-guard');
		expect(await readWorkspaceFile(root, AUTONOMY_GATE_CATALOG)).not.toContain('escalation-guard');
	});

	it('is idempotent: re-adding the same package writes nothing', async () => {
		const root = await createGalleryDeployment(REFERENCE_GALLERY, [TIER_1.packageName]);
		const before = await readWorkspaceFile(root, 'plugins.config.ts');
		const repeat = await cli(root, 'add', [TIER_1.packageName]);
		expect(repeat.text()).toContain('nothing to do');
		expect(await readWorkspaceFile(root, 'plugins.config.ts')).toBe(before);
	});

	it('adds a second plugin and reports only the newly requestable capabilities', async () => {
		const root = await createGalleryDeployment(REFERENCE_GALLERY, [TIER_1.packageName]);
		const preview = await cli(root, 'add', [TIER_3.packageName, '--dry-run']);
		// send:gate, scheduler:cron and worker:enqueue arrive with the Tier-3 plugin;
		// llm:invoke is already requestable, so it is NOT reported as new.
		expect(preview.text()).toContain('send:gate');
		expect(preview.text()).toContain('worker:enqueue');
		const addedSection = preview.text().split('Removed')[0] ?? '';
		expect(addedSection).toContain('scheduler:cron');

		await cli(root, 'add', [TIER_3.packageName]);
		await generatePluginComposition(root);
		const gates = await readWorkspaceFile(root, AUTONOMY_GATE_CATALOG);
		expect(gates).toContain('plugin.deliverability-lab.seed-list-preflight');
		expect(await readWorkspaceFile(root, CRON_CATALOG)).toContain(
			'plugin.deliverability-lab.refresh-seed-scores'
		);
	});

	it('composes a Tier-2 connected app without adding any in-process contribution', async () => {
		const root = await createGalleryDeployment(REFERENCE_GALLERY);
		await cli(root, 'add', [TIER_2.packageName]);
		await generatePluginComposition(root);

		expect(await readWorkspaceFile(root, CONVEX_COMPOSITION)).toContain('slack-approvals');
		for (const path of [AGENT_STEP_CATALOG, CRON_CATALOG, AUTONOMY_GATE_CATALOG]) {
			expect(await readWorkspaceFile(root, path), path).not.toContain('slack-approvals');
		}
	});

	it('rejects an add whose proposed set would be invalid, leaving the config untouched', async () => {
		const root = await createDeployment({
			installed: [
				{ packageName: TIER_1.packageName, manifest: TIER_1.manifest },
				// Same manifest id under a second package name: a duplicate-id composition.
				{ packageName: '@owlat/example-escalation-guard-fork', manifest: TIER_1.manifest },
			],
			bundled: [TIER_1.packageName],
		});
		await expect(cli(root, 'add', ['@owlat/example-escalation-guard-fork'])).rejects.toBeDefined();
		expect(await readBundledPackages(root)).toEqual([TIER_1.packageName]);
	});
});

describe('disable', () => {
	it('keeps the generated frontend composition importing the manifest of a bundled plugin', async () => {
		// Disablement is a RUNTIME flag decision, not a build one: a bundled plugin
		// is in the generated composition whether or not its flag is on — the
		// operator has to be able to see it in order to enable it — and the
		// frontend reads enablement from the flag at render time. Only bundling
		// changes the generated file, which is what the two halves below show.
		const bundled = await createGalleryDeployment(REFERENCE_GALLERY, [TIER_1.packageName]);
		await generatePluginComposition(bundled);
		const withPlugin = await readWorkspaceFile(bundled, NUXT_COMPOSITION);
		expect(withPlugin).toContain(TIER_1.packageName);
		expect(withPlugin).toContain('bundledPluginComposition');

		const unbundled = await createGalleryDeployment(REFERENCE_GALLERY);
		await generatePluginComposition(unbundled);
		const withoutPlugin = await readWorkspaceFile(unbundled, NUXT_COMPOSITION);
		expect(withoutPlugin).not.toContain(TIER_1.packageName);
		expect(withoutPlugin).toContain('bundledPluginComposition');
	});

	it('registers every reference behind its own namespaced flag, defaulting off', () => {
		const plugins = composeBundledPlugins(
			REFERENCE_GALLERY.map((entry) => ({
				packageName: entry.packageName,
				manifest: entry.manifest,
			}))
		);
		const flags = getBundledPluginFeatureFlagDefinitions(plugins);
		expect(flags.map((flag) => flag.key).sort()).toEqual([
			'plugin.deliverability-lab',
			'plugin.escalation-guard',
			'plugin.slack-approvals',
		]);
		for (const flag of flags) {
			expect(flag.default, flag.key).toBe(false);
			expect(flag.category).toBe('plugins');
		}
	});

	it('refuses to run a disabled plugin contribution, and runs an enabled one', async () => {
		const disabled = { isEnabled: () => false };
		const enabled = { isEnabled: () => true };
		for (const entry of REFERENCE_GALLERY) {
			await expect(
				runWithPluginFeatureFlag(disabled, entry.manifest.id, () => 'ran')
			).rejects.toMatchObject({ code: 'plugin_disabled' });
			await expect(runWithPluginFeatureFlag(enabled, entry.manifest.id, () => 'ran')).resolves.toBe(
				'ran'
			);
		}
	});

	it('fails closed when the flag lookup itself fails', async () => {
		const broken = {
			isEnabled: () => {
				throw new Error('flag store unavailable');
			},
		};
		await expect(
			runWithPluginFeatureFlag(broken, TIER_1.manifest.id, () => 'ran')
		).rejects.toMatchObject({ code: 'feature_check_failed' });
	});

	it('treats a non-boolean enablement answer as disabled', async () => {
		const fuzzy = { isEnabled: () => 'yes' as unknown as boolean };
		await expect(
			runWithPluginFeatureFlag(fuzzy, TIER_1.manifest.id, () => 'ran')
		).rejects.toMatchObject({ code: 'plugin_disabled' });
	});
});

describe('upgrade', () => {
	it('picks up a new manifest version and its added contribution', async () => {
		const upgraded = {
			...TIER_1.manifest,
			version: '0.2.0',
			contributes: {
				...TIER_1.manifest.contributes,
				webhookEvents: [
					...(TIER_1.manifest.contributes?.webhookEvents ?? []),
					{
						id: 'escalation-cleared',
						description: 'A previously flagged message was cleared by a reviewer.',
						subscribable: true,
					},
				],
			},
		};
		const root = await createDeployment({
			installed: [{ packageName: TIER_1.packageName, manifest: upgraded, version: '0.2.0' }],
			bundled: [TIER_1.packageName],
		});
		await generatePluginComposition(root);

		const events = await readWorkspaceFile(root, WEBHOOK_EVENT_CATALOG);
		expect(events).toContain('plugin.escalation-guard.escalation-raised');
		expect(events).toContain('plugin.escalation-guard.escalation-cleared');
		// The upgraded version is what the deployment now pins and resolves.
		expect(await readWorkspaceFile(root, 'bun.lock')).toContain(`${TIER_1.packageName}@0.2.0`);
	});

	it('surfaces a capability added by an upgrade through the same diff an add uses', async () => {
		const widened = {
			...TIER_1.manifest,
			version: '0.3.0',
			capabilities: [...TIER_1.manifest.capabilities, 'scheduler:cron' as const],
			contributes: {
				...TIER_1.manifest.contributes,
				crons: [
					{
						id: 'sweep',
						label: 'Sweep stale escalations',
						module: { exportPath: './cron' },
						schedule: { intervalMinutes: 60 },
						timeoutMs: 30_000,
					},
				],
			},
		};
		const root = await createDeployment({
			installed: [{ packageName: TIER_1.packageName, manifest: widened, version: '0.3.0' }],
		});
		const preview = await cli(root, 'add', [TIER_1.packageName, '--dry-run']);
		expect(preview.text()).toContain('scheduler:cron');
		expect(await readBundledPackages(root)).toEqual([]);
	});

	it('refuses an upgrade whose manifest no longer validates', async () => {
		const broken = { ...TIER_1.manifest, version: 'not-a-semver' };
		const root = await createDeployment({
			installed: [{ packageName: TIER_1.packageName, manifest: broken, version: '0.4.0' }],
			bundled: [TIER_1.packageName],
		});
		await expect(generatePluginComposition(root)).rejects.toMatchObject({
			code: 'invalid_manifest',
		});
	});
});

describe('remove', () => {
	it('previews the removal, then drops every contribution on codegen', async () => {
		const root = await createGalleryDeployment(REFERENCE_GALLERY, [
			TIER_1.packageName,
			TIER_3.packageName,
		]);
		await generatePluginComposition(root);
		expect(await readWorkspaceFile(root, AGENT_STEP_CATALOG)).toContain('escalation-guard');

		const preview = await cli(root, 'remove', [TIER_1.packageName, '--dry-run']);
		expect(preview.text()).toContain('Dry run');
		expect(await readBundledPackages(root)).toEqual([TIER_1.packageName, TIER_3.packageName]);

		await cli(root, 'remove', [TIER_1.packageName]);
		expect(await readBundledPackages(root)).toEqual([TIER_3.packageName]);

		await generatePluginComposition(root);
		expect(await readWorkspaceFile(root, AGENT_STEP_CATALOG)).not.toContain('escalation-guard');
		expect(await readWorkspaceFile(root, WEBHOOK_EVENT_CATALOG)).not.toContain('escalation-guard');
		// The plugin that stayed keeps every one of its own contributions.
		expect(await readWorkspaceFile(root, AUTONOMY_GATE_CATALOG)).toContain(
			'plugin.deliverability-lab.seed-list-preflight'
		);
	});

	it('is idempotent: removing an absent package writes nothing', async () => {
		const root = await createGalleryDeployment(REFERENCE_GALLERY);
		const before = await readWorkspaceFile(root, 'plugins.config.ts');
		const repeat = await cli(root, 'remove', [TIER_1.packageName]);
		expect(repeat.text()).toContain('nothing to do');
		expect(await readWorkspaceFile(root, 'plugins.config.ts')).toBe(before);
	});

	it('returns the deployment to its clean-install state after add then remove', async () => {
		const root = await createGalleryDeployment(REFERENCE_GALLERY);
		await generatePluginComposition(root);
		const clean = await Promise.all(
			[CONVEX_COMPOSITION, NUXT_COMPOSITION, AGENT_STEP_CATALOG, WEBHOOK_EVENT_CATALOG].map(
				(path) => readWorkspaceFile(root, path)
			)
		);

		await cli(root, 'add', [TIER_1.packageName]);
		await generatePluginComposition(root);
		await cli(root, 'remove', [TIER_1.packageName]);
		await generatePluginComposition(root);

		const after = await Promise.all(
			[CONVEX_COMPOSITION, NUXT_COMPOSITION, AGENT_STEP_CATALOG, WEBHOOK_EVENT_CATALOG].map(
				(path) => readWorkspaceFile(root, path)
			)
		);
		expect(after).toEqual(clean);
		expect(await fileExists(root, CONVEX_COMPOSITION)).toBe(true);
	});

	it('rejects a malformed package argument before touching the config', async () => {
		const root = await createGalleryDeployment(REFERENCE_GALLERY, [TIER_1.packageName]);
		await expect(cli(root, 'add', ['../escape'])).rejects.toBeDefined();
		await expect(cli(root, 'remove', ['NOT-LOWERCASE'])).rejects.toBeDefined();
		expect(await readBundledPackages(root)).toEqual([TIER_1.packageName]);
	});
});
