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
 * This suite binds the class to the repository. For each bucket it names the ONE
 * symbol a host path has to reach for the bucket to run, and then asserts:
 *
 *   - `'wired'`    — at least one non-test, non-generated production module
 *                    outside the symbol's own definition references it;
 *   - `'declared'` — no such module does.
 *
 * So wiring a declared bucket fails here until its row moves to `'wired'`, and
 * deleting the last consumer of a wired bucket fails here too. Every bucket must
 * have a row: a new bucket with no entry fails the coverage case below.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	PLUGIN_DISPATCHED_CONTRIBUTION_KINDS,
	PLUGIN_LIVE_CONTRIBUTION_KINDS,
	PLUGIN_UNDISPATCHED_CONTRIBUTION_KINDS,
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
		// The module registry IS resolved (triggers/pluginTriggers.ts) and the fan-out
		// mutation IS written, so the reachability question is one level up: does
		// anything FIRE a plugin trigger? Nothing does.
		symbol: 'firePluginTrigger',
		definedIn: 'apps/api/convex/automations/triggers.ts',
		because: 'a plugin trigger only fans out when some host path fires it',
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

describe('contribution dispatch reachability', () => {
	it('names a dispatch seam for every capability-enforced bucket', () => {
		expect([...PLUGIN_LIVE_CONTRIBUTION_KINDS].sort()).toEqual(Object.keys(SEAMS).sort());
		expect(PLUGIN_DISPATCHED_CONTRIBUTION_KINDS.length).toBeGreaterThan(0);
		expect(PLUGIN_UNDISPATCHED_CONTRIBUTION_KINDS.length).toBeGreaterThan(0);
		expect(
			[...PLUGIN_DISPATCHED_CONTRIBUTION_KINDS, ...PLUGIN_UNDISPATCHED_CONTRIBUTION_KINDS].sort()
		).toEqual([...PLUGIN_LIVE_CONTRIBUTION_KINDS].sort());
	});

	it('finds a real host tree to search, and every seam still exists', async () => {
		expect(sources.length).toBeGreaterThan(100);
		for (const seam of Object.values(SEAMS)) {
			const source = await readFile(join(REPOSITORY_ROOT, seam.definedIn), 'utf8');
			expect(source, `${seam.definedIn} no longer defines ${seam.symbol}`).toContain(seam.symbol);
		}
	});

	for (const bucket of PLUGIN_DISPATCHED_CONTRIBUTION_KINDS) {
		it(`${bucket} is reachable from a production host path`, () => {
			const seam = SEAMS[bucket]!;
			const consumers = consumersOf(seam);
			expect(
				consumers.length,
				`${bucket} is declared 'wired' but nothing references ${seam.symbol} — ${seam.because}`
			).toBeGreaterThan(0);
		});
	}

	for (const bucket of PLUGIN_UNDISPATCHED_CONTRIBUTION_KINDS) {
		it(`${bucket} is honestly declared as not dispatched`, () => {
			const seam = SEAMS[bucket]!;
			const consumers = consumersOf(seam);
			expect(
				consumers,
				`${bucket} now has a consumer (${consumers.join(', ')}): move its row in CONTRIBUTION_CAPABILITY_REQUIREMENTS to dispatch: 'wired' and update the contribution reference`
			).toEqual([]);
		});
	}
});
