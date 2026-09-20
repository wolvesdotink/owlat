// @vitest-environment happy-dom
/**
 * The file library's own "the bytes are gone" state.
 *
 * The inbound retention sweep releases a team-inbox capture's BYTES and keeps
 * the row, so `semanticFiles.get` answers `url: null` — and the detail page's
 * download link is `v-if="file.url"`, which means the control simply vanishes
 * while the name, the size and the summary all stay. That is the same
 * "affordance shows nothing at all" shape the thread view was fixed for, one
 * screen over.
 *
 * Mounted shallow: the page's own markup is what carries the line, and every
 * child (pickers, dialogs, version list) is beside the point here.
 */
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { queryResult } from '~/__tests__/queryStubs';
import { formatCompactFileSize, formatDateTime } from '~/utils/formatters';

Object.assign(globalThis, { useI18n: i18nStubs.useI18n });

const RELEASED = '[data-testid="file-bytes-released"]';

type FileRow = {
	_id: string;
	filename: string;
	title?: string;
	fileSize: number;
	mimeType: string;
	sourceType: string;
	url: string | null;
	bytesReleasedAt?: number;
	createdAt: number;
	tags?: string[];
	contactIds?: string[];
};

function fileRow(over: Partial<FileRow> = {}): FileRow {
	return {
		_id: 'file_1',
		filename: 'contract.pdf',
		fileSize: 2048,
		mimeType: 'application/pdf',
		sourceType: 'email_attachment',
		url: 'https://storage.test/contract.pdf',
		createdAt: Date.now(),
		...over,
	};
}

async function mountPage(file: FileRow) {
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('useRouter', () => ({ push: vi.fn() }));
	vi.stubGlobal('useRoute', () => ({ params: { id: file._id } }));
	vi.stubGlobal('useRouteId', () => ref(file._id));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('usePermissions', () => ({ isAdmin: ref(true) }));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn(), isLoading: ref(false) }));
	vi.stubGlobal('useConvexQuery', (_query: unknown, args: unknown) => {
		// The page asks for the file, its versions and its linked contacts with
		// the same composable; only the first answers a row.
		const request = typeof args === 'function' ? (args as () => unknown)() : args;
		if (request && typeof request === 'object' && 'fileId' in request) {
			return queryResult(file);
		}
		return queryResult([]);
	});

	const Page = (await import('../[id].vue')).default;
	return mount(Page, {
		shallow: true,
		global: {
			plugins: [createTestI18n()],
			// Auto-imported helpers the TEMPLATE calls: Nuxt rewrites those to
			// imports at build time, so outside the Nuxt vite plugin they resolve
			// through the instance proxy instead of the module scope.
			mocks: { formatCompactFileSize, formatDateTime },
			// Nuxt auto-registers the UI layer and the page's own components;
			// `shallow` only stubs what it can resolve, so the ones this page
			// reaches for are named here.
			stubs: {
				UiSpinner: true,
				UiIconBox: true,
				UiCard: true,
				UiModal: true,
				UiConfirmDialog: true,
				UiSelect: true,
				UiInput: true,
				FilesVersionHistory: true,
				FilesVersionUploadModal: true,
				FilesContactPicker: true,
				FilesThreadPicker: true,
				FilesFileUploadModal: true,
			},
		},
	});
}

describe('file detail — released bytes', () => {
	it('explains the missing download when the retention window released the bytes', async () => {
		const wrapper = await mountPage(fileRow({ url: null, bytesReleasedAt: Date.now() }));

		const line = wrapper.find(RELEASED);
		expect(line.exists()).toBe(true);
		expect(line.text()).toContain('retention window');
		// The row itself survives the sweep, which is the point of saying so.
		expect(wrapper.text()).toContain('contract.pdf');
		wrapper.unmount();
	});

	it('says nothing when the bytes are still there', async () => {
		const wrapper = await mountPage(fileRow());

		expect(wrapper.find(RELEASED).exists()).toBe(false);
		wrapper.unmount();
	});
});
