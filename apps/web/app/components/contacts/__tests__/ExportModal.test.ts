/**
 * The contacts export: the CSV writer (and papaparse behind it) is fetched by
 * the first export that has rows, so the modal the contacts page mounts on load
 * carries none of it. An empty selection never fetches it, and a writer that
 * cannot be fetched ends in the modal's ordinary failure toast.
 *
 * Mounted against the real English catalog.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, h } from 'vue';

import { createTestI18n } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const csvModule = vi.hoisted(() => ({ loads: 0 }));
vi.mock('~/utils/contactsCsv', async (importOriginal) => {
	csvModule.loads += 1;
	return importOriginal();
});

import ExportModal from '../ExportModal.vue';

const i18n = createTestI18n();

let toasts: Array<{ text: string; tone?: string }>;
let query: ReturnType<typeof vi.fn>;
let downloads: Array<{ blob: Blob; filename: string }>;

const UiModalStub = defineComponent({
	props: { open: Boolean, closable: Boolean, persistent: Boolean, size: String },
	emits: ['update:open'],
	setup(props, { slots }) {
		return () =>
			props.open
				? h('div', { class: 'modal' }, [
						h('div', { class: 'body' }, slots.default?.()),
						h('div', { class: 'footer' }, slots.footer?.()),
					])
				: null;
	},
});

const UiButtonStub = defineComponent({
	emits: ['click'],
	setup(_, { slots, emit }) {
		return () => h('button', { onClick: () => emit('click') }, slots.default?.());
	},
});

const contact = (email: string) => ({ _id: `id-${email}`, email, firstName: 'Ada' });

beforeEach(() => {
	toasts = [];
	downloads = [];
	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('useToast', () => ({
		showToast: (text: string, tone?: string) => toasts.push({ text, tone }),
	}));
	query = vi.fn();
	vi.stubGlobal('useConvex', () => ({ query }));

	// `downloadCsv` builds a real blob and clicks a real anchor; capture both.
	Object.defineProperty(URL, 'createObjectURL', {
		configurable: true,
		value: (blob: Blob) => {
			downloads.push({ blob, filename: '' });
			return 'blob:csv';
		},
	});
	Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
	vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
		this: HTMLAnchorElement
	) {
		const pending = downloads[downloads.length - 1];
		if (pending) pending.filename = this.getAttribute('download') ?? '';
	});
});

// NOTE: no `vi.unstubAllGlobals()` teardown — it would also drop the Vue
// reactivity primitives app/__tests__/setup.ts installs as Nuxt auto-imports.

async function exportContacts() {
	const wrapper = mount(ExportModal, {
		props: { open: true, totalCount: 2, searchQuery: '', contactProperties: [] },
		global: {
			plugins: [i18n],
			stubs: {
				UiModal: UiModalStub,
				UiButton: UiButtonStub,
				UiSelectableListItem: true,
			},
		},
	});
	const button = wrapper.findAll('button').find((b) => b.text().includes('Export to CSV'));
	if (!button) throw new Error(`No export button in: ${wrapper.text()}`);
	await button.trigger('click');
	await vi.dynamicImportSettled();
	await flushPromises();
	return wrapper;
}

describe('ExportModal', () => {
	// First in the file: no earlier case has fetched the writer yet.
	it('loads no CSV writer with the modal, nor for an empty selection', async () => {
		query.mockResolvedValueOnce([]);

		const wrapper = await exportContacts();

		expect(csvModule.loads).toBe(0);
		expect(downloads).toHaveLength(0);
		expect(toasts).toEqual([{ text: 'No contacts to export', tone: undefined }]);
		expect(wrapper.emitted('update:open')).toEqual([[false]]);
	});

	it('loads the CSV writer and downloads the rows', async () => {
		query
			.mockResolvedValueOnce([contact('ada@example.com'), contact('grace@example.com')])
			.mockResolvedValueOnce({});

		const wrapper = await exportContacts();

		expect(downloads).toHaveLength(1);
		const csv = await downloads[0]!.blob.text();
		expect(csv).toContain('ada@example.com');
		expect(csv).toContain('grace@example.com');
		expect(downloads[0]!.filename).toMatch(/^contacts-export-\d{4}-\d{2}-\d{2}\.csv$/);
		expect(toasts[0]?.text).toMatch(/^Exported 2 contacts to contacts-export-/);
		expect(wrapper.emitted('update:open')).toEqual([[false]]);
	});

	it('shows the export failure when the CSV writer cannot be fetched', async () => {
		query.mockResolvedValueOnce([contact('ada@example.com')]);
		vi.doMock('~/utils/contactsCsv', () => {
			throw new Error('Failed to fetch dynamically imported module');
		});
		let wrapper: Awaited<ReturnType<typeof exportContacts>>;
		try {
			wrapper = await exportContacts();
		} finally {
			vi.doUnmock('~/utils/contactsCsv');
		}

		expect(downloads).toHaveLength(0);
		expect(toasts).toEqual([{ text: 'Export failed. Please try again.', tone: 'error' }]);
		// The modal stays open for another try.
		expect(wrapper.emitted('update:open')).toBeUndefined();
	});
});
