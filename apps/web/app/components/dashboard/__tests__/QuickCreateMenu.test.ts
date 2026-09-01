// @vitest-environment happy-dom
/**
 * The shell header's create button (UX piece T6).
 *
 * The button is only worth its header slot if it is honest: it must show the
 * verbs the registry allows and nothing else, its primary half must RUN one
 * rather than open a menu, and the `c` chord it advertises must exist exactly
 * when compose does — a documented key that silently does nothing is worse than
 * no key at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref, defineComponent, h } from 'vue';

import QuickCreateMenu from '../QuickCreateMenu.vue';

interface Action {
	id: string;
	label: string;
	icon: string;
	shortcutId?: string;
	run: () => void;
}

let actions: Action[];
let registered: Map<string, { handler: () => void; ignoreInputs?: boolean }>;

const Icon = defineComponent({
	props: { name: { type: String, default: '' } },
	setup: (props) => () => h('span', { 'data-icon': props.name }),
});
const UiDropdownMenu = defineComponent({
	setup:
		(_props, { slots }) =>
		() =>
			h('div', [h('div', slots['trigger']?.()), h('div', { role: 'menu' }, slots['default']?.())]),
});
const UiDropdownMenuItem = defineComponent({
	props: { icon: { type: String, default: '' } },
	emits: ['click'],
	setup:
		(props, { slots, emit }) =>
		() =>
			h(
				'button',
				{ role: 'menuitem', 'data-icon': props.icon, onClick: () => emit('click') },
				slots['default']?.()
			),
});

function mountMenu() {
	return mount(QuickCreateMenu, {
		global: { components: { Icon, UiDropdownMenu, UiDropdownMenuItem } },
	});
}

const compose = (): Action => ({
	id: 'compose',
	label: 'Compose email',
	icon: 'lucide:pencil',
	shortcutId: 'global.compose',
	run: vi.fn(),
});

beforeEach(() => {
	actions = [
		compose(),
		{ id: 'contact', label: 'Contact', icon: 'lucide:user-plus', run: vi.fn() },
	];
	registered = new Map();

	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
	vi.stubGlobal('useDesktopContext', () => ({ platform: ref('linux') }));
	vi.stubGlobal('useKeyboardShortcuts', () => ({
		registerShortcut: (config: { id: string; handler: () => void; ignoreInputs?: boolean }) =>
			registered.set(config.id, config),
		unregisterShortcut: (id: string) => registered.delete(id),
	}));
	vi.stubGlobal('useQuickCreateMenu', () => ({
		actions: computed(() => actions),
		defaultAction: computed(() => actions[0] ?? null),
		composeAction: computed(() => actions.find((action) => action.id === 'compose') ?? null),
	}));
});

describe('the split button', () => {
	it('runs the top verb from its primary half, without opening anything', async () => {
		const menu = mountMenu();

		await menu.get('[data-testid="quick-create-default"]').trigger('click');

		expect(actions[0]!.run).toHaveBeenCalledTimes(1);
	});

	it('lists every allowed verb behind the caret', async () => {
		const menu = mountMenu();

		const items = menu.findAll('[role="menuitem"]');
		expect(items.map((item) => item.find('span').text())).toEqual(['Compose email', 'Contact']);
		// Compose advertises its chord; a verb the catalog has no key for shows none.
		expect(items.map((item) => item.findAll('kbd').map((key) => key.text()))).toEqual([['c'], []]);

		await items[1]!.trigger('click');
		expect(actions[1]!.run).toHaveBeenCalledTimes(1);
	});

	it('is not drawn at all for a member with nothing to create', () => {
		actions = [];
		expect(mountMenu().find('[data-testid="quick-create"]').exists()).toBe(false);
	});
});

describe('the `c` chord', () => {
	it('runs compose, and ignores the key while typing', () => {
		mountMenu();

		const bound = registered.get('global.compose');
		expect(bound?.ignoreInputs).toBe(true);
		bound?.handler();
		expect(actions[0]!.run).toHaveBeenCalledTimes(1);
	});

	it('is not bound on an instance with no compose verb', () => {
		actions = actions.filter((action) => action.id !== 'compose');
		mountMenu();
		expect(registered.has('global.compose')).toBe(false);
	});

	it('is released when the shell goes away', () => {
		const menu = mountMenu();
		expect(registered.has('global.compose')).toBe(true);

		menu.unmount();
		expect(registered.has('global.compose')).toBe(false);
	});
});
