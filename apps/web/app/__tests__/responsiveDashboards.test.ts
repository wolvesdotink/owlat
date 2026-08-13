/**
 * Responsive contract for the core dashboards. These are template-only changes
 * with no unit-testable logic, so — like keyboardOperableRows.test.ts — the gate
 * reads the REAL shipped templates and pins the load-bearing classes:
 *
 *  - Postbox's three panes collapse to a stacked drill-in below `lg`: the folder
 *    rail goes off-canvas, and the list and reader swap instead of sharing the
 *    width. A regression to a fixed `w-96` list plus an always-on reader makes
 *    the phone layout a horizontal-scroll trap again.
 *  - The contacts and campaign-template tables render as card lists below `md`,
 *    because a five-column table on a 375px screen is unreadable.
 *  - The email-builder routes gate on viewport width rather than mounting a
 *    canvas that has nowhere to lay itself out.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const postboxLayout = read('../components/postbox/PostboxLayout.vue');
const folderDrawer = read('../components/postbox/PostboxFolderDrawer.vue');
const postboxSearch = read('../pages/dashboard/postbox/search.vue');
const contacts = read('../pages/dashboard/audience/contacts/index.vue');
const marketing = read('../pages/dashboard/send/marketing/index.vue');
const builderRoutes = {
	emails: read('../pages/dashboard/send/emails/[id]/edit.vue'),
	blocks: read('../pages/dashboard/send/blocks/[id]/edit.vue'),
	transactional: read('../pages/dashboard/send/transactional/[id]/edit.vue'),
};

describe('Postbox — stacked drill-in below lg', () => {
	it('gives the list the full width and hides it once a message is open', () => {
		expect(postboxLayout).toContain('class="w-full lg:w-96');
		expect(postboxLayout).toContain(":class=\"activeMessageId ? 'hidden lg:flex' : 'flex'\"");
	});

	it('shows the reader only when a message is open, with a back affordance', () => {
		expect(postboxLayout).toContain(":class=\"activeMessageId ? 'block' : 'hidden lg:block'\"");
		expect(postboxLayout).toContain('@click="backToList"');
	});

	it('dismisses the reader without pushing a history entry', () => {
		// Opening the message already pushed the entry this button dismisses: a
		// push here makes the system Back gesture reopen the closed reader.
		expect(postboxLayout).toMatch(/function backToList\(\)[\s\S]*?replace: true/);
	});

	it('puts the folder rail behind a drawer handle', () => {
		expect(postboxLayout).toContain('aria-label="Open folders"');
		expect(postboxLayout).toContain('v-model:open="railOpen"');
	});

	it('slides the rail off-canvas below lg and pins it back as a column at lg', () => {
		expect(folderDrawer).toContain('-translate-x-full');
		expect(folderDrawer).toContain('lg:static');
		expect(folderDrawer).toContain('lg:translate-x-0');
		// Tapping the scrim closes the drawer.
		expect(folderDrawer).toContain('@click="emit(\'update:open\', false)"');
	});

	it('takes the off-canvas rail out of the tab order instead of hiding it visually', () => {
		// Translated off-screen is not hidden: without :inert a phone user tabs
		// through every folder link in a pane they cannot see.
		expect(folderDrawer).toContain("useMediaQuery('(min-width: 1024px)')");
		expect(folderDrawer).toContain(':inert="isOffCanvas ? true : undefined"');
	});

	it('applies the same drill-in to the search results/reader split', () => {
		expect(postboxSearch).toContain(":class=\"activeMessageId ? 'hidden lg:flex' : 'flex'\"");
		expect(postboxSearch).toContain(":class=\"activeMessageId ? 'block' : 'hidden lg:block'\"");
		expect(postboxSearch).toContain('@click="activeMessageId = null"');
	});
});

describe('Data tables — card list below md', () => {
	it.each([
		['contacts', contacts],
		['campaign templates', marketing],
	])('%s render a card list and hide the table below md', (_label, source) => {
		expect(source).toContain('<ul class="md:hidden divide-y divide-border-subtle">');
		expect(source).toContain('<div class="hidden md:block overflow-x-auto">');
	});
});

describe('Email builder — viewport gate', () => {
	it.each(Object.entries(builderRoutes))('%s edit route gates the canvas', (_label, source) => {
		expect(source).toContain('const builderFits = useEmailBuilderViewport();');
		expect(source).toContain('<EmailBuilderViewportGate v-else-if="!builderFits">');
		// The gate must precede the builder, or `v-else` would never reach it.
		expect(source.indexOf('<EmailBuilderViewportGate')).toBeLessThan(
			source.indexOf('<EmailBuilder\n')
		);
	});
});
