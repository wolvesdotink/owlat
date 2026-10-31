/**
 * Committed budgets for the scenarios' deterministic counters, and the pure
 * check the runner applies to every run.
 *
 * A budget is either a ceiling (`max`: work the components do, such as
 * component updates, DOM mutations, elements rendered, components or nodes
 * left after teardown; more is a regression) or an identity (`exact`: what
 * the workload has to deliver, such as rows, flushes, an update that landed,
 * every row scrolled past; a fixture that delivers less would pass every
 * ceiling while measuring nothing).
 *
 * Only counters that came out the same on every run and do not depend on the
 * machine are budgeted. Layout and style-recalc counts follow Chrome's frame
 * scheduling, Chrome's own node count at mount follows its internals (the
 * page-side `elements rendered` is budgeted instead), and scroll heights and
 * scroll-frame counts of variable-height rows follow the installed fonts;
 * those stay report-only, as every timing does. Each run is checked on its own, so one bad run fails the gate even
 * when the median looks fine.
 *
 * A deliberate change of a counter (a new element per row, a component that
 * now re-renders on purpose) updates its budget here in the same change, with
 * the reason in the commit. Budgets were taken from repeated runs of the
 * fixture on system Chrome; perf/README.md says how to re-measure.
 */
import type { Sample } from './stats';

type Budget = { max: number } | { exact: number };

/** Budgets by scenario id, then by metric name as the report prints it. */
export type ScenarioBudgets = Readonly<Record<string, Budget>>;

/** What every run must leave behind after teardown: nothing. */
const NOTHING_LEFT: ScenarioBudgets = {
	'teardown: components left mounted': { max: 0 },
	'teardown: DOM nodes left': { max: 0 },
	'teardown: JS event listeners left': { max: 0 },
	'teardown: documents left': { max: 0 },
	'teardown: frames left': { max: 0 },
};

/**
 * The Postbox lists' teardown today: the first list mounted on a page stays
 * alive after it unmounts. `usePostboxOfflineCache` registers its app-wide
 * `online`/`offline` listeners inside the composable, so they hold the first
 * caller's scope (its `mailboxId` computed, and through it the list). The
 * ceilings are that one list's nodes and listeners; they drop to 0 once the
 * listeners stop capturing the caller.
 */
const postboxTeardown = (domNodes: number, listeners: number): ScenarioBudgets => ({
	...NOTHING_LEFT,
	'teardown: DOM nodes left': { max: domNodes },
	'teardown: JS event listeners left': { max: listeners },
});

const assistantStream = (counts: {
	componentsMounted: number;
	elementsRendered: number;
	answerLength: number;
	componentUpdates: number;
	nodesAdded: number;
	nodesRemoved: number;
	textChanges: number;
}): ScenarioBudgets => ({
	'mount: rows': { exact: 42 },
	'mount: components mounted': { max: counts.componentsMounted },
	'mount: elements rendered': { max: counts.elementsRendered },
	'mount: component updates during mount': { max: 0 },
	'run: flushes': { exact: 48 },
	'run: answer length at end': { exact: counts.answerLength },
	// Only the streaming row re-renders on a flush, never the settled turns above it.
	'run: rows re-rendered per flush (max)': { max: 1 },
	'run: component updates': { max: counts.componentUpdates },
	'run: DOM nodes added': { max: counts.nodesAdded },
	'run: DOM nodes removed': { max: counts.nodesRemoved },
	'run: DOM text changes': { max: counts.textChanges },
	'run: DOM attribute changes': { max: 0 },
	...NOTHING_LEFT,
});

