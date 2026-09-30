// @vitest-environment happy-dom
/**
 * "What should the reply say?" (plan §04):
 *   - Enter or the button drafts, with the optional instruction;
 *   - Cmd/Ctrl+J reaches the instruction field through `useAnswerAiFocus`;
 *   - while the AI checks or writes, the bar says so and takes no second start;
 *   - an AI draft in the editor gets a quiet "AI draft · Discard" tag.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';

import AnswerAiBar from '../AnswerAiBar.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import { auditA11y } from '~/__tests__/a11y';
import { useAnswerAiFocus } from '~/composables/useAnswerMode';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const mountBar = (props: Record<string, unknown> = {}) =>
	mount(AnswerAiBar, { props, attachTo: document.body, global: { plugins: [createTestI18n()] } });

describe('AnswerAiBar', () => {
	it('drafts with the instruction, from Enter or the button', async () => {
		const w = mountBar();
		await w.get('[data-testid="answer-ai-instruction"]').setValue('say sorry it is late');
		await w.get('form').trigger('submit');
		await w.get('[data-testid="answer-ai-draft"]').trigger('click');
		expect(w.emitted('draft')?.[0]).toEqual(['say sorry it is late']);
		expectFullyLocalized(w);
		w.unmount();
	});

	it('is where Cmd/Ctrl+J lands, and lets go when it leaves', async () => {
		const w = mountBar();
		expect(useAnswerAiFocus().request()).toBe(true);
		expect(document.activeElement).toBe(w.get('[data-testid="answer-ai-instruction"]').element);
		w.unmount();
		expect(useAnswerAiFocus().request()).toBe(false);
	});

	it('says what it is doing and takes no second start while busy', async () => {
		const w = mountBar({ phase: 'drafting', busy: true });
		expect(w.get('[data-testid="answer-ai-status"]').text()).toBe('Writing the draft…');
		expect(w.get('[data-testid="answer-ai-draft"]').attributes('disabled')).toBeDefined();
		await w.get('form').trigger('submit');
		expect(w.emitted('draft')).toBeUndefined();
		w.unmount();
	});

	it('offers to discard an AI draft, and warns when the mail tried to steer it', async () => {
		const w = mountBar({ hasAiDraft: true, injectionFlagged: true });
		expect(w.get('[data-testid="answer-ai-draft-tag"]').text()).toContain('AI draft');
		await w.get('[data-testid="answer-ai-discard"]').trigger('click');
		expect(w.emitted('discard')).toHaveLength(1);
		expect(w.find('[data-testid="answer-ai-injection"]').exists()).toBe(true);
		w.unmount();
	});

	it('passes an accessibility audit', async () => {
		const violations = await auditA11y(AnswerAiBar, {
			props: { hasAiDraft: true },
			global: { plugins: [createTestI18n()] },
		});
		expect(violations).toEqual([]);
	});
});
