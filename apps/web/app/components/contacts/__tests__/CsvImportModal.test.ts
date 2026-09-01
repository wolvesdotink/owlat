// @vitest-environment happy-dom
/**
 * CSV import — the two ways the wizard used to lose work (UX plan T4).
 *
 *   1. THE CLOSE GUARD. Only the `importing` step blocked closing, so Escape, a
 *      backdrop click or the X at `mapping`/`listMapping`/`preview` threw away
 *      the parsed file AND the column mapping with no warning (`close()` keeps
 *      the state, but `open()` resets it, so it is gone for good). Those three
 *      steps now ask first; `upload` and `complete` still close on the spot.
 *   2. THE ERROR LIST. The complete step rendered the first five failures and
 *      nothing else — the rest existed only in memory and died with the modal.
 *      The screen list stays capped (plus an "and N more" line); the download
 *      carries every row.
 *
 * Plus the rest of the dead-end success step: "View imported" goes to the topic
 * the rows landed in (the full contacts list, said out loud, when there is
 * none), and "Add to topic…" assigns them without leaving the modal.
 *
 * Mounted against the real English catalog, so the assertions are the sentences
 * an operator reads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';

import { createTestI18n } from '~/__tests__/i18n';
import { buildImportErrorsCsv } from '~/utils/contactsCsv';

// The modal imports `api` only to name the mutation it runs; the stubbed
// operation below never reaches Convex.
vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

import { useCsvImport, type ImportResults, type ImportStep } from '~/composables/useCsvImport';
import CsvImportModal from '../CsvImportModal.vue';

/**
 * One instance for both callers: the composable is created OUTSIDE a component
 * here (so vue-i18n's own `useI18n()` would throw), while the modal calls it
 * from `setup()`. The global composer's `t` is the same catalog either way.
 */
const i18n = createTestI18n();

let toasts: string[];
let navigate: ReturnType<typeof vi.fn>;
let runOperation: ReturnType<typeof vi.fn>;
let downloads: Array<{ blob: Blob; filename: string }>;

/** The dialog shell, reduced to what this suite drives: the two slots and the
 *  one `update:open(false)` every close path (X, Escape, backdrop) goes through. */
const UiModalStub = defineComponent({
	props: { open: Boolean, closable: Boolean, persistent: Boolean, size: String },
	emits: ['update:open'],
	setup(props, { slots, emit }) {
		return () =>
			props.open
				? h('div', { class: 'modal' }, [
						h('button', { class: 'dismiss', onClick: () => emit('update:open', false) }, 'dismiss'),
						h('div', { class: 'body' }, slots.default?.()),
						h('div', { class: 'footer' }, slots.footer?.()),
					])
				: null;
	},
});

beforeEach(() => {
	toasts = [];
	navigate = vi.fn();
	runOperation = vi.fn().mockResolvedValue({ ok: true, result: { addedToList: 2 } });
	downloads = [];

	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('useToast', () => ({ showToast: (text: string) => toasts.push(text) }));
	vi.stubGlobal('navigateTo', navigate);
	vi.stubGlobal('useBackendOperation', () => ({
		run: runOperation,
		isLoading: ref(false),
		inlineError: ref(null),
	}));

	// `downloadCsv` builds a real blob and clicks a real anchor; capture both
	// rather than mocking the util, so the bytes asserted are the bytes saved.
	Object.defineProperty(URL, 'createObjectURL', {
		configurable: true,
		value: (blob: Blob) => {
			downloads.push({ blob, filename: '' });
			return 'blob:csv';
		},
	});
	Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
	vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
		function (this: HTMLAnchorElement) {
			const pending = downloads[downloads.length - 1];
			if (pending) pending.filename = this.getAttribute('download') ?? '';
		}
	);
});

// NOTE: no `vi.unstubAllGlobals()` teardown — it would also drop the Vue
// reactivity primitives app/__tests__/setup.ts installs as Nuxt auto-imports.

interface ModalState {
	step: ImportStep;
	file?: string;
	headers?: string[];
	rows?: string[][];
	results?: Partial<ImportResults>;
	globalTopicId?: string;
	columnTopicMapping?: Record<string, string | null>;
}

