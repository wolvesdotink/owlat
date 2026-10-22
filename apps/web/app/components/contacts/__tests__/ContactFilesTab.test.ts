/**
 * The contact Files tab reads compact cards (`files.cards.listByContact`, #1439),
 * not `semanticFiles.listByContact`, which returns every row whole: embedding
 * vectors, extracted text and search text for a list that shows a name, a
 * size, a date, the source and two tags.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, RouterLinkStub } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

// Each `api.*` access remembers its path, so the test sees which query is read.
vi.mock('@owlat/api', () => {
	const at = (path: string[]): unknown =>
		new Proxy(function () {}, {
			get: (_target, key) => (key === '__path' ? path.join('.') : at([...path, String(key)])),
		});
	return { api: at([]) };
});

const files = ref<unknown[] | undefined>(undefined);
const reads: Array<{ path: string; args: () => unknown }> = [];

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useConvexQuery: (query: { __path: string }, args: () => unknown) => {
			reads.push({ path: query.__path, args });
			return { data: files, isLoading: ref(false) };
		},
	});
});

beforeEach(() => {
	files.value = undefined;
	reads.length = 0;
});

const ContactFilesTab = (await import('../ContactFilesTab.vue')).default;

function mountTab() {
	return mount(ContactFilesTab, {
		props: { contactId: 'c_1' as never },
		global: {
			plugins: [createTestI18n()],
			stubs: { NuxtLink: RouterLinkStub, Icon: true, UiSpinner: true, UiIconBox: true },
			// Nuxt auto-imports the template reads.
			mocks: { formatCompactFileSize: (bytes: number) => `${bytes} B`, formatDate: () => 'Oct 1' },
		},
	});
}

describe('ContactFilesTab', () => {
	it('reads the contact’s file cards, 50 at most', () => {
		mountTab();
		expect(reads.map((r) => r.path)).toEqual(['files.cards.listByContact']);
		expect(reads[0]!.args()).toEqual({ contactId: 'c_1', limit: 50 });
	});

	it('renders a row from the card fields alone', () => {
		files.value = [
			{
				_id: 'sf_1',
				filename: 'q3-report.pdf',
				title: 'Q3 report',
				mimeType: 'application/pdf',
				fileSize: 2048,
				tags: ['finance'],
				sourceType: 'email_attachment',
				version: 1,
				createdAt: 1,
				updatedAt: 1,
				hasBytes: true,
				url: null,
			},
		];
		const wrapper = mountTab();
		const link = wrapper.getComponent(RouterLinkStub);
		expect(link.props('to')).toBe('/dashboard/files/sf_1');
		expect(link.text()).toContain('Q3 report');
		expect(link.text()).toContain('2048 B');
		expect(link.text()).toContain('finance');
	});
});
