/**
 * Dispatch reachability — the gate that keeps "this bucket is a live extension
 * point" from being an unchecked claim.
 *
 * Every contribution bucket in the kernel's requirement table carries a
 * `dispatch` class: `'wired'` means a production host path runs the
 * contribution, `'declared'` means the contract, capability, codegen output and
 * authorization seam all exist but nothing calls them. Both classes are
 * legitimate; silently mixing them is not, because the docs, the ADRs and the
 * reference READMEs all describe buckets as working effects.
 *
 * This suite binds the class to the repository. For each MODULE EXPORT a bucket
 * carries it names the ONE symbol a host path has to reach for that export to
 * run, and then asserts:
 *
 *   - `'wired'`    — at least one non-test, non-generated production module
 *                    outside the symbol's own definition references it;
 *   - `'declared'` — no such module does.
 *
 * So wiring a declared bucket fails here until its row moves to `'wired'`, and
 * deleting the last consumer of a wired bucket fails here too. Every bucket must
 * have a row: a new bucket with no entry fails the coverage case below.
 *
 * MOST buckets carry exactly one executable module, so the seam key is the
 * bucket name. A bucket that carries MORE — today only `sendTransports`, whose
 * contributions may declare a feedback `webhook` (D6/P2.2) and a sending-domain
 * `domainIdentity` (D5/P3.2) — declares each in the kernel's `moduleExports` and
 * gets its own seam entry keyed `<bucket>.<role>`. Their reachability is a
 * genuinely separate question per half: the send half can be wired while the
 * feedback half is a contract nothing dispatches, and a per-bucket answer would
 * hide exactly that.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	PLUGIN_CONTRIBUTION_MODULE_EXPORTS,
	PLUGIN_LIVE_CONTRIBUTION_KINDS,
	pluginContributionModules,
	type PluginManifest,
} from '@owlat/plugin-kit';
import { REPOSITORY_ROOT } from '../repository';

interface DispatchSeam {
	/** The symbol a host path must reference for contributions to run. */
	readonly symbol: string;
	/** Where the symbol is defined; a self-reference is not a consumer. */
	readonly definedIn: string;
	/** Why this symbol is the reachability question for the bucket. */
	readonly because: string;
}

const SEAMS: Readonly<Record<string, DispatchSeam>> = Object.freeze({
	sendTransports: {
		symbol: 'BUNDLED_PLUGIN_SEND_TRANSPORT_MODULES',
		definedIn: 'apps/api/convex/plugins/sendTransportModules.generated.ts',
		because: 'the send dispatch registry must adapt plugin transports to SendProviderModule',
	},
	'sendTransports.webhook': {
		symbol: 'BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_MODULES',
		definedIn: 'apps/api/convex/plugins/sendTransportWebhookModules.generated.ts',
		because:
			'the /webhooks/plugin/<pluginId> route must resolve the plugin’s parse half to dispatch its feedback',
	},
	'sendTransports.domainIdentity': {
		symbol: 'BUNDLED_PLUGIN_SEND_TRANSPORT_DOMAIN_IDENTITY_MODULES',
		definedIn: 'apps/api/convex/plugins/sendTransportDomainIdentityModules.generated.ts',
		because:
			'the relay-identity action must resolve the plugin’s provider calls to register and re-check a sending domain',
	},
	agentSteps: {
		symbol: 'BUNDLED_PLUGIN_AGENT_STEP_MODULES',
		definedIn: 'apps/api/convex/plugins/agentStepModules.generated.ts',
		because: 'the agent step registry must resolve a plugin step to run it',
	},
	draftStrategies: {
		symbol: 'BUNDLED_PLUGIN_DRAFT_STRATEGY_MODULES',
		definedIn: 'apps/api/convex/plugins/draftStrategyModules.generated.ts',
		because: 'the draft strategy host must resolve a plugin strategy to run it',
	},
	sendGates: {
		symbol: 'BUNDLED_PLUGIN_AUTONOMY_GATE_MODULES',
		definedIn: 'apps/api/convex/plugins/autonomyGateModules.generated.ts',
		because: 'the route step must resolve plugin gates to evaluate them',
	},
	automationSteps: {
		symbol: 'BUNDLED_PLUGIN_AUTOMATION_STEP_MODULES',
		definedIn: 'apps/api/convex/plugins/automationStepModules.generated.ts',
		because: 'the automation step walker must resolve a plugin step to run it',
	},
	crons: {
		symbol: 'BUNDLED_PLUGIN_CRON_MODULES',
		definedIn: 'apps/api/convex/plugins/cronModules.generated.ts',
		because: 'the cron runtime must resolve a plugin cron to execute it',
	},
	navItems: {
		symbol: 'bundledPluginComposition',
		definedIn: 'apps/web/app/plugins/plugin-composition.generated.ts',
		because: 'the sidebar builder must read composed navigation contributions',
	},
	settingsPanels: {
		symbol: 'bundledPluginComposition',
		definedIn: 'apps/web/app/plugins/plugin-composition.generated.ts',
		because: 'the settings surface must read composed panel contributions',
	},
	automationTriggers: {
		symbol: 'BUNDLED_PLUGIN_AUTOMATION_TRIGGER_MODULES',
		definedIn: 'apps/api/convex/plugins/automationTriggerModules.generated.ts',
		because: 'a plugin trigger host must resolve the generated module registry',
	},
	automationConditions: {
		symbol: 'BUNDLED_PLUGIN_AUTOMATION_CONDITION_MODULES',
		definedIn: 'apps/api/convex/plugins/automationConditionModules.generated.ts',
		because: 'a condition evaluator must resolve the plugin module to branch on it',
	},
	webhookEvents: {
		symbol: 'WEBHOOK_EVENT_CATALOG_ALL',
		definedIn: 'apps/api/convex/webhooks/events/catalog.ts',
		because: 'the publish/subscribe path must read the composed event catalog',
	},
	importProviders: {
		symbol: 'BUNDLED_PLUGIN_IMPORT_PROVIDER_MODULES',
		definedIn: 'apps/api/convex/plugins/importProviderModules.generated.ts',
		because: 'the import walker must resolve a plugin provider to page through it',
	},
});

