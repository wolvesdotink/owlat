/**
 * The one shortcuts page: every scope this instance has, a filter, fixed rows
 * that say why, a captured remap that is refused (and named) when another
 * shortcut is in the way, and Reset per row. Mounted with the real preferences
 * composable and registry; only the settings row and the save are stand-ins.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ref, useSlots } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { StoredShortcutOverride } from '~/utils/shortcutPresets';
import { resetShortcutPreferences } from '~/utils/shortcutScope';
import UiBadge from '@owlat/ui/components/ui/Badge.vue';
import UiInput from '@owlat/ui/components/ui/Input.vue';
import UiSelect from '@owlat/ui/components/ui/Select.vue';
import PreferencesShortcuts from '../PreferencesShortcuts.vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const shortcutPreset = ref<'owlat' | 'gmail' | 'superhuman' | 'outlook'>('owlat');
const shortcutOverrides = ref<StoredShortcutOverride[]>([]);
vi.mock('~/composables/postbox/usePostboxSettings', () => ({
	usePostboxSettings: () => ({ shortcutPreset, shortcutOverrides }),
}));

const save = vi.fn(async (args: { shortcutOverrides?: StoredShortcutOverride[] }) => {
	if (args.shortcutOverrides) shortcutOverrides.value = args.shortcutOverrides;
	return { ok: true };
});
let flags: string[];

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useSlots,
		useBackendOperation: () => ({ run: save, isLoading: ref(false) }),
		useFeatureFlag: () => ({ isEnabled: (flag: string) => flags.includes(flag) }),
		useDesktopContext: () => ({ isDesktop: ref(false) }),
	});
});
enableAutoUnmount(afterEach);
beforeEach(() => {
	flags = ['postbox', 'inbox', 'ai.assistant'];
	shortcutPreset.value = 'owlat';
	shortcutOverrides.value = [];
	save.mockClear();
	resetShortcutPreferences();
});

function mountPage() {
	return mount(PreferencesShortcuts, {
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			components: { UiBadge, UiInput, UiSelect },
			stubs: { Icon: true },
		},
	});
}

const row = (wrapper: VueWrapper, id: string) => wrapper.get(`[data-shortcut-id="${id}"]`);
const scopes = (wrapper: VueWrapper) =>
	wrapper.findAll('[data-scope]').map((section) => section.attributes('data-scope'));

async function capture(wrapper: VueWrapper, id: string, init: KeyboardEventInit) {
	const button = row(wrapper, id).get('button');
	await button.trigger('click');
	await button.trigger('keydown', init);
	await flushPromises();
}

describe('PreferencesShortcuts', () => {
	it('lists every scope this instance has, app-wide first', () => {
		const wrapper = mountPage();
		expect(scopes(wrapper)).toEqual([
			'global',
			'postbox',
			'composer',
			'inbox',
			'inboxList',
			'review',
			'workbench',
			'peek',
			'answer',
			'answerQueue',
			'askCard',
			'mailCard',
			'teamCard',
		]);
	});

	it('keeps the page without personal mail, minus the Postbox', () => {
		flags = ['inbox'];
		const wrapper = mountPage();
		expect(scopes(wrapper)).not.toContain('postbox');
		expect(scopes(wrapper)).toContain('global');
		expect(wrapper.find('[data-shortcut-id="global.assistant"]').exists()).toBe(false);
	});

	it('filters the rows by name or key, and says when nothing matches', async () => {
		const wrapper = mountPage();
		const filter = wrapper.get('[data-testid="shortcut-filter"]');
		await filter.setValue('open settings');
		expect(
			wrapper.findAll('[data-shortcut-id]').map((r) => r.attributes('data-shortcut-id'))
		).toEqual(['global.settings']);
		await filter.setValue('ctrl+,');
		expect(
			wrapper.findAll('[data-shortcut-id]').map((r) => r.attributes('data-shortcut-id'))
		).toEqual(['global.settings']);
		await filter.setValue('zzzz');
		expect(wrapper.findAll('[data-shortcut-id]')).toHaveLength(0);
		expect(wrapper.text()).toContain('No shortcut matches “zzzz”.');
	});

	it('shows a fixed row with its reason and no Change button', () => {
		const wrapper = mountPage();
		const palette = row(wrapper, 'global.commandPalette');
		expect(palette.text()).toContain('Fixed');
		expect(palette.text()).toContain('Works the same as in every other app.');
		expect(palette.find('button').exists()).toBe(false);
	});

	it('stores a captured chord for a chord command', async () => {
		const wrapper = mountPage();
		await capture(wrapper, 'global.settings', { key: '.', ctrlKey: true });
		expect(save).toHaveBeenCalledWith({
			shortcutOverrides: [{ id: 'global.settings', keys: ['mod+.'] }],
		});
		expect(row(wrapper, 'global.settings').text()).toContain('.');
	});

	it('refuses a key another shortcut in the scope already uses, and names it', async () => {
		const wrapper = mountPage();
		await capture(wrapper, 'global.settings', { key: '\\', ctrlKey: true });
		expect(save).not.toHaveBeenCalled();
		expect(row(wrapper, 'global.settings').text()).toContain(
			'Hide / show sidebar already uses that key.'
		);
	});

	it('refuses a chord a fixed shortcut of another scope answers itself', async () => {
		const wrapper = mountPage();
		await capture(wrapper, 'global.settings', { key: 'Enter', metaKey: true });
		expect(save).not.toHaveBeenCalled();
		expect(row(wrapper, 'global.settings').text()).toContain(
			'Send (in composer) already uses that key.'
		);
	});

	it("refuses the palette's Ask chord for Settings", async () => {
		flags = [...flags, 'ai.knowledge'];
		const wrapper = mountPage();
		await capture(wrapper, 'global.settings', { key: 'K', ctrlKey: true, shiftKey: true });
		expect(save).not.toHaveBeenCalled();
		expect(row(wrapper, 'global.settings').text()).toContain(
			'Ask knowledge already uses that key.'
		);
	});

	it('refuses the palette chord with Alt held, which the palette answers too', async () => {
		const wrapper = mountPage();
		await capture(wrapper, 'global.settings', { key: 'k', ctrlKey: true, altKey: true });
		expect(save).not.toHaveBeenCalled();
		expect(row(wrapper, 'global.settings').text()).toContain('Open search already uses that key.');
	});

	it('refuses a digit-row key with Shift, which switches workspace by position', async () => {
		const wrapper = mountPage();
		await capture(wrapper, 'global.settings', {
			key: '!',
			code: 'Digit1',
			ctrlKey: true,
			shiftKey: true,
		});
		expect(save).not.toHaveBeenCalled();
		expect(row(wrapper, 'global.settings').text()).toContain(
			'Switch workspace already uses that key.'
		);
	});

	it('refuses the ⌘1 key on a layout where it types another character', async () => {
		// AZERTY: the 1 key types `&`, and the workspace switch reads the position.
		const wrapper = mountPage();
		await capture(wrapper, 'global.settings', { key: '&', code: 'Digit1', ctrlKey: true });
		expect(save).not.toHaveBeenCalled();
		expect(row(wrapper, 'global.settings').text()).toContain(
			'Switch workspace already uses that key.'
		);
	});

	it("refuses an assign key that would take the Team inbox list's navigation", async () => {
		const wrapper = mountPage();
		await capture(wrapper, 'inboxList.assignToMe', { key: 'j' });
		expect(save).not.toHaveBeenCalled();
		expect(row(wrapper, 'inboxList.assignToMe').text()).toContain('Next already uses that key.');
	});

	it('refuses a key that would start a `g` chord', async () => {
		const wrapper = mountPage();
		await capture(wrapper, 'global.compose', { key: 'g' });
		expect(save).not.toHaveBeenCalled();
		expect(row(wrapper, 'global.compose').text()).toContain('start the same way');
	});

	it('refuses the wrong shape: a chord for a single key, a single key for a chord', async () => {
		const wrapper = mountPage();
		await capture(wrapper, 'postbox.archive', { key: 'e', ctrlKey: true });
		expect(row(wrapper, 'postbox.archive').text()).toContain('This shortcut is a single key');
		await capture(wrapper, 'global.assistant', { key: 'y' });
		expect(row(wrapper, 'global.assistant').text()).toContain('This shortcut needs Ctrl or Cmd');
		expect(save).not.toHaveBeenCalled();
	});

	it('resets one row to the active preset and leaves the other changes alone', async () => {
		shortcutOverrides.value = [
			{ id: 'global.settings', keys: ['mod+.'] },
			{ id: 'postbox.archive', keys: ['y'] },
		];
		const wrapper = mountPage();
		await flushPromises();
		const reset = row(wrapper, 'global.settings').findAll('button').at(1);
		expect(reset?.text()).toBe('Reset');
		await reset?.trigger('click');
		expect(save).toHaveBeenCalledWith({
			shortcutOverrides: [{ id: 'postbox.archive', keys: ['y'] }],
		});
	});

	it('flags a clash the person already lives with, on the banner and both rows', async () => {
		shortcutOverrides.value = [{ id: 'postbox.archive', keys: ['s'] }];
		const wrapper = mountPage();
		await flushPromises();
		expect(wrapper.get('[data-testid="shortcut-clashes"]').text()).toContain(
			'S is used by Archive, Star / unstar'
		);
		expect(row(wrapper, 'postbox.star').text()).toContain('Shares a key with Archive');
		expect(row(wrapper, 'postbox.archive').text()).toContain('Shares a key with Star / unstar');
	});
});
