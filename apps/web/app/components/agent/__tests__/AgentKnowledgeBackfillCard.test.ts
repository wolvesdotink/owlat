// @vitest-environment happy-dom
/**
 * The knowledge backfill card counts the messages only partly read so far
 * (D1: the AI spend budget paused them; their deferral finishes them), and
 * says nothing about it while there are none.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import AgentKnowledgeBackfillCard from '../AgentKnowledgeBackfillCard.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const job = ref<Record<string, unknown> | null>(null);

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useConvexQuery', () => ({ data: job }));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn(), isLoading: ref(false) }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
});

function mountCard(over: Record<string, unknown> = {}) {
	job.value = {
		status: 'completed',
		totalCount: 10,
		scannedCount: 10,
		extractedCount: 7,
		skippedCount: 1,
		errorCount: 0,
		...over,
	};
	return mount(AgentKnowledgeBackfillCard, {
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: true, UiButton: true, UiProgressBar: true, UiSpinner: true },
		},
	});
}

describe('AgentKnowledgeBackfillCard', () => {
	it('counts the messages the budget left partly read', () => {
		const w = mountCard({ partialCount: 2 });
		expect(w.get('[data-testid="knowledge-backfill-partial"]').text()).toBe(
			'2 messages are only partly read so far, usually because the AI spend budget was reached. They finish on their own later.'
		);
		expectFullyLocalized(w);
	});

	it('says nothing about it when none are partial or the job predates the count', () => {
		expect(
			mountCard({ partialCount: 0 }).find('[data-testid="knowledge-backfill-partial"]').exists()
		).toBe(false);
		expect(mountCard().find('[data-testid="knowledge-backfill-partial"]').exists()).toBe(false);
	});
});
