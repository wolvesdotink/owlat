/**
 * Responsive contract for the core dashboards. These are template-only changes
 * with no unit-testable logic, so — like keyboardOperableRows.test.ts — the gate
 * reads the REAL shipped templates and pins the load-bearing classes:
 *
 *  - Postbox's three panes collapse to a stacked drill-in below `lg`: the folder
 *    rail goes off-canvas, and the list and reader swap instead of sharing the
 *    width. A regression to a fixed `w-96` list plus an always-on reader makes
 *    the phone layout a horizontal-scroll trap again.
 *  - The contacts, campaign-template, topic and segment tables render as card
 *    lists below `md`, because a five-column table on a 375px screen is
 *    unreadable.
 *  - The chat and assistant conversation rails become off-canvas drawers below
 *    `md` instead of being `hidden md:block`-ed out of existence, which used to
 *    take the room list — and the assistant's only "New chat" button — with them,
 *    and the phone's tab bar steps aside for them as it does for the shell's own
 *    drawer.
 *  - The dashboard shell renders against a viewport-gated collapse, so a rail
 *    collapsed on a laptop is not a 64px icon strip in the mobile drawer.
 *  - The admin tables an on-call operator reads sit in a scroll container.
 *  - The email-builder routes gate on viewport width rather than mounting a
 *    canvas that has nowhere to lay itself out.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const postboxLayout = read('../components/postbox/PostboxLayout.vue');
const readingPaneComposable = read('../composables/postbox/usePostboxReadingPane.ts');
const layoutNavComposable = read('../composables/postbox/usePostboxLayoutNav.ts');
const listHeader = read('../components/postbox/PostboxListHeader.vue');
const folderDrawer = read('../components/postbox/PostboxFolderDrawer.vue');
const replyQueueStrip = read('../components/postbox/PostboxReplyQueueStrip.vue');
const postboxSearch = read('../pages/dashboard/postbox/search.vue');
const contacts = read('../pages/dashboard/audience/contacts/index.vue');
const marketing = read('../pages/dashboard/send/marketing/index.vue');
const topics = read('../pages/dashboard/audience/topics/index.vue');
const topicDetail = read('../pages/dashboard/audience/topics/[id]/index.vue');
const segments = read('../pages/dashboard/audience/segments/index.vue');
const segmentDetail = read('../pages/dashboard/audience/segments/[id]/index.vue');
const railDrawer = read('../components/ui/RailDrawer.vue');
const mobileTabBar = read('../components/dashboard/MobileTabBar.vue');
const chatIndex = read('../pages/dashboard/chat/index.vue');
const chatRoom = read('../pages/dashboard/chat/[roomId].vue');
const assistant = read('../pages/dashboard/assistant/index.vue');
const sidebarState = read('../composables/useSidebarState.ts');
const dashboardLayout = read('../layouts/dashboard.vue');
const adminSystem = read('../pages/dashboard/admin/system/index.vue');
const adminOperator = read('../pages/dashboard/admin/operator/index.vue');
const builderRoutes = {
	emails: read('../pages/dashboard/send/emails/[id]/edit.vue'),
	blocks: read('../pages/dashboard/send/blocks/[id]/edit.vue'),
	transactional: read('../pages/dashboard/send/transactional/[id]/edit.vue'),
};

describe('Postbox — stacked drill-in below lg', () => {
	it('gives the list the full width and hides it once a message is open', () => {
		expect(postboxLayout).toContain('class="pbx-pane-list w-full');
		// The two visibility strings moved into usePostboxReadingPane when the
		// reading pane became a preference (the reader can now sit below the
		// list, or nowhere) — the drill-in itself is unchanged and pinned there.
		expect(postboxLayout).toContain(':class="[listPaneVisibility, listPaneBorder]"');
		expect(readingPaneComposable).toContain("return 'flex';");
		expect(readingPaneComposable).toContain("? 'hidden lg:flex' : 'hidden'");
	});

	it('shows the reader only when a message is open, with a back affordance', () => {
		expect(postboxLayout).toContain(':class="readerPaneVisibility"');
		expect(readingPaneComposable).toContain("? 'hidden lg:block' : 'hidden'");
		expect(postboxLayout).toContain('@click="backToList"');
	});

	it('dismisses the reader without pushing a history entry', () => {
		// Opening the message already pushed the entry this button dismisses: a
		// push here makes the system Back gesture reopen the closed reader. The
		// navigation moved into usePostboxLayoutNav when the layout crossed the
		// file-size cap; the contract is pinned where it now lives.
		expect(layoutNavComposable).toMatch(/function backToList\(\)[\s\S]*?replace: true/);
	});

	it('puts the folder rail behind a drawer handle', () => {
		// The handle lives in the extracted list header; the layout still owns
		// the drawer state it opens.
		expect(listHeader).toContain("t('components.postbox.postboxLayout.openFolders')");
		expect(postboxLayout).toContain('@open-rail="railOpen = true"');
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
		expect(listHeader).toMatch(/w-11 h-11[\s\S]{0,300}?postboxLayout\.openFolders/);
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
		// The accessible name is a catalog lookup since the extraction, so the
		// anchor is the keypath — the copy behind it lives in i18n/locales.
		expect(replyQueueStrip).toMatch(
			/w-11 h-11[\s\S]{0,300}?:aria-label="t\('components\.postbox\.postboxReplyQueueStrip\.dismissLabel'\)"/
		);
	});
});

describe('Data tables — card list below md', () => {
	// Contacts shipped the pattern; the four audience tables that a phone shows a
	// single column of were rolled onto it afterwards.
	const cardListPages = [
		['contacts', contacts],
		['campaign templates', marketing],
		['topics', topics],
		['topic detail', topicDetail],
		['segments', segments],
		['segment detail', segmentDetail],
	] as const;

	it.each(cardListPages)(
		'%s render the card list below md and the table above it',
		(_label, source) => {
			expect(source).toContain('const tableFits = useDataTableViewport();');
			expect(source).toMatch(/v-if="!tableFits"/);
			expect(source).toContain('<div v-else class="overflow-x-auto">');
		}
	);

	it.each(cardListPages)('%s mount one of the two trees, not both', (_label, source) => {
		// A CSS-only switch keeps both copies of every row in the DOM: twice the
		// layout work on the weakest device, and two copies to keep in step.
		expect(source).not.toMatch(/class="[^"]*\bmd:hidden\b/);
		expect(source).not.toMatch(/class="[^"]*\bhidden md:block\b/);
	});

	it.each([
		['topics', topics, 'topics.index.actions'],
		['segments', segments, 'segments.index.actions'],
	])('%s keep edit and delete on the card row', (_label, source, keyPrefix) => {
		// Neither detail page carries edit or delete, so dropping them from the
		// card list would make both verbs desktop-only.
		expect(source).toMatch(
			new RegExp(`aria-label="t\\('dashboard\\.audience\\.${keyPrefix}\\.edit'\\)`)
		);
		expect(source).toMatch(
			new RegExp(`aria-label="t\\('dashboard\\.audience\\.${keyPrefix}\\.delete'\\)`)
		);
	});

	it('keeps the remove action on the topic-detail card row', () => {
		expect(topicDetail).toMatch(
			/aria-label="t\('dashboard\.audience\.topics\.detail\.index\.removeFromTopic'\)/
		);
	});

	it('gives the contacts card list its own select-all', () => {
		// The table's select-all lives in a `thead` that the card list has no room
		// for, so bulk selection was desktop-only on the card list.
		// The page is extracted, so the toggle reads its two labels out of the
		// message catalog rather than carrying the copy inline.
		expect(contacts).toMatch(
			/t\('dashboard\.audience\.contacts\.index\.deselectAll'\)[\s\S]{0,80}?t\('dashboard\.audience\.contacts\.index\.selectAll'\)/
		);
		expect(contacts).toMatch(/@click="toggleSelectAll"[\s\S]{0,900}?<ul class="divide-y/);
	});
});

describe('Chat and assistant — rail as a drawer below md', () => {
	it('slides the rail off-canvas below md and pins it back as a column at md', () => {
		expect(railDrawer).toContain('-translate-x-full');
		expect(railDrawer).toContain('md:static');
		expect(railDrawer).toContain('md:translate-x-0');
		// Tapping the scrim closes the drawer.
		expect(railDrawer).toContain('@click="close"');
	});

	it('takes the off-canvas rail out of the tab order instead of hiding it visually', () => {
		// Translated off-screen is not hidden: without :inert a phone user tabs
		// through every conversation in a pane they cannot see.
		expect(railDrawer).toContain("useMediaQuery('(min-width: 768px)')");
		expect(railDrawer).toContain(':inert="isOffCanvas ? true : undefined"');
	});

	it.each([
		['chat', chatIndex, 'chat-rail'],
		['chat room', chatRoom, 'chat-rail'],
		['assistant', assistant, 'assistant-rail'],
	])('%s mounts its rail in the drawer rather than hiding it', (_label, source, railId) => {
		expect(source).toContain(`<UiRailDrawer id="${railId}" v-model:open="railOpen">`);
		// The old dead end: the rail was simply removed below md.
		expect(source).not.toMatch(/class="[^"]*\bhidden md:(block|flex)\b/);
	});

	it('sizes the pane against the mobile chrome, tab-bar reserve included', () => {
		// Below lg the chrome is 4rem of header bar + 2.25rem of breadcrumbs + its
		// hairline + the 4rem the tab bar reserves inside #main-content. Counting
		// only the bar left every one of these panes taller than the viewport, so
		// the composer at its bottom loaded under the fold.
		for (const source of [chatIndex, chatRoom, assistant]) {
			expect(source).toContain(
				'h-[calc(100dvh-10.25rem-1px-env(safe-area-inset-top)-env(safe-area-inset-bottom))]'
			);
			expect(source).toContain('lg:h-[calc(100vh-4rem-3rem)]');
		}
	});

	it('names the drawer handle rather than leaving a lone icon', () => {
		// A bare icon in an otherwise empty strip reads as stray chrome and says
		// nothing about what it opens.
		expect(chatIndex).toContain("t('dashboard.chat.index.openConversations')");
		expect(chatRoom).toContain("t('dashboard.chat.detail.backToConversations')");
		expect(assistant).toContain("t('dashboard.assistant.index.openConversations')");
	});

	it('hides the phone tab bar while the rail is the overlay on top', () => {
		// The bar is z-(--z-header), above the drawer's z-50 panel and z-40 scrim,
		// so it would paint over the conversation list — the same collision the
		// shell drawer has, answered the same way. The shell hands its drawer
		// state down as `navigationOpen`; this one lives in the page, so it
		// travels through shared state instead.
		expect(railDrawer).toContain('const { setOpen: setRailDrawerOpen } = useRailDrawer();');
		expect(railDrawer).toContain('watch(isOverlay, setRailDrawerOpen, { immediate: true });');
		expect(mobileTabBar).toContain('const { isOpen: isRailDrawerOpen } = useRailDrawer();');
		expect(mobileTabBar).toContain('!isRailDrawerOpen.value &&');
	});

	it.each([
		['chat', chatIndex],
		['chat room', chatRoom],
		['assistant', assistant],
	])('%s gives the drawer a visible handle below md', (_label, source) => {
		// Below md this is the ONLY route to the conversation list, and it is only
		// ever operated by a thumb — 44px is the iOS HIG / WCAG 2.5.5 minimum.
		expect(source).toMatch(/md:hidden[\s\S]{0,400}?h-11[\s\S]{0,400}?@click="railOpen = true"/);
		expect(source).toMatch(/aria-controls="(chat|assistant)-rail"/);
	});

	it('gives a deep-linked room a back affordance to the room list', () => {
		expect(chatRoom).toMatch(
			/lucide:arrow-left[\s\S]{0,200}?dashboard\.chat\.detail\.backToConversations/
		);
	});

	it('keeps the assistant new-chat verb reachable below md', () => {
		// The only "New chat" button used to live inside the hidden rail, so a
		// phone user could neither list conversations nor start one.
		expect(assistant).toMatch(
			/md:hidden[\s\S]{0,900}?aria-label="t\('dashboard\.assistant\.index\.newChat'\)"[\s\S]{0,200}?@click="startConversation"/
		);
	});

	it('closes the drawer once a conversation is chosen', () => {
		expect(chatIndex).toMatch(
			/handleSelectRoom = \(id: Id<'chatRooms'>\) => \{\s*railOpen\.value = false;/
		);
		expect(chatRoom).toMatch(/watch\(roomId, \(\) => \{\s*railOpen\.value = false;/);
		expect(assistant).toMatch(
			/openConversation = \([\s\S]{0,60}?\) => \{\s*railOpen\.value = false;/
		);
	});
});

describe('Dashboard shell — collapse is a desktop-only preference', () => {
	it('derives effectiveCollapsed with the same viewport gate as effectiveHidden', () => {
		expect(sidebarState).toContain(
			'const effectiveHidden = computed(() => isHidden.value && isDesktopViewport.value);'
		);
		expect(sidebarState).toContain(
			'const effectiveCollapsed = computed(() => isCollapsed.value && isDesktopViewport.value);'
		);
	});

	it('renders the shell against the gated value, not the raw persisted one', () => {
		// Ungated, a rail collapsed on a laptop became a 64px icon-only drawer on
		// the phone — no labels, and the Collapse toggle that would widen it again
		// is `hidden lg:flex`.
		expect(dashboardLayout).toContain('effectiveCollapsed: isCollapsed,');
		expect(dashboardLayout).not.toMatch(/^\tisCollapsed,$/m);
	});
});

describe('Admin tables — horizontal scroll container', () => {
	it.each([
		['system', adminSystem, 2],
		['operator', adminOperator, 2],
	])('%s wraps every table in a scroll container', (_label, source, tableCount) => {
		const tables = source.match(/<table\b/g) ?? [];
		expect(tables).toHaveLength(tableCount);
		// One wrapper per table: an on-call operator on a phone could not read
		// their own instance status because the card simply clipped the columns.
		expect(source.match(/class="-mx-6 px-6 overflow-x-auto"/g) ?? []).toHaveLength(tableCount);
		// `w-full` alone squeezes the columns instead of scrolling them.
		expect(source.match(/<table class="w-full min-w-max text-caption">/g) ?? []).toHaveLength(
			tableCount
		);
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
