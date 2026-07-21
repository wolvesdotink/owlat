import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PLUGIN_LIVE_CONTRIBUTION_KINDS, pluginContributionModules } from '@owlat/plugin-kit';
import { loadBundledPlugins } from '../packageLoader';
import {
	cleanupPackageLoaderWorkspaces,
	createPackageLoaderWorkspace,
} from './packageLoaderFixtures';

afterEach(cleanupPackageLoaderWorkspaces);

/**
 * Provenance verification must cover EVERY bucket that ships an executable
 * module, not the five somebody remembered to write a loop for.
 *
 * Codegen emits `import bundledPluginX from "<pkg>/<exportPath>"` into generated
 * Convex code for crons and all three automation registries too. Until this
 * suite landed, those four export paths reached the generated import without
 * `verifyPluginStaticExport` resolving them through the installed package's
 * `exports` map, rejecting a condition-dependent target, or asserting the
 * resolved file lives inside the package root.
 *
 * The fixtures below are driven off one table, and the last case asserts the
 * table covers every bucket the loader considers executable — so a bucket added
 * by a later piece cannot slip through with no fixture.
 */
interface ExecutableBucketFixture {
	readonly bucket: string;
	readonly packageName: string;
	readonly capability: string;
	readonly contributes: string;
	readonly exportPath: string;
	readonly filePath: string;
}

const FIXTURES: readonly ExecutableBucketFixture[] = [
	{
		bucket: 'sendTransports',
		packageName: 'transport-plugin',
		capability: 'send:transport',
		contributes: `sendTransports: [{ id: 'relay', label: 'Relay', module: { exportPath: './convex/transport' }, retryDelays: [] }]`,
		exportPath: './convex/transport',
		filePath: 'convex/transport.js',
	},
	{
		bucket: 'agentSteps',
		packageName: 'step-plugin',
		capability: 'agent:step',
		contributes: `agentSteps: [{ id: 'triage', after: 'security_scan', module: { exportPath: './convex/step' }, lifecycleEdges: [] }]`,
		exportPath: './convex/step',
		filePath: 'convex/step.js',
	},
	{
		bucket: 'draftStrategies',
		packageName: 'strategy-plugin',
		capability: 'draft:strategy',
		contributes: `draftStrategies: [{ id: 'careful', label: 'Careful', module: { exportPath: './convex/strategy' }, timeoutMs: 5000 }]`,
		exportPath: './convex/strategy',
		filePath: 'convex/strategy.js',
	},
	{
		bucket: 'sendGates',
		packageName: 'gate-plugin',
		capability: 'send:gate',
		contributes: `sendGates: [{ id: 'hold', label: 'Hold', module: { exportPath: './convex/gate' }, timeoutMs: 5000 }]`,
		exportPath: './convex/gate',
		filePath: 'convex/gate.js',
	},
	{
		bucket: 'importProviders',
		packageName: 'import-plugin',
		capability: 'imports:provide',
		contributes: `importProviders: [{ id: 'vendor', label: 'Vendor', module: { exportPath: './convex/import' }, signature: { header: 'x-sig', algorithm: 'hmac-sha256', encoding: 'hex', secretEnvVar: 'PLUGIN_VENDOR_SECRET' } }]`,
		exportPath: './convex/import',
		filePath: 'convex/import.js',
	},
	{
		bucket: 'crons',
		packageName: 'cron-plugin',
		capability: 'scheduler:cron',
		contributes: `crons: [{ id: 'refresh', label: 'Refresh', module: { exportPath: './convex/cron' }, schedule: { intervalMinutes: 360 }, timeoutMs: 60000 }]`,
		exportPath: './convex/cron',
		filePath: 'convex/cron.js',
	},
	{
		bucket: 'automationTriggers',
		packageName: 'trigger-plugin',
		capability: 'automation:trigger',
		contributes: `automationTriggers: [{ id: 'raised', label: 'Raised', description: 'An escalation was raised', icon: 'siren', module: { exportPath: './convex/trigger' } }]`,
		exportPath: './convex/trigger',
		filePath: 'convex/trigger.js',
	},
	{
		bucket: 'automationSteps',
		packageName: 'automation-step-plugin',
		capability: 'automation:step',
		contributes: `automationSteps: [{ id: 'notify', label: 'Notify', description: 'Notify a channel', icon: 'bell', module: { exportPath: './convex/automationStep' } }]`,
		exportPath: './convex/automationStep',
		filePath: 'convex/automationStep.js',
	},
	{
		bucket: 'automationConditions',
		packageName: 'condition-plugin',
		capability: 'automation:condition',
		contributes: `automationConditions: [{ id: 'priority', label: 'Priority', description: 'Contact is priority', icon: 'star', module: { exportPath: './convex/condition' } }]`,
		exportPath: './convex/condition',
		filePath: 'convex/condition.js',
	},
];

