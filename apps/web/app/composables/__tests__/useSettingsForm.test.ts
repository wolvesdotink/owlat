import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { withSetup } from '~/__tests__/withSetup';

// The real leave guard runs, so what the settings form feeds it is what gets
// checked. Its router half is captured rather than mounted.
const h = vi.hoisted(() => ({
	guard: null as null | ((to: unknown, from: unknown, next: (v?: unknown) => void) => void),
	push: vi.fn(),
}));

vi.mock('vue-router', () => ({
	onBeforeRouteLeave: (cb: (typeof h)['guard']) => {
		h.guard = cb;
	},
	useRouter: () => ({ push: h.push }),
}));

import { useUnsavedChanges } from '../useUnsavedChanges';
import { useSettingsForm } from '../useSettingsForm';

interface Row {
	timezone?: string;
	fromName?: string;
	/** A field of the shared row this form does not own. */
	sealPolicy?: string;
}

const DEFAULTS = { timezone: 'UTC', fromName: '' };

/** Flush the source watcher, then the tracker's end-of-hydration tick. */
async function settle() {
	await nextTick();
	await nextTick();
}

function setup(initial: Row | null | undefined, save = vi.fn(async () => true)) {
	const source = ref<Row | null | undefined>(initial);
	const settings = withSetup(() =>
		useSettingsForm({
			source,
			defaults: DEFAULTS,
			project: (row) => ({
				timezone: row?.timezone || DEFAULTS.timezone,
				fromName: row?.fromName || DEFAULTS.fromName,
			}),
			save,
		})
	).result;
	return { source, save, ...settings };
}

