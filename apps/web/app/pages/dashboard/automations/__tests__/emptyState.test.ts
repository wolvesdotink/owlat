import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Empty-state markup guards for the primary list surfaces converted to the shared
 * UiEmptyState (next-layer UX plan, piece B3).
 *
 * These pages are Convex-query driven and awkward to mount in happy-dom, so — as with
 * the knowledge-graph page guards — we assert the load-bearing template facts:
 *   - each empty branch renders the SHARED <UiEmptyState> (not a forked ad-hoc card),
 *   - the "nothing here yet" state carries the ONE primary action that fills the list,
 *   - the normal data branch (the table) still renders when there IS content.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8');

const automationsPage = read('../index.vue');
const suppressionsPage = read('../../audience/suppressions.vue');

describe('automations list — empty state', () => {
	it('renders the shared UiEmptyState for the no-automations state', () => {
		expect(automationsPage).toContain('<UiEmptyState');
		expect(automationsPage).toContain('title="No automations yet"');
	});

	it('offers the primary action that fills the list', () => {
		// The empty state teaches the next step: create the first automation.
		expect(automationsPage).toMatch(
			/#action[\s\S]*Create Automation[\s\S]*handleNewAutomation|handleNewAutomation[\s\S]*Create Automation/
		);
	});

	it('drops the forked ad-hoc empty card in favour of the shared component', () => {
		expect(automationsPage).not.toContain('font-medium">No automations yet');
	});

	it('still renders the table branch when there is data', () => {
		expect(automationsPage).toContain('v-for="automation in filteredAutomations"');
	});
});

describe('suppressions list — empty state', () => {
	it('renders the shared UiEmptyState for the no-suppressions state', () => {
		expect(suppressionsPage).toContain('<UiEmptyState');
		expect(suppressionsPage).toContain('title="No suppressions"');
	});

	it('offers the Add suppression primary action', () => {
		expect(suppressionsPage).toMatch(/#action[\s\S]*Add suppression/);
	});

	it('drops the forked ad-hoc empty card', () => {
		expect(suppressionsPage).not.toContain('font-medium">No suppressions');
	});

	it('still renders the table branch when there is data', () => {
		expect(suppressionsPage).toContain('v-else-if="filteredBlockedEmails.length > 0"');
	});
});