function manifestSource(fixture: ExecutableBucketFixture): string {
	return `export default { id: '${fixture.packageName}', version: '1.0.0', capabilities: ['${fixture.capability}'], flag: { default: false }, contributes: { ${fixture.contributes} } };`;
}

async function workspaceFor(fixture: ExecutableBucketFixture, target: string): Promise<string> {
	return createPackageLoaderWorkspace(
		{ [fixture.packageName]: '1.0.0' },
		{
			[fixture.packageName]: {
				source: manifestSource(fixture),
				packageJson: { exports: { '.': './index.js', [fixture.exportPath]: target } },
				files: {
					[fixture.filePath]: `throw new Error('codegen must not execute contribution modules'); export default {};`,
				},
			},
		}
	);
}

describe('every executable contribution bucket is provenance-verified', () => {
	it.each(FIXTURES)('accepts a well-formed $bucket module', async (fixture) => {
		const root = await workspaceFor(fixture, `./${fixture.filePath}`);
		const loaded = await loadBundledPlugins(root, [fixture.packageName]);
		expect(loaded).toHaveLength(1);
		// The loader saw this bucket as executable — otherwise the two rejection
		// cases below would pass vacuously.
		expect(pluginContributionModules(loaded[0]!.manifest)).toEqual([
			{ bucket: fixture.bucket, id: expect.any(String), exportPath: fixture.exportPath },
		]);
	});

	it.each(FIXTURES)('rejects a $bucket module that escapes the package root', async (fixture) => {
		// The classic provenance attack: a valid-looking manifest whose declared
		// export the package.json maps outside its own directory.
		const root = await workspaceFor(fixture, '../../escape.js');
		await expect(loadBundledPlugins(root, [fixture.packageName])).rejects.toMatchObject({
			code: 'contribution_export_invalid',
		});
	});

	it.each(FIXTURES)('rejects a $bucket module the package does not export', async (fixture) => {
		const root = await workspaceFor(fixture, `./${fixture.filePath}`);
		await writeFile(
			join(root, `node_modules/${fixture.packageName}/package.json`),
			JSON.stringify({
				name: fixture.packageName,
				version: '1.0.0',
				type: 'module',
				exports: { '.': './index.js' },
			})
		);
		await expect(loadBundledPlugins(root, [fixture.packageName])).rejects.toMatchObject({
			code: 'contribution_export_invalid',
		});
	});

	it('covers every executable bucket, and classifies every other live bucket', () => {
		// The loader finds executable halves STRUCTURALLY — anything carrying
		// `module.exportPath` — so nothing stops a later piece from adding an
		// executable bucket. This forces such a bucket to be either fixtured above
		// or explicitly declared data-only.
		const DATA_ONLY = ['webhookEvents', 'navItems', 'settingsPanels'];
		const covered = FIXTURES.map((fixture) => fixture.bucket);
		expect(new Set(covered).size).toBe(covered.length);
		expect([...covered, ...DATA_ONLY].sort()).toEqual([...PLUGIN_LIVE_CONTRIBUTION_KINDS].sort());
	});
});
