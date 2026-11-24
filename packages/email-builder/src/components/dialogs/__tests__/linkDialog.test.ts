// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import LinkDialog from '../LinkDialog.vue';

let wrapper: VueWrapper | null = null;
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

const apply = async (url: string) => {
	wrapper = mount(LinkDialog, {
		global: {
			stubs: {
				UiModal: { template: '<div><slot /><slot name="footer" /></div>' },
				UiButton: { template: '<button @click="$emit(\'click\')"><slot /></button>' },
			},
		},
	});
	await wrapper.find('input').setValue(url);
	await wrapper.find('input').trigger('keydown', { key: 'Enter' });
	return wrapper.emitted('apply')?.[0]?.[0];
};

describe('LinkDialog', () => {
	it('adds https:// to an address without a scheme', async () => {
		expect(await apply('example.com')).toBe('https://example.com');
	});

	it('keeps a link that is a variable as written', async () => {
		expect(await apply("{{target|'https://example.com/default'}}")).toBe(
			"{{target|'https://example.com/default'}}"
		);
	});
});
