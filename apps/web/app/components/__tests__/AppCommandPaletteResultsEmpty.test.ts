import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import AppCommandPaletteResults from '../AppCommandPaletteResults.vue';
import type { PaletteGroup } from '~/lib/commandPalette';
import type { PalettePrompt } from '~/composables/useCommandPaletteScope';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { TerminalIcon } from '@coolicons/vue';

/**
 * The stand-in under the rows. An empty box has searched for nothing, so it
 * must never report "No matches"; that answer belongs to a query that ran.
 */
beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const example: PaletteGroup = {
	key: 'mail-try',
	heading: 'Try',
	order: 0,
	items: [{ id: 'mail-example:is:unread', label: 'is:unread', icon: TerminalIcon, run: () => {} }],
};

function mountResults(props: {
	groups?: PaletteGroup[];
	matchTerm: string;
	prompt: PalettePrompt;
	askAvailable?: boolean;
}) {
	const groups = props.groups ?? [];
	return mount(AppCommandPaletteResults, {
		props: {
			groups,
			activeIndex: 0,
			indexById: new Map(groups.flatMap((g) => g.items).map((item, index) => [item.id, index])),
			matchTerm: props.matchTerm,
			prompt: props.prompt,
			isSearching: false,
			hasRows: groups.some((g) => g.items.length > 0),
			askAnswer: null,
			askLoading: false,
			askAvailable: props.askAvailable ?? true,
		},
		global: { plugins: [createTestI18n()], stubs: { QueryResult: true } },
	});
}

describe('palette empty states', () => {
	it('says nothing about matches while the box is empty', () => {
		for (const prompt of ['mailSearch', 'palette', 'argument'] as const) {
			const wrapper = mountResults({ matchTerm: '', prompt });
			expect(wrapper.text()).not.toContain('No matches');
		}
	});

	it('asks for more than one character before Mail has searched', () => {
		const wrapper = mountResults({ matchTerm: 'q', prompt: 'mailSearch' });
		expect(wrapper.text()).toContain('Keep typing to search your mail');
		expect(wrapper.text()).not.toContain('No matches');
	});

	it('reports no matches once a filter or a search has run', () => {
		expect(mountResults({ matchTerm: 'q', prompt: 'palette' }).text()).toContain('No matches');
		expect(mountResults({ matchTerm: 'zqxw', prompt: 'mailSearch' }).text()).toContain(
			'No results for "zqxw"'
		);
	});
});

describe('the prefix legend', () => {
	function legend(wrapper: ReturnType<typeof mountResults>) {
		return wrapper
			.findAll('dt')
			.map((dt, index) => [dt.text(), wrapper.findAll('dd')[index]!.text()]);
	}

	it('says what each prefix does under an empty Mail box', () => {
		const wrapper = mountResults({ groups: [example], matchTerm: '', prompt: 'mailSearch' });
		expect(legend(wrapper)).toEqual([
			['>', 'Commands, pages and settings'],
			['@', 'People and contacts'],
			['#', 'Labels'],
			['?', 'Ask your knowledge base'],
		]);
		// A legend is not something to pick: it stays out of the listbox.
		expect(wrapper.get('[role="listbox"]').find('dl').exists()).toBe(false);
	});

	it('leaves out `?` where knowledge is switched off', () => {
		const wrapper = mountResults({
			groups: [example],
			matchTerm: '',
			prompt: 'mailSearch',
			askAvailable: false,
		});
		expect(legend(wrapper).map(([prefix]) => prefix)).toEqual(['>', '@', '#']);
	});

	it('steps aside once something is typed, and outside Mail scope', () => {
		expect(mountResults({ matchTerm: 'from:', prompt: 'mailSearch' }).find('dl').exists()).toBe(
			false
		);
		expect(mountResults({ matchTerm: '', prompt: 'palette' }).find('dl').exists()).toBe(false);
	});
});
