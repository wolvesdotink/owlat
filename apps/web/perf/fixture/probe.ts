/**
 * In-page instruments: Vue component updates by name, DOM mutations, long
 * tasks and animation frames. All of them read, none of them changes what the
 * components render.
 *
 * Update counts come from a global mixin's `updated` hook, which fires once
 * per component re-render patch. That is the deterministic signal a scenario
 * is for: "how many rows re-rendered for this flush" does not depend on how
 * fast the machine is.
 */
import type { App, ComponentPublicInstance } from 'vue';

interface MutationTally {
	nodesAdded: number;
	nodesRemoved: number;
	textChanges: number;
	attributeChanges: number;
}

const componentName = (instance: ComponentPublicInstance) => {
	const options = instance.$options as { __name?: string; name?: string };
	return options.__name ?? options.name ?? 'Anonymous';
};

export function createProbe(app: App, stage: HTMLElement) {
	const updates = new Map<string, number>();
	let mounted = 0;
	let unmounted = 0;
	app.mixin({
		mounted() {
			mounted += 1;
		},
		updated(this: ComponentPublicInstance) {
			const name = componentName(this);
			updates.set(name, (updates.get(name) ?? 0) + 1);
		},
		unmounted() {
			unmounted += 1;
		},
	});

	const emptyTally = (): MutationTally => ({
		nodesAdded: 0,
		nodesRemoved: 0,
		textChanges: 0,
		attributeChanges: 0,
	});
	let tally = emptyTally();
	const count = (records: MutationRecord[]) => {
		for (const record of records) {
			tally.nodesAdded += record.addedNodes.length;
			tally.nodesRemoved += record.removedNodes.length;
			if (record.type === 'characterData') tally.textChanges += 1;
			if (record.type === 'attributes') tally.attributeChanges += 1;
		}
	};
	// Records reach the callback at the next microtask, usually before anyone
	// asks, so the callback counts them and `takeMutations` adds the rest.
	const observer = new MutationObserver(count);
	observer.observe(stage, {
		childList: true,
		subtree: true,
		characterData: true,
		attributes: true,
	});

	const longTasks: number[] = [];
	const longTaskObserver = new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) longTasks.push(entry.duration);
	});
	longTaskObserver.observe({ type: 'longtask', buffered: false });

	return {
		/** Updates by component name since the last call, and resets the tally. */
		takeUpdates(): Map<string, number> {
			const taken = new Map(updates);
			updates.clear();
			return taken;
		},
		/** DOM mutations under the stage since the last call. */
		takeMutations(): MutationTally {
			count(observer.takeRecords());
			const taken = tally;
			tally = emptyTally();
			return taken;
		},
		/** Long tasks (the browser's own 50 ms definition) since the last call. */
		takeLongTasks(): number[] {
			return longTasks.splice(0);
		},
		/** Components mounted and not yet unmounted. */
		live: () => mounted - unmounted,
		dispose() {
			observer.disconnect();
			longTaskObserver.disconnect();
		},
	};
}

export type Probe = ReturnType<typeof createProbe>;

export const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

export const sleepUntil = (at: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, at - performance.now())));

export const sum = (values: Iterable<number>) => {
	let total = 0;
	for (const v of values) total += v;
	return total;
};
