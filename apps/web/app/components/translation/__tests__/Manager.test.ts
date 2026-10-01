/**
 * Translation manager save path, mounted (issues #1000, #1001). A cell save
 * used to write the overlay, then reload and render, then write the whole
 * `htmlTranslations` blob through the editor `update` mutation, and cleared the
 * unsaved badge even when that second write failed. It is now ONE translation
 * write carrying the overlay, the language's HTML and the revision it was built
 * on, for both surfaces; a failed write keeps the typed text in its cell.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref, type Ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { getFunctionName } from 'convex/server';
import Manager from '../Manager.vue';
import TranslationCell from '../Cell.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { queryResult } from '~/__tests__/queryStubs';

type Row = Record<string, unknown>;

const runs = new Map<string, ReturnType<typeof vi.fn>>();
const run = (name: string) => runs.get(name)!;
let rows: { marketing: Ref<Row | undefined>; transactional: Ref<Row | undefined> };
// What the navigation guard was told: whether leaving asks first, and its save.
let leaveGuard: { onSave: () => Promise<void>; hasChanges: boolean };

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useRouter: () => ({ push: vi.fn() }),
		useToast: () => ({ showToast: vi.fn() }),
		useEmailTheme: () => ({ emailTheme: ref(undefined) }),
		useUnsavedChanges: (options: { onSave: () => Promise<void> }) => {
			leaveGuard = { onSave: options.onSave, hasChanges: false };
			return {
				showDialog: ref(false),
				isSavingBeforeLeave: ref(false),
				confirmDiscard: vi.fn(),
				confirmSave: vi.fn(),
				cancelNavigation: vi.fn(),
				setHasChanges: (value: boolean) => {
					leaveGuard.hasChanges = value;
				},
			};
		},
		requireConvex: () => ({ action: vi.fn() }),
		useConvexQuery: (fn: unknown, args: () => unknown) => {
			const name = getFunctionName(fn as never);
			const result = queryResult<Row | undefined>(undefined);
			if (args() === 'skip') return result;
			result.data = name.startsWith('emailTemplates') ? rows.marketing : rows.transactional;
			return result;
		},
		useBackendOperation: (fn: unknown) => {
			const name = getFunctionName(fn as never);
			if (!runs.has(name)) runs.set(name, vi.fn());
			return { run: (...args: unknown[]) => runs.get(name)!(...args) };
		},
	});
});

const CONTENT = JSON.stringify([{ id: 'b1', type: 'text', content: { html: 'Hello world' } }]);

const row = (revision: number, deBody = 'Hallo Welt'): Row => ({
	_id: 'row1',
	name: 'Welcome',
	subject: 'Hello',
	content: CONTENT,
	defaultLanguage: 'en',
	supportedLanguages: ['en', 'de'],
	translations: JSON.stringify({ de: { subject: 'Hallo', blocks: { b1: { html: deBody } } } }),
	htmlTranslations: JSON.stringify({ de: { htmlContent: '<p>Hallo Welt</p>', subject: 'Hallo' } }),
	contentRevision: revision,
});

beforeEach(() => {
	runs.clear();
	rows = { marketing: ref(row(4)), transactional: ref(row(4)) };
});

let wrapper: VueWrapper | null = null;
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

const flush = async () => {
	for (let i = 0; i < 6; i++) {
		await Promise.resolve();
		await nextTick();
	}
};

function mountManager(emailType: 'marketing' | 'transactional') {
	wrapper = mount(Manager, {
		props: { emailId: 'row1', emailType },
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			components: { TranslationCell },
			stubs: {
				UiSpinner: true,
				UiDropdownMenu: true,
				UiDropdownMenuItem: true,
				UiConfirmationDialog: true,
				UnsavedChangesDialog: true,
			},
		},
	});
	return wrapper;
}

const BODY_CELL = 'button[aria-label="Edit text block 1 (Deutsch)"]';

async function editBody(w: VueWrapper, text: string) {
	await w.get(BODY_CELL).trigger('click');
	await nextTick();
	await w.get('textarea').setValue(text);
	await w.get('textarea').trigger('keydown', { key: 'Enter', ctrlKey: true });
	await flush();
}

const SURFACES = [
	{
		emailType: 'marketing' as const,
		update: 'emailTemplates/i18n:updateTranslation',
		editorUpdate: 'emailTemplates/emails:update',
		idArg: { templateId: 'row1' },
	},
	{
		emailType: 'transactional' as const,
		update: 'transactional/translations:updateTranslation',
		editorUpdate: 'transactional/emails:update',
		idArg: { id: 'row1' },
	},
];

const REMOVE = {
	marketing: 'emailTemplates/i18n:removeTranslation',
	transactional: 'transactional/translations:removeTranslation',
};

describe.each(SURFACES)('$emailType translation table', (surface) => {
	it('forgets text left open in a removed language before leaving the page', async () => {
		const w = mountManager(surface.emailType);
		await flush();
		await w.get(BODY_CELL).trigger('click');
		await nextTick();
		await w.get('textarea').setValue('Halb getippt');
		await flush();
		expect(leaveGuard.hasChanges).toBe(true);

		run(REMOVE[surface.emailType]).mockResolvedValue({ ok: true, result: { contentRevision: 5 } });
		await w.get('button[title="Remove language"]').trigger('click');
		await flush();
		w.findComponent({ name: 'UiConfirmationDialog' }).vm.$emit('confirm');
		await flush();
		expect(run(REMOVE[surface.emailType])).toHaveBeenCalledOnce();
		expect(leaveGuard.hasChanges).toBe(false);

		// The row comes back without the language and its column goes away.
		rows[surface.emailType].value = {
			...row(5),
			supportedLanguages: ['en'],
			translations: '{}',
			htmlTranslations: '{}',
		};
		await flush();
		expect(w.find(BODY_CELL).exists()).toBe(false);
		expect(leaveGuard.hasChanges).toBe(false);

		// Saving on the way out has nothing to write for the removed language.
		await expect(leaveGuard.onSave()).resolves.toBeUndefined();
		expect(run(surface.update)).not.toHaveBeenCalled();
	});

	it('saves a cell as one write: overlay, rendered HTML and base revision together', async () => {
		const w = mountManager(surface.emailType);
		await flush();
		run(surface.update).mockResolvedValue({ ok: true, result: { contentRevision: 5 } });

		await editBody(w, 'Guten Tag');

		expect(run(surface.update)).toHaveBeenCalledOnce();
		const args = run(surface.update).mock.calls[0]![0] as Record<string, unknown>;
		expect(args).toMatchObject({
			...surface.idArg,
			language: 'de',
			subject: 'Hallo',
			expectedContentRevision: 4,
		});
		expect(JSON.parse(args['blocks'] as string)).toEqual({ b1: { html: 'Guten Tag' } });
		expect(args['htmlContent']).toEqual(expect.stringContaining('Guten Tag'));
		expect(args['htmlContent']).not.toEqual(expect.stringContaining('Hallo Welt'));
		if (surface.emailType === 'transactional') expect(args).not.toHaveProperty('previewText');
		// No second write patches the HTML in separately.
		expect(runs.get(surface.editorUpdate)).toBeUndefined();
	});

	it('keeps the typed text after a failed write, also across an unrelated emission', async () => {
		const w = mountManager(surface.emailType);
		await flush();
		run(surface.update).mockResolvedValue({ ok: false });

		await editBody(w, 'Guten Tag');

		expect(w.get(BODY_CELL).text()).toContain('Guten Tag');
		expect(w.get('[role="alert"]').text()).toBe('Not saved');
		expect(w.text()).toContain('Unsaved changes');

		// The live query re-emits for a write elsewhere on the row.
		rows[surface.emailType].value = { ...row(5), name: 'Renamed' };
		await flush();
		expect(w.get(BODY_CELL).text()).toContain('Guten Tag');
		expect(w.text()).toContain('Unsaved changes');

		// Retrying builds on the newer row and clears the draft once it lands.
		run(surface.update).mockResolvedValue({ ok: true, result: { contentRevision: 6 } });
		await w.get('button[aria-label="Save text block 1 (Deutsch) again"]').trigger('click');
		await flush();
		expect(run(surface.update).mock.calls[1]![0]).toMatchObject({ expectedContentRevision: 5 });
		rows[surface.emailType].value = row(6, 'Guten Tag');
		await flush();
		expect(w.find('[role="alert"]').exists()).toBe(false);
		expect(w.text()).not.toContain('Unsaved changes');
	});
});
