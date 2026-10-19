/**
 * The contract between the runner (Node, perf/run.ts) and the fixture page
 * (perf/fixture/main.ts): `window.__owlatPerf`.
 *
 * A run is mount → run → unmount on a fresh page. The runner reads Chrome's
 * own counters (layouts, style recalcs, live nodes and listeners) between the
 * calls; each call returns what only the page can see.
 */
import type { Sample } from './stats';

/**
 * Evidence that the scenario measured the real components and nothing else.
 * Any entry here voids the run: a component that rendered as an unknown
 * element, a message key the catalog lacks, or an error thrown by a component
 * means the numbers describe a broken fixture.
 */
export interface FidelitySentinels {
	vueErrors: string[];
	unresolvedComponents: string[];
	missingI18nKeys: string[];
}

export interface FixtureApi {
	scenarioIds: string[];
	mount(id: string): Promise<Sample>;
	run(): Promise<Sample>;
	unmount(): Promise<{ sample: Sample; sentinels: FidelitySentinels }>;
}

declare global {
	interface Window {
		__owlatPerf?: FixtureApi;
	}
}