/** Roots that can contain a production host path for a contribution bucket. */
const HOST_ROOTS = ['apps/api/convex', 'apps/web/app'];

function isProductionSource(path: string): boolean {
	if (path.includes('/__tests__/')) return false;
	if (path.includes('/_generated/')) return false;
	if (path.endsWith('.generated.ts')) return false;
	if (path.endsWith('.test.ts')) return false;
	return path.endsWith('.ts') || path.endsWith('.vue');
}

async function productionSources(): Promise<readonly string[]> {
	const files: string[] = [];
	async function walk(relative: string): Promise<void> {
		for (const entry of await readdir(join(REPOSITORY_ROOT, relative), { withFileTypes: true })) {
			const child = `${relative}/${entry.name}`;
			if (entry.isDirectory()) {
				if (entry.name !== 'node_modules') await walk(child);
			} else if (isProductionSource(child)) {
				files.push(child);
			}
		}
	}
	for (const root of HOST_ROOTS) await walk(root);
	return files;
}

const sources = await productionSources();
const contents = new Map<string, string>(
	await Promise.all(
		sources.map(
			async (file) =>
				[file, await readFile(join(REPOSITORY_ROOT, file), 'utf8')] as [string, string]
		)
	)
);

function consumersOf(seam: DispatchSeam): readonly string[] {
	return sources.filter(
		(file) => file !== seam.definedIn && contents.get(file)!.includes(seam.symbol)
	);
}

/** The seam key for one module export: the bucket, or `<bucket>.<role>`. */
function seamKey(moduleExport: (typeof PLUGIN_CONTRIBUTION_MODULE_EXPORTS)[number]): string {
	return moduleExport.role === 'module'
		? moduleExport.bucket
		: `${moduleExport.bucket}.${moduleExport.role}`;
}

const DISPATCHED = PLUGIN_CONTRIBUTION_MODULE_EXPORTS.filter(
	(moduleExport) => moduleExport.dispatch === 'wired'
);
const UNDISPATCHED = PLUGIN_CONTRIBUTION_MODULE_EXPORTS.filter(
	(moduleExport) => moduleExport.dispatch === 'declared'
);

