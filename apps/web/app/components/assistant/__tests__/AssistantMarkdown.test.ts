/**
 * A streaming answer arrives as the whole text so far, once per flush. Blocks
 * that settled earlier must keep their parsed inlines between flushes so their
 * `AssistantInline` children skip the update; only the block the new text
 * extends re-renders (#1445).
 */
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import AssistantMarkdown from '../AssistantMarkdown.vue';
import AssistantInline from '../AssistantInline.vue';

function mountMarkdown(source: string) {
	const counter = { inlineUpdates: 0 };
	const wrapper = mount(AssistantMarkdown, {
		props: { source },
		global: {
			components: { AssistantInline },
			mixins: [
				{
					updated(this: { $options: { __name?: string } }) {
						if (this.$options.__name === 'AssistantInline') counter.inlineUpdates++;
					},
				},
			],
		},
	});
	return { wrapper, counter };
}

const SETTLED = [
	'# Open invoices',
	'',
	'There are **three** open invoices, see [the list](https://owlat.example/invoices).',
	'',
	'- First, due `Monday`',
	'- Second, due *Friday*',
	'',
	'```',
	'total: 3',
	'```',
	'',
	'> Paid ones are hidden.',
	'',
	'The last one',
].join('\n');

describe('AssistantMarkdown streaming', () => {
	it('re-renders only the block the appended text extends', async () => {
		const { wrapper, counter } = mountMarkdown(SETTLED);
		const before = wrapper.html();

		await wrapper.setProps({ source: `${SETTLED} is overdue` });
		expect(counter.inlineUpdates).toBe(1);
		expect(wrapper.findAll('p').at(-1)?.text()).toBe('The last one is overdue');
		// Everything above the tail renders exactly as before.
		const tailStart = before.lastIndexOf('<p>');
		expect(wrapper.html().slice(0, tailStart)).toBe(before.slice(0, tailStart));

		await wrapper.setProps({ source: `${SETTLED} is overdue by **two** days.` });
		expect(counter.inlineUpdates).toBe(2);
		expect(wrapper.findAll('p').at(-1)?.find('strong').text()).toBe('two');
	});

	it('updates only the growing item when a list is the tail', async () => {
		const list = '# Steps\n\nIntro.\n\n- one\n- two';
		const { wrapper, counter } = mountMarkdown(list);

		await wrapper.setProps({ source: `${list} and a half` });
		expect(counter.inlineUpdates).toBe(1);
		expect(wrapper.findAll('li').map((li) => li.text())).toEqual(['one', 'two and a half']);

		// A new item mounts a new child; the settled items stay put.
		await wrapper.setProps({ source: `${list} and a half\n- three` });
		expect(counter.inlineUpdates).toBe(1);
		expect(wrapper.findAll('li').map((li) => li.text())).toEqual([
			'one',
			'two and a half',
			'three',
		]);
	});

	it('still follows a block that changes type, a closing fence and a replaced source', async () => {
		const { wrapper } = mountMarkdown('Intro.\n\n```\nlet a = 1');
		expect(wrapper.find('pre').text()).toBe('let a = 1');

		await wrapper.setProps({ source: 'Intro.\n\n```\nlet a = 1\n```\n\nAfter the code.' });
		expect(wrapper.find('pre').text()).toBe('let a = 1');
		expect(wrapper.findAll('p').map((p) => p.text())).toEqual(['Intro.', 'After the code.']);

		await wrapper.setProps({ source: '# Intro.\n\nSomething else entirely.' });
		expect(wrapper.find('h1').text()).toBe('Intro.');
		expect(wrapper.find('pre').exists()).toBe(false);
		expect(wrapper.findAll('p').map((p) => p.text())).toEqual(['Something else entirely.']);

		await wrapper.setProps({ source: 'Short.' });
		expect(wrapper.text()).toBe('Short.');

		await wrapper.setProps({ source: '' });
		await nextTick();
		expect(wrapper.text()).toBe('');

		await wrapper.setProps({ source: 'Back again.' });
		expect(wrapper.text()).toBe('Back again.');
	});

	it('keeps each rendered answer separate', async () => {
		const a = mountMarkdown('Alpha one.\n\nAlpha two');
		const b = mountMarkdown('Beta one.\n\nBeta two');

		await a.wrapper.setProps({ source: 'Alpha one.\n\nAlpha two, more' });
		expect(a.wrapper.findAll('p').map((p) => p.text())).toEqual(['Alpha one.', 'Alpha two, more']);
		expect(b.wrapper.findAll('p').map((p) => p.text())).toEqual(['Beta one.', 'Beta two']);
		expect(b.counter.inlineUpdates).toBe(0);
	});
});
