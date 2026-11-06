/**
 * Conformance pins for the Postbox command-palette provider descriptor.
 *
 * The provider is registered from inside a composable at mount time, so its
 * static contract (id, external-tier priority, route gate) is exported and
 * pinned here without mounting the Postbox layout. If a refactor renames the id,
 * changes the priority, or loosens the route gate to a bare prefix match, one of
 * these assertions fails.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { PaletteItem } from '~/lib/commandPalette';
import { resolvePaletteGroups } from '~/lib/commandPaletteRegistry';
import {
	registerCommandPaletteProvider,
	useCommandPaletteRegistry,
} from '~/composables/useCommandPaletteRegistry';
import {
	POSTBOX_COMMAND_PROVIDER_ID,
	POSTBOX_COMMAND_PROVIDER_PRIORITY,
	matchPostboxRoute,
	usePostboxCommandSurface,
	type PostboxMarkReadCommand,
} from '../usePostboxCommandSurface';

describe('Postbox command provider descriptor', () => {
	it('keeps its stable registry id and external-tier priority', () => {
		expect(POSTBOX_COMMAND_PROVIDER_ID).toBe('surface:postbox');
		expect(POSTBOX_COMMAND_PROVIDER_PRIORITY).toBe(15);
	});

	it('gates on the Postbox surface exactly or a nested child, not siblings', () => {
		expect(matchPostboxRoute('/dashboard/postbox')).toBe(true);
		expect(matchPostboxRoute('/dashboard/postbox/inbox')).toBe(true);
		expect(matchPostboxRoute('/dashboard/postbox-archive')).toBe(false);
		expect(matchPostboxRoute('/dashboard/campaigns')).toBe(false);
	});
});

describe('Postbox command provider — "Switch mailbox ›"', () => {
	const switchToMailbox = vi.fn();
	let wrapper: VueWrapper | null = null;
	afterEach(() => {
		wrapper?.unmount();
		wrapper = null;
	});

	function mountSurface() {
		installNuxtStubs({
			...i18nStubs,
			registerCommandPaletteProvider,
			usePostboxComposeNav: () => ({ open: vi.fn() }),
			useDesktopContext: () => ({ isDesktop: ref(false) }),
			usePostboxLabels: () => ({ labels: ref([]) }),
			usePostboxFolders: () => ({ folders: ref([]) }),
			usePostboxFolderBulk: () => ({ canEmpty: () => false }),
			usePostboxMailbox: () => ({
				sections: ref({
					personal: [
						{ mailboxId: 'mb-ada', label: 'ada@example.com' },
						{ mailboxId: 'mb-alias', label: 'hello@example.com' },
					],
					team: [{ mailboxId: 'mb-support', label: 'Support' }],
				}),
				switchToMailbox,
			}),
		});
		wrapper = mount(
			defineComponent({
				setup() {
					usePostboxCommandSurface(ref('mb-ada') as never);
					return () => h('div');
				},
			}),
			{ global: { plugins: [createTestI18n()] } }
		);
	}

	function switchRows(query: string): PaletteItem[] {
		return resolvePaletteGroups(
			[],
			useCommandPaletteRegistry().value,
			{ path: '/dashboard/postbox/inbox', isFlagEnabled: () => true },
			{ query, mode: 'commands' }
		).flatMap((group) => (group.key === 'postbox-switch-mailbox' ? group.items : []));
	}

	it('is one row with every mailbox in its submenu', () => {
		mountSurface();
		const rows = switchRows('');
		expect(rows.map((row) => row.label)).toEqual(['Switch mailbox…']);
		const options = rows[0]!.argument!.options;
		expect(options.map((option) => option.label)).toEqual([
			'ada@example.com',
			'hello@example.com',
			'Support',
		]);
		options[2]!.run();
		expect(switchToMailbox).toHaveBeenCalledWith('mb-support');
	});

	it('also lists a typed-for mailbox directly, one Enter away', () => {
		mountSurface();
		expect(switchRows('support').map((row) => row.label)).toEqual(['Go to Support (team inbox)']);
	});
});

describe('Postbox command provider — whole-folder verbs', () => {
	const markAllRead = vi.fn();
	const markRead = vi.fn();
	const requestEmpty = vi.fn();
	let wrapper: VueWrapper | null = null;
	afterEach(() => {
		wrapper?.unmount();
		wrapper = null;
		markAllRead.mockReset();
		markRead.mockReset();
		requestEmpty.mockReset();
	});

	const folders = [
		{ _id: 'f-inbox', role: 'inbox', unseenCount: 3, totalCount: 9 },
		{ _id: 'f-drafts', role: 'drafts', unseenCount: 1, totalCount: 1 },
		{ _id: 'f-trash', role: 'trash', unseenCount: 0, totalCount: 4 },
		{ _id: 'f-news', role: null, unseenCount: 0, totalCount: 2 },
	];

	function verbsOn(
		folderRole: string,
		folderId?: string,
		mayEmpty = true,
		markReadCommands?: () => PostboxMarkReadCommand[]
	): PaletteItem[] {
		installNuxtStubs({
			...i18nStubs,
			registerCommandPaletteProvider,
			usePostboxComposeNav: () => ({ open: vi.fn() }),
			useDesktopContext: () => ({ isDesktop: ref(false) }),
			usePostboxLabels: () => ({ labels: ref([]) }),
			usePostboxFolders: () => ({ folders: ref(folders) }),
			usePostboxFolderBulk: () => ({
				canEmpty: (folder: { role?: string | null; totalCount: number }) =>
					mayEmpty && folder.role === 'trash' && folder.totalCount > 0,
				markAllRead,
				markRead,
				requestEmpty,
			}),
			usePostboxMailbox: () => ({
				sections: ref({ personal: [], team: [] }),
				switchToMailbox: vi.fn(),
			}),
		});
		wrapper = mount(
			defineComponent({
				setup() {
					usePostboxCommandSurface(ref('mb-ada') as never, {
						folderRole: ref(folderRole),
						folderId: ref(folderId) as never,
						markReadCommands,
					});
					return () => h('div');
				},
			}),
			{ global: { plugins: [createTestI18n()] } }
		);
		return resolvePaletteGroups(
			[],
			useCommandPaletteRegistry().value,
			{ path: '/dashboard/postbox/inbox', isFlagEnabled: () => true },
			{ query: '', mode: 'commands' }
		)
			.flatMap((group) => group.items)
			.filter(
				(item) =>
					item.id === 'postbox:mark-all-read' ||
					item.id === 'postbox:empty-folder' ||
					item.id.startsWith('postbox:mark-read:')
			);
	}

	it('offers "Mark all as read" for the folder on screen while it has unread mail', () => {
		const items = verbsOn('inbox');
		expect(items.map((item) => item.label)).toEqual(['Mark all as read']);
		items[0]!.run();
		expect(markAllRead).toHaveBeenCalledWith(folders[0]);
	});

	it('finds a custom folder by id, and says nothing when it has no unread mail', () => {
		expect(verbsOn('', 'f-news')).toEqual([]);
	});

	it('never offers "Mark all as read" in Drafts', () => {
		expect(verbsOn('drafts')).toEqual([]);
	});

	it("offers the view's own mark-read entries beside the folder's", () => {
		const target = {
			kind: 'category' as const,
			folderId: 'f-inbox' as never,
			category: 'newsletter' as const,
		};
		const items = verbsOn('inbox', undefined, true, () => [
			{ key: 'category:newsletter', label: 'Mark Newsletters as read', target },
		]);
		expect(items.map((item) => item.label)).toEqual([
			'Mark Newsletters as read',
			'Mark all as read',
		]);
		items[0]!.run();
		expect(markRead).toHaveBeenCalledWith(target);
	});

	it('offers "Empty trash" only to someone who may empty it', () => {
		const items = verbsOn('trash');
		expect(items.map((item) => item.label)).toEqual(['Empty trash']);
		items[0]!.run();
		expect(requestEmpty).toHaveBeenCalledWith(folders[2]);
		wrapper?.unmount();
		wrapper = null;
		expect(verbsOn('trash', undefined, false)).toEqual([]);
	});
});