beforeEach(() => {
	h.guard = null;
	h.push.mockClear();
	vi.stubGlobal('useUnsavedChanges', useUnsavedChanges);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('useSettingsForm', () => {
	it('hydrates from the stored row, and from the defaults when none is stored', async () => {
		const stored = setup({ timezone: 'Europe/Berlin', fromName: 'Owlat' });
		await settle();
		expect(stored.form).toEqual({ timezone: 'Europe/Berlin', fromName: 'Owlat' });
		expect(stored.isDirty.value).toBe(false);

		const empty = setup(null);
		await settle();
		expect(empty.form).toEqual(DEFAULTS);
		expect(empty.isDirty.value).toBe(false);
	});

	it('keeps an unsaved draft when the row re-emits', async () => {
		const { source, form, isDirty } = setup({ timezone: 'UTC', fromName: 'Owlat' });
		await settle();

		form.fromName = 'Owlat Team';
		await settle();
		expect(isDirty.value).toBe(true);

		// Another page writes a field of the same row this form does not own.
		source.value = { timezone: 'Europe/Paris', fromName: 'Owlat', sealPolicy: 'ask' };
		await settle();

		expect(form.fromName).toBe('Owlat Team');
		expect(form.timezone).toBe('UTC');
		expect(isDirty.value).toBe(true);
	});

	it('follows the server while the draft is clean', async () => {
		const { source, form, isDirty } = setup({ timezone: 'UTC', fromName: 'Owlat' });
		await settle();

		source.value = { timezone: 'Europe/Paris', fromName: 'Owlat' };
		await settle();

		expect(form.timezone).toBe('Europe/Paris');
		expect(isDirty.value).toBe(false);
	});

	it('is clean again once an edit is typed back, and catches up with the server', async () => {
		const { source, form, isDirty } = setup({ timezone: 'UTC', fromName: 'Owlat' });
		await settle();

		form.fromName = 'Owlat Team';
		await settle();
		source.value = { timezone: 'Europe/Paris', fromName: 'Owlat' };
		await settle();
		expect(form.timezone).toBe('UTC');

		form.fromName = 'Owlat';
		await settle();

		expect(isDirty.value).toBe(false);
		expect(form.timezone).toBe('Europe/Paris');
	});

	it('saves a snapshot of the draft, then is clean against what it wrote', async () => {
		const { form, isDirty, handleSave, save } = setup({ timezone: 'UTC', fromName: 'Owlat' });
		await settle();

		form.fromName = 'Owlat Team';
		await settle();
		await expect(handleSave()).resolves.toBe(true);
		await settle();

		expect(save).toHaveBeenCalledWith({ timezone: 'UTC', fromName: 'Owlat Team' });
		expect(isDirty.value).toBe(false);
		// The echo of our own write arrives later and changes nothing on screen.
		expect(form.fromName).toBe('Owlat Team');
	});

	it('keeps the form dirty when the save fails, and the leave guard stays on the page', async () => {
		const save = vi.fn(async () => false);
		const { form, isDirty, handleSave, unsavedDialog } = setup(
			{ timezone: 'UTC', fromName: 'Owlat' },
			save
		);
		await settle();

		form.fromName = 'Owlat Team';
		await settle();
		await expect(handleSave()).resolves.toBe(false);
		await settle();
		expect(isDirty.value).toBe(true);

		// Leaving is blocked, and "Save" in the dialog throws rather than leaving.
		const next = vi.fn();
		h.guard?.({ fullPath: '/elsewhere' }, {}, next);
		expect(next).toHaveBeenCalledWith(false);
		expect(unsavedDialog.showDialog).toBe(true);

		await expect(unsavedDialog.confirmSave()).rejects.toThrow('Save failed');
		expect(h.push).not.toHaveBeenCalled();
		expect(form.fromName).toBe('Owlat Team');
	});

	it('refuses to save when validation fails', async () => {
		const source = ref<Row | null | undefined>({ timezone: 'UTC' });
		const save = vi.fn(async () => true);
		const { form, handleSave } = withSetup(() =>
			useSettingsForm({
				source,
				defaults: DEFAULTS,
				project: (row) => ({ timezone: row?.timezone || 'UTC', fromName: row?.fromName || '' }),
				save,
				validate: (draft) => draft.fromName.trim() !== '',
			})
		).result;
		await settle();

		form.timezone = 'Europe/Berlin';
		await settle();
		await expect(handleSave()).resolves.toBe(false);
		expect(save).not.toHaveBeenCalled();
	});

	it('resetToDefaults puts the defaults in the draft and marks it dirty', async () => {
		const { form, isDirty, resetToDefaults } = setup({
			timezone: 'Europe/Berlin',
			fromName: 'Owlat',
		});
		await settle();

		resetToDefaults();
		await settle();

		expect(form).toEqual(DEFAULTS);
		expect(isDirty.value).toBe(true);
	});

	it('reset throws the draft away', async () => {
		const { form, isDirty, reset } = setup({ timezone: 'UTC', fromName: 'Owlat' });
		await settle();

		form.fromName = 'Owlat Team';
		await settle();
		reset();
		await settle();

		expect(form.fromName).toBe('Owlat');
		expect(isDirty.value).toBe(false);
	});

	it('ignores changes outside dirtyKey', async () => {
		const source = ref<{ mode: string; pin?: string } | undefined>({ mode: 'latest' });
		const { form, isDirty } = withSetup(() =>
			useSettingsForm({
				source,
				defaults: { mode: 'latest', pin: '' },
				project: (row) => ({ mode: row?.mode ?? 'latest', pin: row?.pin ?? '' }),
				save: async () => true,
				dirtyKey: (draft) => ({ mode: draft.mode, pin: draft.mode === 'pinned' ? draft.pin : '' }),
			})
		).result;
		await settle();

		form.pin = '1.2.3';
		await settle();
		expect(isDirty.value).toBe(false);

		form.mode = 'pinned';
		await settle();
		expect(isDirty.value).toBe(true);
	});

	it('waits for the first answer before hydrating', async () => {
		const { source, form, isDirty } = setup(undefined);
		await settle();
		expect(form).toEqual(DEFAULTS);

		source.value = { timezone: 'Europe/Berlin' };
		await settle();
		expect(form.timezone).toBe('Europe/Berlin');
		expect(isDirty.value).toBe(false);
	});
});
