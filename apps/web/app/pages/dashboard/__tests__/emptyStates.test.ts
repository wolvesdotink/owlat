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
 *     anchored to the component's #action slot so it can't pass on an unrelated button,
 *   - the normal data branch (the list/table) still renders when there IS content.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8');

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface EmptyStateGuard {
	name: string;
	page: string;
	emptyTitle: string;
	/** The primary CTA, anchored to the #action slot: its label plus the handler it fires. */
	primaryCta: { label: string; handler: string };
	/** A marker proving the normal (has-data) list branch still renders. */
	dataBranchMarker: string;
}

const guards: EmptyStateGuard[] = [
	{
		// Extracted page: the title and the CTA label are message keys in the
		// source, so the guard anchors on the key it binds rather than the copy
		// (which now lives in i18n/locales/en.json).
		name: 'campaigns',
		page: '../campaigns/index.vue',
		emptyTitle: "t('dashboard.campaigns.index.listEmpty.title')",
		primaryCta: {
			label: "t('dashboard.campaigns.index.newCampaign')",
			handler: 'handleNewCampaign',
		},
		dataBranchMarker: 'v-for="row in visibleRows"',
	},
	{
		// Extracted page — same as campaigns above: anchor on the message keys.
		name: 'automations',
		page: '../automations/index.vue',
		emptyTitle: "t('dashboard.automations.index.empty.title')",
		primaryCta: {
			label: "t('dashboard.automations.index.empty.action')",
			handler: 'handleNewAutomation',
		},
		dataBranchMarker: 'v-for="automation in filteredAutomations"',
	},
	{
		// Extracted page — same as campaigns above: anchor on the message keys.
		name: 'suppressions',
		page: '../audience/suppressions.vue',
		emptyTitle: "t('dashboard.audience.suppressions.empty.title')",
		primaryCta: {
			label: "t('dashboard.audience.suppressions.addSuppression')",
			handler: 'addModal.open()',
		},
		dataBranchMarker: 'v-else-if="filteredBlockedEmails.length > 0"',
	},
];

describe.each(guards)(
	'$name list — standardized empty state',
	({ page, emptyTitle, primaryCta, dataBranchMarker }) => {
		const source = read(page);

		it('renders the shared UiEmptyState for the empty state', () => {
			expect(source).toContain('<UiEmptyState');
			expect(source).toContain(`title="${emptyTitle}"`);
		});

		it('offers the primary action that fills the list, inside the #action slot', () => {
			// Grouped alternation: BOTH the label and its handler must appear, in either
			// order, AFTER the #action slot marker — so an action-less CTA cannot pass.
			const label = escapeRegExp(primaryCta.label);
			const handler = escapeRegExp(primaryCta.handler);
			const guard = new RegExp(
				`#action[\\s\\S]*?(?:${label}[\\s\\S]*?${handler}|${handler}[\\s\\S]*?${label})`
			);
			expect(source).toMatch(guard);
		});

		it('still renders the data branch when there is content', () => {
			expect(source).toContain(dataBranchMarker);
		});
	}
);
