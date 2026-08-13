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
const replyQueueStrip = read('../components/postbox/PostboxReplyQueueStrip.vue');
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

describe('Mobile-only controls clear the 44px touch target', () => {
	// These four only exist below `lg`/`md`, i.e. they are only ever operated by a
	// thumb — an icon in `p-1` is a 24px target and misses about as often as it
	// hits. 44px is the iOS HIG / WCAG 2.5.5 minimum.
	it('sizes the folder-drawer handle to 44px square', () => {
		expect(postboxLayout).toMatch(/w-11 h-11[\s\S]{0,300}?aria-label="Open folders"/);
	});

	it('sizes the reader back bar to 44px tall', () => {
		expect(postboxLayout).toMatch(/px-3 py-3[\s\S]{0,300}?@click="backToList"/);
	});

	it('sizes the search results back button to 44px tall', () => {
		expect(postboxSearch).toMatch(/px-2 py-3[\s\S]{0,300}?@click="activeMessageId = null"/);
	});

	it('grows the contacts card checkbox hit area without growing the box', () => {
		// The box stays 20px (the row has no room for more); the transparent
		// pseudo-element carries the target — same trick as preferences.vue.
		expect(contacts).toMatch(/class="contact-select /);
		expect(contacts).toContain('.contact-select::after');
		expect(contacts).toMatch(/inset:\s*-12px/);
	});

	it('sizes the reply-queue strip dismiss button to 44px square', () => {
		expect(replyQueueStrip).toMatch(
			/w-11 h-11[\s\S]{0,300}?aria-label="Dismiss reply queue reminder"/
		);
	});
});

describe('Data tables — card list below md', () => {
	it.each([
		['contacts', contacts],
		['campaign templates', marketing],
	])('%s render the card list below md and the table above it', (_label, source) => {
		expect(source).toContain('const tableFits = useDataTableViewport();');
		expect(source).toMatch(/v-if="!tableFits"/);
		expect(source).toContain('<div v-else class="overflow-x-auto">');
	});

	it.each([
		['contacts', contacts],
		['campaign templates', marketing],
	])('%s mount one of the two trees, not both', (_label, source) => {
		// A CSS-only switch keeps both copies of every row in the DOM: twice the
		// layout work on the weakest device, and two copies to keep in step.
		expect(source).not.toMatch(/class="[^"]*\bmd:hidden\b/);
		expect(source).not.toMatch(/class="[^"]*\bhidden md:block\b/);
	});

	it('gives the contacts card list its own select-all', () => {
		// The table's select-all lives in a `thead` that the card list has no room
		// for, so bulk selection was desktop-only on the card list.
		expect(contacts).toMatch(/Deselect all' : 'Select all'/);
		expect(contacts).toMatch(/@click="toggleSelectAll"[\s\S]{0,900}?<ul class="divide-y/);
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