export const BUDGETS: Readonly<Record<string, ScenarioBudgets>> = {
	'assistant-stream/start': assistantStream({
		componentsMounted: 293,
		elementsRendered: 893,
		answerLength: 2400,
		componentUpdates: 188,
		nodesAdded: 291,
		nodesRemoved: 5,
		textChanges: 39,
	}),
	'assistant-stream/near-cap': assistantStream({
		componentsMounted: 494,
		elementsRendered: 1530,
		answerLength: 32768,
		componentUpdates: 187,
		nodesAdded: 210,
		nodesRemoved: 4,
		textChanges: 42,
	}),
	// The chat list is windowed over rows of variable height, so how many rows
	// it mounts and how often its window moves follow the installed fonts; what
	// it has to deliver does not.
	'chat-history/500': {
		'mount: rows': { exact: 500 },
		'mount: component updates during mount': { max: 0 },
		'run: messages': { exact: 500 },
		'run: opened at the bottom': { exact: 1 },
		'run: days shown on the way to the oldest': { exact: 15 },
		...NOTHING_LEFT,
	},
	'postbox-list/50': {
		'mount: rows': { exact: 50 },
		// Six per row for the row's tooltips (the checkbox and four quick
		// actions, each a renderless UiTooltip) and the quick-action cluster's
		// own component, plus the list's sweep status.
		'mount: components mounted': { max: 877 },
		'mount: elements rendered': { max: 1119 },
		'mount: component updates during mount': { max: 0 },
		// Under the windowing threshold every row mounts.
		'run: rows mounted at the top': { exact: 50 },
		'run: live update landed': { exact: 1 },
		'run: rows re-rendered by a one-row update': { max: 1 },
		// A read row re-renders its quick actions and the mark-read tooltip
		// (its text flips), and the checkbox's tooltip with the row link whose
		// slot holds it.
		'run: component updates for a one-row update': { max: 11 },
		'run: DOM mutations for a one-row update': { max: 4 },
		'run: rows shown while scrolling': { exact: 50 },
		'run: rows re-rendered while scrolling': { max: 0 },
		'run: component updates while scrolling': { max: 0 },
		'run: DOM mutations while scrolling': { max: 0 },
		// The retained list includes its sweep status's node.
		...postboxTeardown(2676, 858),
	},
	'postbox-list/500': {
		'mount: rows': { exact: 500 },
		// As postbox-list/50: six per mounted row and the sweep status.
		'mount: components mounted': { max: 393 },
		'mount: elements rendered': { max: 495 },
		'mount: component updates during mount': { max: 1 },
		// Over the threshold only a window mounts: the viewport's rows plus overscan.
		'run: rows mounted at the top': { max: 22 },
		'run: live update landed': { exact: 1 },
		'run: rows re-rendered by a one-row update': { max: 1 },
		'run: component updates for a one-row update': { max: 11 },
		'run: DOM mutations for a one-row update': { max: 4 },
		'run: scroll height': { exact: 38000 },
		'run: rows shown while scrolling': { exact: 500 },
		'run: rows re-rendered while scrolling': { max: 0 },
		// The retained list is the window mounted at teardown, one or two rows
		// more or less depending on where the last scroll step left it.
		...postboxTeardown(1244, 399),
	},
	'team-inbox/100': {
		'mount: rows': { exact: 100 },
		// Seven per row: the row's context menu (RowContextMenu, UiContextMenu
		// and its closed transition) and four quick-action tooltips.
		'mount: components mounted': { max: 2095 },
		// Two per row for multi-selection: the checkbox and its spacer in the link.
		'mount: elements rendered': { max: 3155 },
		'mount: component updates during mount': { max: 0 },
		'run: rows mounted': { exact: 100 },
		'run: live update landed': { exact: 1 },
		'run: rows re-rendered by a one-row update': { max: 1 },
		// The row's content renders in its context menu's slot, so the menu
		// re-renders with the row.
		'run: component updates for a one-row update': { max: 5 },
		'run: DOM mutations for a one-row update': { max: 3 },
		// Every row takes the list's clock as a prop, so a tick re-renders all of
		// them, chip or not; only the five chips whose text moves touch the DOM.
		'run: rows re-rendered by a clock tick': { max: 100 },
		'run: component updates for a clock tick': { max: 186 },
		'run: DOM mutations for a clock tick': { max: 5 },
		...NOTHING_LEFT,
	},
};

export interface BudgetFailure {
	scenario: string;
	metric?: string;
	/** 1-based run number, when one run broke the budget. */
	run?: number;
	message: string;
}

function describe(budget: Budget): string {
	return 'max' in budget ? `at most ${budget.max}` : `exactly ${budget.exact}`;
}

/** The budget as the report's counter table shows it. */
export function budgetLabel(budget: Budget | undefined): string {
	if (!budget) return '';
	return 'max' in budget ? `≤ ${budget.max}` : `= ${budget.exact}`;
}

/**
 * Check every run of every scenario that ran against its budgets. A scenario
 * with no budgets, a budgeted metric a run did not measure, a value that is
 * not a finite number, a budget on a timing, and a value past its budget all
 * fail. Metrics without a budget are not checked.
 */
export function checkBudgets(
	runs: Readonly<Record<string, readonly Sample[]>>,
	budgets: Readonly<Record<string, ScenarioBudgets>> = BUDGETS
): BudgetFailure[] {
	const failures: BudgetFailure[] = [];
	for (const [scenario, samples] of Object.entries(runs)) {
		const scenarioBudgets = budgets[scenario];
		if (!scenarioBudgets || Object.keys(scenarioBudgets).length === 0) {
			failures.push({ scenario, message: 'has no committed budgets (perf/budgets.ts)' });
			continue;
		}
		if (samples.length === 0) {
			failures.push({ scenario, message: 'produced no runs' });
			continue;
		}
		for (const [metric, budget] of Object.entries(scenarioBudgets)) {
			for (const [i, sample] of samples.entries()) {
				const run = i + 1;
				const measured = sample[metric];
				const fail = (message: string) => failures.push({ scenario, metric, run, message });
				if (!measured) {
					fail('was not measured');
				} else if (measured.kind !== 'counter') {
					fail('is a timing; only counters carry a budget');
				} else if (!Number.isFinite(measured.value)) {
					fail(`measured ${measured.value}, not a number`);
				} else if (
					'max' in budget ? measured.value > budget.max : measured.value !== budget.exact
				) {
					fail(`measured ${measured.value}, budget ${describe(budget)}`);
				}
			}
		}
	}
	return failures;
}

export function formatBudgetFailure(failure: BudgetFailure): string {
	const where = [failure.scenario, failure.metric].filter(Boolean).join(' / ');
	const run = failure.run === undefined ? '' : ` (run ${failure.run})`;
	return `${where}${run}: ${failure.message}`;
}
