import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Team Inbox empty-state guards (UX plan T12b).
 *
 * Every one of these pages hand-rolled the same block: a 56px filled
 * `UiIconBox` disc over a bolded `<p>`, sitting in its own `v-if` chain beside
 * a hand-written spinner and a bare `UiErrorAlert`. Two defects came with that
 * shape and both are asserted against here:
 *
 *  - the "title" was body copy, so a heading walk of a page whose entire
 *    content is its empty state found nothing;
 *  - the chain put `isLoading` first and `error` second, so a faulted query
 *    could paint as a reassuring "all clear" list. `UiQueryBoundary` orders
 *    error first, by design.
 *
 * These pages are Convex-query driven and awkward to mount in happy-dom, so —
 * as the dashboard-wide `emptyStates.test.ts` guards already do — the
 * load-bearing template facts are asserted against the source. The rendered
 * ladder itself is covered by real mounts in
 * `packages/ui/__tests__/EmptyState.test.ts`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8');

interface Guard {
	name: string;
	page: string;
	/** The predicate the boundary's `empty` prop must be bound to. */
	emptyBinding: string;
	/** The title the shared component must carry in the `#empty` slot. */
	emptyTitle: string;
	/** A marker proving the has-data branch still renders. */
	dataBranchMarker: string;
}

const guards: Guard[] = [
	{
		name: 'failed',
		page: '../failed.vue',
		emptyBinding: '!failedMessages || failedMessages.length === 0',
		emptyTitle: "t('dashboard.inbox.failed.emptyTitle')",
		dataBranchMarker: 'v-for="message in failedMessages"',
	},
	{
		name: 'quarantine',
		page: '../quarantine.vue',
		emptyBinding: '!quarantinedMessages || quarantinedMessages.length === 0',
		emptyTitle: "t('dashboard.inbox.quarantine.emptyTitle')",
		dataBranchMarker: 'v-for="message in quarantinedMessages"',
	},
	{
		name: 'code-tasks',
		page: '../code-tasks.vue',
		emptyBinding: '!tasks || tasks.length === 0',
		emptyTitle: "t('dashboard.inbox.codeTasks.emptyTitle')",
		dataBranchMarker: 'v-for="task in tasks"',
	},
	{
		name: 'index',
		page: '../index.vue',
		emptyBinding: 'visibleThreads.length === 0',
		emptyTitle: 'emptyMessage',
		dataBranchMarker: 'v-for="(thread, index) in visibleThreads"',
	},
	{
		name: 'activity',
		page: '../activity.vue',
		emptyBinding: 'timeline.length === 0',
		// The activity feed's guided copy lives in its own component, which is
		// itself a thin wrapper over the shared ladder.
		emptyTitle: ':can-manage="canManageChannels"',
		dataBranchMarker: 'v-for="item in timeline"',
	},
];

describe.each(guards)(
	'$name — empty state on the shared ladder, behind the query boundary',
	({ page, emptyBinding, emptyTitle, dataBranchMarker }) => {
		const source = read(page);

		it("binds the boundary's `empty` predicate instead of a hand-rolled v-if", () => {
			expect(source).toContain(`:empty="${emptyBinding}"`);
			expect(source).not.toContain(`v-if="${emptyBinding}"`);
			expect(source).not.toContain(`v-else-if="${emptyBinding}"`);
		});

		it('renders the empty branch through the boundary’s #empty slot', () => {
			expect(source).toMatch(/<template #empty>[\s\S]*?<\/template>/);
			const slot = source.match(/<template #empty>([\s\S]*?)<\/template>/)![1]!;
			expect(slot).toContain(emptyTitle);
		});

		it('keeps no forked empty markup: no icon disc, no bolded pseudo-title', () => {
			const slot = source.match(/<template #empty>([\s\S]*?)<\/template>/)![1]!;
			// The disc was a `UiIconBox size="xl"` (56px) with a surface fill.
			expect(slot).not.toContain('UiIconBox');
			expect(source).not.toContain('text-text-secondary font-medium">');
		});

		it('still renders the list when there IS data', () => {
			expect(source).toContain(dataBranchMarker);
		});

		it('lets the boundary decide the state order, so a fault cannot read as all-clear', () => {
			// The hand-rolled chains opened on `v-if="isLoading"` with the error
			// alert as an `v-else-if` behind it.
			expect(source).not.toContain('v-if="isLoading"');
			expect(source).not.toContain('<UiErrorAlert\n\t\t\tv-else-if="error"');
		});
	}
);

describe('inbox list — a filtered view is a no-results state, not an empty queue', () => {
	const source = read('../index.vue');

	it('reads quieter and offers the way back to the default pill', () => {
		expect(source).toContain(`:variant="isFiltered ? 'no-results' : 'empty'"`);
		expect(source).toContain('@clear="filter = DEFAULT_INBOX_FILTER"');
	});

	it('derives "filtered" from the registry default rather than a hardcoded pill', () => {
		expect(source).toContain(
			'const isFiltered = computed(() => filter.value !== DEFAULT_INBOX_FILTER)'
		);
	});
});
