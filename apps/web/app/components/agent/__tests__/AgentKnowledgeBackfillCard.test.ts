/**
 * The knowledge backfill card reports how many messages the run left partly
 * read at the AI spend budget. The count only grows, so the copy reads it
 * as history and promises no completion; nothing is said while it is zero.
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
	it('reports the messages the run left partly read, as a count that only grows', () => {
		const w = mountCard({ partialCount: 2 });
		expect(w.get('[data-testid="knowledge-backfill-partial"]').text()).toBe(
			'2 messages were only partly read during this backfill because the AI spend budget was reached. This count does not go down when they are finished later, and some may stay unfinished.'
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
