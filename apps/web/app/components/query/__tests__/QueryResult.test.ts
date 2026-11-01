/**
 * The quick-query answer says when it stopped at its length limit
 * (`assistant/quickQuery.ask` `isTruncated`), and says nothing otherwise.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import QueryResult from '../QueryResult.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const mountResult = (isTruncated?: boolean) =>
	mount(QueryResult, {
		props: {
			answer: 'The contract renews on',
			sources: [],
			...(isTruncated ? { isTruncated } : {}),
		},
		global: { plugins: [createTestI18n()], stubs: { QuerySourceCitation: true } },
	});

describe('QueryResult', () => {
	it('marks an answer cut off at its length limit', () => {
		const w = mountResult(true);
		expect(w.get('[data-testid="query-result-cut-off"]').text()).toBe(
			'This answer was cut off at its length limit.'
		);
		expectFullyLocalized(w);
	});

	it('says nothing about a whole answer', () => {
		expect(mountResult().find('[data-testid="query-result-cut-off"]').exists()).toBe(false);
	});
});
