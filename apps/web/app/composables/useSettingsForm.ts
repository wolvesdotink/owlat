import { computed, reactive, ref, toRaw, watch, type Ref } from 'vue';
import { useEditorDirtyTracking } from './useEditorDirtyTracking';

/**
 * One settings form over one stored row: load, draft, dirty, save and the
 * leave guard, for the admin settings pages.
 *
 * Built on `useEditorDirtyTracking`, so it keeps that loop's rule: a live
 * query re-emits for reasons that are not the operator's (another admin, another
 * settings page writing the same row, a backend job), and an emission may
 * replace the draft only while the draft holds nothing unsaved. The pages used
 * to re-seed on every emission, so a write anywhere on the shared row threw the
 * operator's edits away without a word.
 *
 * Dirty is decided by value against the row the draft was built on, so an edit
 * typed back to the stored value is clean again (and catches up with the
 * server). `dirtyKey` narrows what counts, for a form carrying a field that
 * means nothing in some states.
 */

/** A settings form is a flat record of plain values. */
export type SettingsFormShape = Record<string, unknown>;

export interface UseSettingsFormOptions<Row, F extends SettingsFormShape> {
	/**
	 * The stored settings. `undefined` means not loaded yet; anything else,
	 * `null` included (no row stored), is an answer and hydrates the form.
	 */
	source: Ref<Row | undefined>;
	/** The form before anything loaded, and what `resetToDefaults` restores. */
	defaults: F;
	/** The stored row as form values, with the defaults filled in. */
	project: (row: Row) => F;
	/**
	 * Write the draft. Gets a snapshot, so an edit made while the write is in
	 * flight does not leak into a multi-step save. Resolves whether it landed;
	 * failures are reported by the caller (the operation module toasts them).
	 */
	save: (draft: F) => Promise<boolean>;
	/** Checked before a save starts; return false to refuse it. */
	validate?: (form: F) => boolean;
	/** What counts as a change. Defaults to the whole form. */
	dirtyKey?: (form: F) => unknown;
}

/** The leave guard, ready to bind to `UnsavedChangesDialog`. */
export interface SettingsUnsavedDialog {
	showDialog: boolean;
	cancelNavigation: () => void;
	confirmDiscard: () => void;
	confirmSave: () => Promise<void>;
}

export interface UseSettingsFormReturn<F extends SettingsFormShape> {
	/** The draft. Bind the controls to it. */
	form: F;
	isDirty: Readonly<Ref<boolean>>;
	isSaving: Readonly<Ref<boolean>>;
	/** Validate, then save. Resolves whether the save landed. */
	handleSave: () => Promise<boolean>;
	/** Throw the draft away and show the stored settings. */
	reset: () => void;
	/** Put the defaults in the draft (dirty until saved, unless already stored). */
	resetToDefaults: () => void;
	unsavedDialog: SettingsUnsavedDialog;
}

/** Every emission is the same settings row: only a changed row, never a new one. */
const SETTINGS_IDENTITY = 'settings';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function useSettingsForm<Row, F extends SettingsFormShape>(
	opts: UseSettingsFormOptions<Row, F>
): UseSettingsFormReturn<F> {
	const form = reactive(clone(opts.defaults)) as F;
	const keyOf = (value: F) => JSON.stringify(opts.dirtyKey ? opts.dirtyKey(value) : value);

	// The key of the row the draft is built on: the hydrated row's, then the
	// submitted draft's once a save of it lands.
	const baseKey = ref(keyOf(form));
	let hydrations = 0;
	const isSaving = ref(false);

	const loaded = computed(() =>
		opts.source.value === undefined ? undefined : { row: opts.source.value }
	);

	// Dirty by value against the row the draft is built on. Declared before the
	// tracker reads it: an emission is held back while it is true, so the
	// protection does not depend on the tracker having seen the edit happen.
	const isDirty = computed(() => keyOf(form) !== baseKey.value);

	const tracker = useEditorDirtyTracking({
		source: loaded,
		identity: () => SETTINGS_IDENTITY,
		initialize: ({ row }) => {
			Object.assign(form, opts.project(row as Row));
			baseKey.value = keyOf(form);
			hydrations += 1;
		},
		watchSources: [() => keyOf(form)],
		holdHydration: () => isDirty.value,
	});

	// Edited back to what is stored: nothing unsaved, so follow the server again
	// (and take any emission held back meanwhile).
	watch(
		() => tracker.hasChanges.value && !isSaving.value && !isDirty.value,
		(reverted) => {
			if (reverted) tracker.markClean();
		}
	);

	const handleSave = async (): Promise<boolean> => {
		if (isSaving.value) return false;
		if (opts.validate && !opts.validate(form)) return false;
		const submission = tracker.beginSubmit();
		const draft = clone(toRaw(form)) as F;
		const submittedKey = keyOf(draft);
		const generation = hydrations;
		isSaving.value = true;
		try {
			if (!(await opts.save(draft))) return false;
			// The server now holds the submitted draft, unless a hydration took
			// over while the write was in flight.
			if (hydrations === generation) baseKey.value = submittedKey;
			tracker.acknowledge(submission);
			return true;
		} finally {
			isSaving.value = false;
		}
	};

	const resetToDefaults = () => {
		Object.assign(form, clone(opts.defaults));
	};

	// The leave guard. `onSave` throws on a failed save, so the guard keeps the
	// operator (and the edits) on the page instead of leaving for the route.
	const guard = useUnsavedChanges({
		onSave: async () => {
			if (!(await handleSave())) throw new Error('Save failed');
		},
	});
	watch(isDirty, (dirty) => guard.setHasChanges(dirty), { immediate: true });

	const unsavedDialog = reactive({
		showDialog: guard.showDialog,
		cancelNavigation: guard.cancelNavigation,
		confirmDiscard: guard.confirmDiscard,
		confirmSave: guard.confirmSave,
	}) as SettingsUnsavedDialog;

	return {
		form,
		isDirty,
		isSaving,
		handleSave,
		reset: tracker.reload,
		resetToDefaults,
		unsavedDialog,
	};
}
