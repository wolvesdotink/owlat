import { mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import AgentInsight from '../AgentInsight.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useConvexQuery', () => ({ data: ref([]), isLoading: ref(false) }));
});

/**
 * #779 — the agent's working (confidence, the processing trace) sits behind
 * one "Why did the agent do this?" disclosure instead of a block on every
 * message. Closed by default; the host page renders it for admins only.
 */
function mountInsight() {
	return mount(AgentInsight, {
		props: {
			inboundMessageId: 'msg_1' as never,
			classification: {
				category: 'billing',
				priority: 'urgent',
				sentiment: 'negative',
				confidence: 0.92,
			},
			decisionReason: 'Refunds need a person',
		},
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: true, InboxAgentActionTimeline: { template: '<div data-stub="trace" />' } },
		},
	});
}

describe('InboxAgentInsight', () => {
	it('is closed by default — no confidence number on the page', () => {
		const wrapper = mountInsight();
		expect(wrapper.text()).toContain('Why did the agent do this?');
		expect(wrapper.text()).not.toContain('92');
		expect(wrapper.find('[data-stub="trace"]').exists()).toBe(false);
	});

	it('opens to the classification, confidence, reason and trace', async () => {
		const wrapper = mountInsight();
		await wrapper.get('button').trigger('click');
		const body = wrapper.get('[data-testid="agent-insight-body"]').text();
		expect(body).toContain('Sorted as billing, urgent priority, negative tone.');
		expect(body).toContain('Confidence: 92%.');
		expect(body).toContain('Refunds need a person');
		expect(wrapper.find('[data-stub="trace"]').exists()).toBe(true);
	});
});