/**
 * A manifest that carries every executable half the platform knows about: one
 * contribution per capability-enforced bucket, each with its own `module`, plus
 * every NESTED module descriptor a contribution may declare — today only the
 * send transport's feedback `webhook`.
 *
 * Hand-maintained on purpose, and the one hand-maintained thing the case below
 * needs: `pluginContributionModules` walks nested fields structurally, so it
 * would happily discover a second half nobody declared in the kernel's table.
 * Adding one to the manifest types therefore means adding it here, where the
 * assertion turns it into a required table row.
 */
const MAXIMAL_NESTED_MODULES: Readonly<Record<string, readonly string[]>> = Object.freeze({
	sendTransports: ['domainIdentity', 'webhook'],
});

function maximalManifest(): PluginManifest {
	const contributes: Record<string, unknown[]> = {};
	for (const bucket of PLUGIN_LIVE_CONTRIBUTION_KINDS) {
		const nested = MAXIMAL_NESTED_MODULES[bucket] ?? [];
		contributes[bucket] = [
			{
				id: 'fixture',
				module: { exportPath: `./${bucket}` },
				...Object.fromEntries(
					nested.map((field) => [field, { module: { exportPath: `./${bucket}-${field}` } }])
				),
			},
		];
	}
	// Cast rather than validated: this fixture is deliberately WIDER than any
	// manifest a real plugin could ship (every bucket at once, capabilities it
	// does not hold), and `pluginContributionModules` is a structural walk that
	// runs before validation anyway — which is exactly why its output needs a
	// declaration to be checked against.
	return {
		id: 'fixture',
		version: '1.0.0',
		capabilities: [],
		contributes,
	} as unknown as PluginManifest;
}

describe('contribution dispatch reachability', () => {
	it('declares every module export the composition walker can find', () => {
		// The other direction of the same honesty: the table above says which
		// executable halves exist, and this asserts that a manifest carrying all of
		// them yields exactly those (bucket, role) pairs — so a second half wired
		// into codegen and a host path, but never given a row, has nowhere to hide.
		const found = pluginContributionModules(maximalManifest()).map(
			(reference) => `${reference.bucket}.${reference.role ?? 'module'}`
		);
		const declared = PLUGIN_CONTRIBUTION_MODULE_EXPORTS.map(
			(moduleExport) => `${moduleExport.bucket}.${moduleExport.role}`
		);
		expect([...found].sort()).toEqual([...declared].sort());
	});

	it('names a dispatch seam for every capability-enforced module export', () => {
		expect(PLUGIN_CONTRIBUTION_MODULE_EXPORTS.map(seamKey).sort()).toEqual(
			Object.keys(SEAMS).sort()
		);
		expect(DISPATCHED.length).toBeGreaterThan(0);
		expect(UNDISPATCHED.length).toBeGreaterThan(0);
		// A second module export on a bucket is the case this file grew for: assert
		// one exists, so a refactor that collapsed the table back to one-per-bucket
		// fails here rather than quietly stopping asking the question.
		expect(
			PLUGIN_CONTRIBUTION_MODULE_EXPORTS.filter((entry) => entry.role !== 'module').length
		).toBeGreaterThan(0);
	});

	it('finds a real host tree to search, and every seam still exists', async () => {
		expect(sources.length).toBeGreaterThan(100);
		for (const seam of Object.values(SEAMS)) {
			const source = await readFile(join(REPOSITORY_ROOT, seam.definedIn), 'utf8');
			expect(source, `${seam.definedIn} no longer defines ${seam.symbol}`).toContain(seam.symbol);
		}
	});

	for (const moduleExport of DISPATCHED) {
		const key = seamKey(moduleExport);
		it(`${key} is reachable from a production host path`, () => {
			const seam = SEAMS[key]!;
			const consumers = consumersOf(seam);
			expect(
				consumers.length,
				`${key} is declared 'wired' but nothing references ${seam.symbol} — ${seam.because}`
			).toBeGreaterThan(0);
		});
	}

	for (const moduleExport of UNDISPATCHED) {
		const key = seamKey(moduleExport);
		it(`${key} is honestly declared as not dispatched`, () => {
			const seam = SEAMS[key]!;
			const consumers = consumersOf(seam);
			expect(
				consumers,
				`${key} now has a consumer (${consumers.join(', ')}): move its row in CONTRIBUTION_CAPABILITY_REQUIREMENTS to dispatch: 'wired' and update the contribution reference`
			).toEqual([]);
		});
	}
});
