// @vitest-environment happy-dom
/**
 * "AI safety check not run" (D13, U4): the reason the model guard was skipped,
 * for each recorded reason, and that it runs before the agent acts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import InboxGuardNotRunNotice from '../InboxGuardNotRunNotice.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import { GUARD_NOT_RUN_REASONS } from '@owlat/shared/aiRouting';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

function mountNotice(reason: (typeof GUARD_NOT_RUN_REASONS)[number]) {
	return mount(InboxGuardNotRunNotice, {
		props: { marker: { reason, at: Date.UTC(2026, 9, 7, 7, 12) } },
		global: { plugins: [createTestI18n()], stubs: { Icon: true } },
	});
}

describe('InboxGuardNotRunNotice', () => {
	it('names the spam archive as the reason', () => {
		const w = mountNotice('spam_archived');
		expect(w.text()).toContain('AI safety check not run');
		expect(w.text()).toContain('archived as spam');
		expect(w.text()).toContain('It runs before the agent does anything with the message.');
		expect(w.get('[data-testid="thread-guard-not-run"]').attributes('data-reason')).toBe(
			'spam_archived'
		);
		expectFullyLocalized(w);
	});

	it('names the agent being off as the reason', () => {
		const w = mountNotice('agent_disabled');
		expect(w.text()).toContain('the agent was off when this message arrived');
		expectFullyLocalized(w);
	});

	it('names the AI spend budget as the reason', () => {
		const w = mountNotice('budget_refused');
		expect(w.text()).toContain('the AI spend budget was used up');
		expectFullyLocalized(w);
	});

	it('has a sentence for every recorded reason', () => {
		for (const reason of GUARD_NOT_RUN_REASONS) {
			expect(mountNotice(reason).text()).not.toContain('components.inbox');
		}
	});
});
