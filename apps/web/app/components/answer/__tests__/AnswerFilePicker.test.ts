/**
 * "Pick from Files" reads Files as compact cards (`files.cards`), not
 * whole rows, and does not offer a file whose bytes the retention sweep
 * released (`hasBytes: false`): there is nothing left to attach.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import { getFunctionName } from 'convex/server';
import { api } from '@owlat/api';

import AnswerFilePicker from '../AnswerFilePicker.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const CARDS = [
	{
		_id: 'sf_kept',
		filename: 'invoice-2026-08.pdf',
		title: 'Invoice August',
		mimeType: 'application/pdf',
		fileSize: 2048,
		sourceType: 'upload',
		version: 1,
		createdAt: 2,
		updatedAt: 2,
		hasBytes: true,
		url: 'https://files.example/kept',
	},
	{
		_id: 'sf_released',
		filename: 'old-scan.pdf',
		mimeType: 'application/pdf',
		fileSize: 4096,
		sourceType: 'email_attachment',
		version: 1,
		createdAt: 1,
		updatedAt: 1,
		hasBytes: false,
		url: null,
	},
];

const subscribed: string[] = [];
beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useDebouncedSearch: () => ({ query: ref(''), debouncedQuery: ref('') }),
		usePaginatedQuery: (fn: unknown, args: () => unknown) => {
			const name = getFunctionName(fn as never);
			if (args() !== 'skip') subscribed.push(name);
			return { results: ref(name.endsWith(':list') ? CARDS : []) };
		},
		useConvexQuery: () => ({ data: ref(undefined) }),
	});
});

describe('AnswerFilePicker', () => {
	it('lists Files cards and leaves out a file whose bytes are gone', () => {
		const wrapper = mount(AnswerFilePicker, {
			props: { open: true },
			global: {
				plugins: [createTestI18n()],
				stubs: { UiModal: { template: '<div><slot /></div>' } },
			},
		});

		expect(subscribed).toEqual([getFunctionName(api.files.cards.list)]);
		const rows = wrapper.findAll('[data-testid="file-picker-row"]');
		expect(rows.map((row) => row.text())).toEqual(['Invoice August2.0 KB']);

		void rows[0]!.trigger('click');
		expect(wrapper.emitted('pick')?.[0]?.[0]).toEqual({
			source: 'semanticFile',
			id: 'sf_kept',
			filename: 'invoice-2026-08.pdf',
		});
	});
});