function mountModal(state: ModalState, topics: Array<{ _id: string; name: string }> = []) {
	const csvImport = useCsvImport();
	csvImport.isOpen.value = true;
	csvImport.step.value = state.step;
	csvImport.csvHeaders.value = state.headers ?? ['Email', 'First Name'];
	csvImport.parsedData.value = state.rows ?? [['ada@example.com', 'Ada']];
	csvImport.columnMapping.value = { 0: 'email', 1: 'firstName' };
	csvImport.selectedFile.value = new File([''], state.file ?? 'people.csv', { type: 'text/csv' });
	if (state.results) {
		csvImport.results.value = {
			imported: 0,
			updated: 0,
			skipped: 0,
			failed: 0,
			errors: [],
			...state.results,
		};
	}
	if (state.globalTopicId) csvImport.selectGlobalTopic(state.globalTopicId);
	if (state.columnTopicMapping) {
		csvImport.listAssignmentMode.value = 'column';
		csvImport.listNameMapping.value = state.columnTopicMapping;
	}

	const wrapper = mount(CsvImportModal, {
		props: { csvImport, topics },
		global: {
			plugins: [i18n],
			stubs: {
				UiModal: UiModalStub,
				Icon: true,
				I18nT: true,
				UiIconBox: true,
				UiStatCard: true,
				UiProgressBar: true,
			},
		},
	});

	return { wrapper, csvImport };
}

/** The button an operator would click, found by its visible label. */
function clickButton(wrapper: ReturnType<typeof mount>, label: string) {
	const button = wrapper.findAll('button').find((b) => b.text().includes(label));
	if (!button) throw new Error(`No button labelled "${label}" in: ${wrapper.text()}`);
	return button.trigger('click');
}

const DISCARD_PROMPT = 'Discard this import?';

describe('CsvImportModal — the close guard', () => {
	it.each<ImportStep>(['mapping', 'listMapping', 'preview'])(
		'asks before throwing away the upload at the %s step',
		async (step) => {
			const { wrapper, csvImport } = mountModal({ step });

			await wrapper.find('.dismiss').trigger('click');

			expect(csvImport.isOpen.value).toBe(true);
			expect(wrapper.text()).toContain(DISCARD_PROMPT);
			expect(wrapper.text()).toContain('Your file and column mapping will be lost.');
			// The file and the mapping are still there to come back to.
			expect(csvImport.parsedData.value).toHaveLength(1);
			expect(csvImport.columnMapping.value[0]).toBe('email');
		}
	);

	it('keeps the wizard when the operator backs out of the prompt', async () => {
		const { wrapper, csvImport } = mountModal({ step: 'mapping' });

		await wrapper.find('.dismiss').trigger('click');
		await clickButton(wrapper, 'Keep editing');

		expect(csvImport.isOpen.value).toBe(true);
		expect(wrapper.text()).not.toContain(DISCARD_PROMPT);
		expect(csvImport.step.value).toBe('mapping');
		// Back on the mapping step, not a blank upload.
		expect(wrapper.text()).toContain('Handle Duplicates');
	});

	/** Escape/backdrop dismiss the TOP layer — the prompt — never the wizard. */
	it('dismisses the prompt, not the import, on a second dismiss', async () => {
		const { wrapper, csvImport } = mountModal({ step: 'preview' });

		await wrapper.find('.dismiss').trigger('click');
		await wrapper.find('.dismiss').trigger('click');

		expect(csvImport.isOpen.value).toBe(true);
		expect(wrapper.text()).not.toContain(DISCARD_PROMPT);
	});

	it('closes once the discard is confirmed', async () => {
		const { wrapper, csvImport } = mountModal({ step: 'mapping' });

		await wrapper.find('.dismiss').trigger('click');
		await clickButton(wrapper, 'Discard');

		expect(csvImport.isOpen.value).toBe(false);
	});

	it.each<ImportStep>(['upload', 'complete'])(
		'closes straight away from the %s step, which has nothing to lose',
		async (step) => {
			const { wrapper, csvImport } = mountModal({
				step,
				results: { imported: 3 },
			});

			await wrapper.find('.dismiss').trigger('click');

			expect(csvImport.isOpen.value).toBe(false);
		}
	);

	it('does not carry an armed prompt into the next import', async () => {
		const { wrapper, csvImport } = mountModal({ step: 'mapping' });
		await wrapper.find('.dismiss').trigger('click');
		expect(wrapper.text()).toContain(DISCARD_PROMPT);

		await clickButton(wrapper, 'Discard');
		csvImport.open();
		await flushPromises();

		expect(wrapper.text()).not.toContain(DISCARD_PROMPT);
		expect(wrapper.text()).toContain('Drop your CSV file here');
	});
});

