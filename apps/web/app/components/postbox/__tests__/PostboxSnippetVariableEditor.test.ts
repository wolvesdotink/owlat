// @vitest-environment happy-dom
/**
 * The snippet variable editor renders one row per token found in the body.
 *
 * The mount itself is the point of the first case: this component paints the
 * token as it appears in the snippet text, braces and all, and building those
 * braces inside the template silently broke the production build while every
 * unit suite stayed green (the Vue tokenizer ends an interpolation at the first
 * `}}`, so `{{ ` + backtick + `{{${token}}}` + backtick + ` }}` never parses).
 * Mounting the component compiles its template, so the class of bug cannot
 * come back unnoticed.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';

import PostboxSnippetVariableEditor from '../PostboxSnippetVariableEditor.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

function mountEditor(bodyHtml: string) {
	return mount(PostboxSnippetVariableEditor, {
		props: { bodyHtml, modelValue: [] },
		global: { plugins: [createTestI18n()], stubs: { Icon: true } },
	});
}

describe('PostboxSnippetVariableEditor', () => {
	it('prints each token exactly as it is written in the body', () => {
		const wrapper = mountEditor('<p>Hi {{firstName}}, about {{project}}</p>');

		const codes = wrapper.findAll('code').map((c) => c.text());
		expect(codes).toEqual(['{{firstName}}', '{{project}}']);
	});

	it('renders nothing when the body declares no tokens', () => {
		const wrapper = mountEditor('<p>Nothing to declare here.</p>');

		expect(wrapper.find('section').exists()).toBe(false);
	});
});
