import { describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestI18n } from './i18n';
import { takeVueWarnings, tolerateUnresolvedComponents, vueWarnHandler } from './vueWarnings';

const Unresolved = defineComponent({ template: '<div><UiNope /></div>' });
const Required = defineComponent({
	props: { title: { type: String, required: true } },
	template: '<h1>{{ title }}</h1>',
});

describe('the Vue warning guard', () => {
	it('records an unresolved component and a missing required prop', () => {
		mount(Unresolved);
		mount(Required);
		const recorded = takeVueWarnings();
		expect(recorded).toEqual([
			expect.stringContaining('Failed to resolve component: UiNope'),
			expect.stringContaining('Missing required prop: "title"'),
		]);
	});

	it('still prints every other warning instead of swallowing it', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			vueWarnHandler('Extraneous non-props attributes (id)', null, '');
			expect(warn).toHaveBeenCalledWith('[Vue warn]: Extraneous non-props attributes (id)');
		} finally {
			warn.mockRestore();
		}
		expect(takeVueWarnings()).toEqual([]);
	});

	it('lets an audit tolerate unresolved components while keeping the prop check', () => {
		const names: string[] = [];
		const handler = tolerateUnresolvedComponents((name) => names.push(name));
		handler('Failed to resolve component: UiNope', null, '');
		handler('Missing required prop: "title"', null, '');
		expect(names).toEqual(['UiNope']);
		expect(takeVueWarnings()).toEqual([expect.stringContaining('Missing required prop: "title"')]);
	});
});

describe('the test catalog', () => {
	it('throws on a message key the catalog does not carry', () => {
		const { t } = createTestI18n().global;
		expect(() => t('shared.useCommandPaletteProviders.notAKey')).toThrow(
			"'shared.useCommandPaletteProviders.notAKey' is not in the 'en' catalog"
		);
	});

	it('hands plain text back unchanged, the way the screens rely on', () => {
		const { t } = createTestI18n().global;
		expect(t('Amazon SES')).toBe('Amazon SES');
		expect(t('the latest measurements')).toBe('the latest measurements');
	});
});