describe('CsvImportModal — the error rows', () => {
	const errors = Array.from({ length: 12 }, (_, i) => `Invalid email: row-${i + 1}@bad`);

	it('shows the first five on screen and counts the rest', () => {
		const { wrapper } = mountModal({ step: 'complete', results: { failed: 12, errors } });

		expect(wrapper.text()).toContain('Invalid email: row-5@bad');
		expect(wrapper.text()).not.toContain('Invalid email: row-6@bad');
		expect(wrapper.text()).toContain('...and 7 more');
	});

	it('downloads every failure, not just the five that were visible', async () => {
		const { wrapper } = mountModal({ step: 'complete', results: { failed: 12, errors } });

		await clickButton(wrapper, 'Download error rows');

		expect(downloads).toHaveLength(1);
		const csv = await downloads[0]!.blob.text();
		for (const message of errors) expect(csv).toContain(message);
		// Header + 12 rows, and the address is lifted into its own column.
		expect(csv.split('\n')).toHaveLength(13);
		expect(csv).toContain('row-12@bad');
		expect(downloads[0]!.filename).toBe('people-errors.csv');
	});

	it('offers no download when the import had no failures', () => {
		const { wrapper } = mountModal({ step: 'complete', results: { imported: 4 } });

		expect(wrapper.text()).not.toContain('Download error rows');
	});

	/** Spreadsheet formula injection: a message is untrusted text. */
	it('neutralizes a formula-shaped message', () => {
		const csv = buildImportErrorsCsv(['=cmd|/c calc']);

		expect(csv).toContain("'=cmd|/c calc");
	});
});

describe('CsvImportModal — where the import goes next', () => {
	const topics = [
		{ _id: 'topic-1', name: 'Newsletter' },
		{ _id: 'topic-2', name: 'Beta' },
	];

	it('opens the topic the rows landed in', async () => {
		const { wrapper, csvImport } = mountModal(
			{ step: 'complete', results: { imported: 2 }, globalTopicId: 'topic-1' },
			topics
		);

		await clickButton(wrapper, 'View imported');

		expect(navigate).toHaveBeenCalledWith('/dashboard/audience/topics/topic-1');
		expect(csvImport.isOpen.value).toBe(false);
	});

	it('says so, and opens the full list, when no topic was assigned', async () => {
		const { wrapper } = mountModal({ step: 'complete', results: { imported: 2 } }, topics);

		expect(wrapper.text()).toContain('was not assigned to a topic');

		await clickButton(wrapper, 'View imported');

		expect(navigate).toHaveBeenCalledWith('/dashboard/audience/contacts');
	});

	it('does not guess a destination when the CSV mapped several topics', () => {
		const { wrapper } = mountModal(
			{
				step: 'complete',
				results: { imported: 2 },
				columnTopicMapping: { Newsletter: 'topic-1', Beta: 'topic-2' },
			},
			topics
		);

		expect(wrapper.text()).toContain('was not assigned to a topic');
	});

	it('adds the imported contacts to a topic without leaving the modal', async () => {
		const { wrapper } = mountModal(
			{
				step: 'complete',
				results: { imported: 2 },
				rows: [
					['ada@example.com', 'Ada'],
					['grace@example.com', 'Grace'],
					['ADA@example.com', 'Ada again'],
				],
			},
			topics
		);

		await clickButton(wrapper, 'Add to topic');
		await wrapper.find('select').setValue('topic-2');
		await clickButton(wrapper, 'Add');
		await flushPromises();

		expect(runOperation).toHaveBeenCalledTimes(1);
		expect(runOperation).toHaveBeenCalledWith({
			// The rows carry addresses only — an existing contact must not be
			// rewritten by a topic assignment. The repeat address is sent once.
			contacts: [{ email: 'ada@example.com' }, { email: 'grace@example.com' }],
			handleDuplicates: 'skip',
			topicId: 'topic-2',
		});
		expect(toasts).toEqual(['2 contacts added to Beta']);
	});

	it('makes the topic it just assigned the view-imported destination', async () => {
		const { wrapper } = mountModal({ step: 'complete', results: { imported: 2 } }, topics);

		await clickButton(wrapper, 'Add to topic');
		await wrapper.find('select').setValue('topic-1');
		await clickButton(wrapper, 'Add');
		await flushPromises();

		await clickButton(wrapper, 'View imported');
		expect(navigate).toHaveBeenCalledWith('/dashboard/audience/topics/topic-1');
	});

	it('offers no topic assignment when the workspace has no topics', () => {
		const { wrapper } = mountModal({ step: 'complete', results: { imported: 2 } }, []);

		expect(wrapper.text()).not.toContain('Add to topic');
	});
});
