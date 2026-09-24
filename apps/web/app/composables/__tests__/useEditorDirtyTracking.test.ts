import { describe, it, expect, vi } from 'vitest';
import { ref, nextTick } from 'vue';
import { useEditorDirtyTracking } from '../useEditorDirtyTracking';

/** Flush the source watcher, then the deferred end-of-hydration tick. */
async function settle() {
	await nextTick();
	await nextTick();
}

interface Row {
	_id: string;
	name: string;
	contentRevision?: number;
	sendCount?: number;
}

/** An editor over one `name` field, revision-tracked like the email editors. */
function setupEditor(initial: Row | null) {
	const source = ref<Row | null>(initial);
	const name = ref('');
	const initialize = vi.fn((row: Row) => {
		name.value = row.name;
	});
	const tracker = useEditorDirtyTracking({
		source,
		initialize,
		watchSources: [() => name.value],
		revision: (row) => row.contentRevision ?? 0,
	});
	return { source, name, initialize, ...tracker };
}

describe('useEditorDirtyTracking', () => {
	it('stays clean through initialize, flips dirty on a tracked edit, resets on markClean', async () => {
		const source = ref<{ name: string } | null>(null);
		const name = ref('');
		const blocks = ref<unknown[]>([]);
		const onDirtyChange = vi.fn();

		const { hasChanges, markClean, isInitialized } = useEditorDirtyTracking({
			source,
			initialize: (s) => {
				name.value = s.name;
				blocks.value = [{ id: '1' }];
			},
			watchSources: [() => name.value, () => blocks.value],
			onDirtyChange,
		});

		expect(hasChanges.value).toBe(false);
		expect(isInitialized.value).toBe(false);

		// Data loads → initialize runs, but the editor must not be marked dirty.
		source.value = { name: 'Loaded' };
		await settle();

		expect(name.value).toBe('Loaded');
		expect(isInitialized.value).toBe(true);
		expect(hasChanges.value).toBe(false);

		// A real edit flips dirty.
		name.value = 'Edited';
		await nextTick();
		expect(hasChanges.value).toBe(true);
		expect(onDirtyChange).toHaveBeenLastCalledWith(true);

		// A save resets it.
		markClean();
		expect(hasChanges.value).toBe(false);
		expect(onDirtyChange).toHaveBeenLastCalledWith(false);
	});

	it('treats extraWatch-style sources (e.g. attachments) as dirty-tracked', async () => {
		const source = ref<{ name: string } | null>({ name: 'X' });
		const attachments = ref<string[]>([]);

		const { hasChanges } = useEditorDirtyTracking({
			source,
			initialize: () => {},
			watchSources: [() => attachments.value],
		});

		await settle();
		expect(hasChanges.value).toBe(false);

		attachments.value = [...attachments.value, 'invoice.pdf'];
		await nextTick();
		expect(hasChanges.value).toBe(true);
	});

	it('keeps a dirty draft when a collaborator update arrives', async () => {
		const editor = setupEditor({ _id: 't1', name: 'Original', contentRevision: 3 });
		await settle();

		editor.name.value = 'My unsaved edit';
		await nextTick();
		expect(editor.hasChanges.value).toBe(true);

		editor.source.value = { _id: 't1', name: 'Their edit', contentRevision: 4 };
		await settle();

		expect(editor.name.value).toBe('My unsaved edit');
		expect(editor.hasChanges.value).toBe(true);
		expect(editor.initialize).toHaveBeenCalledTimes(1);
		// The next save still names the revision the draft was built on, so the
		// backend refuses it instead of overwriting the collaborator.
		expect(editor.beginSubmit().revision).toBe(3);
	});

	it('advances the base on a same-revision emission without touching the draft', async () => {
		const editor = setupEditor({ _id: 't1', name: 'Original', contentRevision: 3 });
		await settle();
		editor.name.value = 'My unsaved edit';
		await nextTick();

		// e.g. a send counter: the editor-owned fields did not move.
		const bumped = { _id: 't1', name: 'Original', contentRevision: 3, sendCount: 9 };
		editor.source.value = bumped;
		await settle();

		expect(editor.name.value).toBe('My unsaved edit');
		expect(editor.hasChanges.value).toBe(true);
		expect(editor.beginSubmit().base).toEqual(bumped);
	});

	it('follows server updates while the draft is clean, without marking it dirty', async () => {
		const editor = setupEditor({ _id: 't1', name: 'Original', contentRevision: 3 });
		await settle();

		editor.source.value = { _id: 't1', name: 'Their edit', contentRevision: 4 };
		await settle();

		expect(editor.name.value).toBe('Their edit');
		expect(editor.hasChanges.value).toBe(false);
		expect(editor.beginSubmit().revision).toBe(4);
	});

	it('does not clear dirty on emissions when initialize guards itself (campaign form)', async () => {
		const source = ref<{ _id: string; name: string } | null>({ _id: 'c1', name: 'Launch' });
		const name = ref('');
		let initialized = false;
		const { hasChanges } = useEditorDirtyTracking({
			source,
			initialize: (row) => {
				if (initialized) return;
				name.value = row.name;
				initialized = true;
			},
			watchSources: [() => name.value],
		});
		await settle();

		name.value = 'Launch v2';
		await nextTick();
		source.value = { _id: 'c1', name: 'Launch' };
		await settle();

		expect(hasChanges.value).toBe(true);
	});

	it('becomes clean on the save echo without clobbering the draft', async () => {
		const editor = setupEditor({ _id: 't1', name: 'Original', contentRevision: 3 });
		await settle();
		editor.name.value = 'Saved text';
		await nextTick();

		const submission = editor.beginSubmit();
		expect(submission.revision).toBe(3);

		// The mutation's own write echoes back before it resolves.
		const echo = { _id: 't1', name: 'Saved text', contentRevision: 4 };
		editor.source.value = echo;
		await settle();
		expect(editor.name.value).toBe('Saved text');

		editor.acknowledge(submission);
		await settle();

		expect(editor.hasChanges.value).toBe(false);
		expect(editor.name.value).toBe('Saved text');
		expect(editor.beginSubmit()).toMatchObject({ base: echo, revision: 4 });
	});

	it('stays dirty when the user edits while the save is in flight', async () => {
		const editor = setupEditor({ _id: 't1', name: 'Original', contentRevision: 3 });
		await settle();
		editor.name.value = 'First';
		await nextTick();

		const submission = editor.beginSubmit();
		editor.name.value = 'First, then more';
		await nextTick();
		editor.source.value = { _id: 't1', name: 'First', contentRevision: 4 };
		await settle();

		editor.acknowledge(submission);
		await settle();

		expect(editor.hasChanges.value).toBe(true);
		expect(editor.name.value).toBe('First, then more');
		// The in-flight write is now the draft's base: the follow-up save must
		// not be refused as stale because of the user's own previous save.
		expect(editor.beginSubmit().revision).toBe(4);
	});

	it('uses the acknowledged revision even when the echo arrives after the save resolves', async () => {
		const editor = setupEditor({ _id: 't1', name: 'Original', contentRevision: 3 });
		await settle();
		editor.name.value = 'First';
		await nextTick();

		const submission = editor.beginSubmit();
		editor.name.value = 'First, then more';
		await nextTick();
		editor.acknowledge(submission);

		expect(editor.hasChanges.value).toBe(true);
		expect(editor.beginSubmit().revision).toBe(4);

		const echo = { _id: 't1', name: 'First', contentRevision: 4 };
		editor.source.value = echo;
		await settle();
		expect(editor.name.value).toBe('First, then more');
		expect(editor.beginSubmit().base).toEqual(echo);
	});

	it('re-hydrates on navigation to another entity, even over a dirty draft', async () => {
		const editor = setupEditor({ _id: 't1', name: 'First template', contentRevision: 3 });
		await settle();
		editor.name.value = 'Unsaved edit to t1';
		await nextTick();

		editor.source.value = { _id: 't2', name: 'Second template', contentRevision: 7 };
		await settle();

		expect(editor.name.value).toBe('Second template');
		expect(editor.hasChanges.value).toBe(false);
		expect(editor.beginSubmit().revision).toBe(7);

		// Editing the new entity is tracked as usual.
		editor.name.value = 'Edit to t2';
		await nextTick();
		expect(editor.hasChanges.value).toBe(true);
	});

	it('ignores the acknowledgement of a save that a navigation overtook', async () => {
		const editor = setupEditor({ _id: 't1', name: 'First', contentRevision: 3 });
		await settle();
		editor.name.value = 'Edit to t1';
		await nextTick();
		const submission = editor.beginSubmit();

		editor.source.value = { _id: 't2', name: 'Second', contentRevision: 7 };
		await settle();
		editor.name.value = 'Edit to t2';
		await nextTick();

		editor.acknowledge(submission);
		expect(editor.hasChanges.value).toBe(true);
		expect(editor.beginSubmit().revision).toBe(7);
	});

	it('catches up on markClean with the emission skipped while dirty', async () => {
		const editor = setupEditor({ _id: 't1', name: 'Original', contentRevision: 3 });
		await settle();
		editor.name.value = 'Edit';
		await nextTick();

		// e.g. the settings page's language swap re-keys the row server-side.
		editor.source.value = { _id: 't1', name: 'Re-keyed by the server', contentRevision: 4 };
		await settle();
		expect(editor.name.value).toBe('Edit');

		editor.markClean();
		await settle();
		expect(editor.name.value).toBe('Re-keyed by the server');
		expect(editor.hasChanges.value).toBe(false);
	});

	it('builds on the revision the server says it stored, not on expected + 1', async () => {
		// The update mutation reports the revision it stored; the tracker takes
		// that instead of inferring where the write landed.
		const editor = setupEditor({ _id: 't1', name: 'Original', contentRevision: 3 });
		await settle();
		editor.name.value = 'First';
		await nextTick();

		const submission = editor.beginSubmit();
		editor.name.value = 'First, then more';
		await nextTick();
		editor.acknowledge(submission, 9);

		expect(editor.beginSubmit().revision).toBe(9);
	});

	it('does not hydrate a row older than the write it just acknowledged', async () => {
		const editor = setupEditor({ _id: 't1', name: 'Original', contentRevision: 3, sendCount: 0 });
		await settle();
		editor.name.value = 'Saved text';
		await nextTick();
		const submission = editor.beginSubmit();

		// A bookkeeping write at the old revision arrives while the save runs.
		editor.source.value = { _id: 't1', name: 'Original', contentRevision: 3, sendCount: 1 };
		await settle();
		editor.acknowledge(submission, 4);
		await settle();

		expect(editor.hasChanges.value).toBe(false);
		expect(editor.name.value).toBe('Saved text');
		expect(editor.initialize).toHaveBeenCalledOnce();

		// The echo of the write then hydrates as usual.
		editor.source.value = { _id: 't1', name: 'Saved text', contentRevision: 4, sendCount: 1 };
		await settle();
		expect(editor.initialize).toHaveBeenCalledTimes(2);
		expect(editor.beginSubmit().revision).toBe(4);
	});

	it('reports every hydration to onHydrate, after initialize', async () => {
		const source = ref<Row | null>({ _id: 't1', name: 'First', contentRevision: 1 });
		const name = ref('');
		const seen: string[] = [];
		useEditorDirtyTracking({
			source,
			initialize: (row) => {
				name.value = row.name;
			},
			onHydrate: () => seen.push(name.value),
			watchSources: [() => name.value],
			revision: (row) => row.contentRevision ?? 0,
		});
		await settle();
		source.value = { _id: 't1', name: 'Collaborator', contentRevision: 2 };
		await settle();

		expect(seen).toEqual(['First', 'Collaborator']);
	});

	it('rebase keeps the draft and builds it on the latest row', async () => {
		const editor = setupEditor({ _id: 't1', name: 'Original', contentRevision: 3 });
		await settle();
		editor.name.value = 'Mine';
		await nextTick();
		const theirs = { _id: 't1', name: 'Theirs', contentRevision: 5 };
		editor.source.value = theirs;
		await settle();
		expect(editor.beginSubmit().revision).toBe(3);

		editor.rebase();

		expect(editor.name.value).toBe('Mine');
		expect(editor.hasChanges.value).toBe(true);
		expect(editor.beginSubmit()).toMatchObject({ base: theirs, revision: 5 });
	});

	it('reload drops the draft for the latest row', async () => {
		const editor = setupEditor({ _id: 't1', name: 'Original', contentRevision: 3 });
		await settle();
		editor.name.value = 'Mine';
		await nextTick();
		editor.source.value = { _id: 't1', name: 'Theirs', contentRevision: 5 };
		await settle();

		editor.reload();
		await settle();

		expect(editor.name.value).toBe('Theirs');
		expect(editor.hasChanges.value).toBe(false);
		expect(editor.beginSubmit().revision).toBe(5);
	});

	it('holds hydration while work is outside the draft, then catches up if none was committed', async () => {
		const source = ref<Row | null>({ _id: 't1', name: 'Loaded', contentRevision: 1 });
		const name = ref('');
		const inlineOpen = ref(false);
		const tracker = useEditorDirtyTracking({
			source,
			initialize: (row) => {
				name.value = row.name;
			},
			watchSources: [() => name.value],
			revision: (row) => row.contentRevision ?? 0,
			holdHydration: () => inlineOpen.value,
		});
		await settle();

		inlineOpen.value = true;
		source.value = { _id: 't1', name: 'Theirs', contentRevision: 2 };
		await settle();
		expect(name.value).toBe('Loaded');
		expect(tracker.beginSubmit().revision).toBe(1);

		inlineOpen.value = false;
		await settle();
		expect(name.value).toBe('Theirs');
		expect(tracker.hasChanges.value).toBe(false);
		expect(tracker.beginSubmit().revision).toBe(2);
	});

	it('keeps the old base when work held outside the draft is committed on release', async () => {
		const source = ref<Row | null>({ _id: 't1', name: 'Loaded', contentRevision: 1 });
		const name = ref('');
		const inlineOpen = ref(true);
		const tracker = useEditorDirtyTracking({
			source,
			initialize: (row) => {
				name.value = row.name;
			},
			watchSources: [() => name.value],
			revision: (row) => row.contentRevision ?? 0,
			holdHydration: () => inlineOpen.value,
		});
		await settle();
		source.value = { _id: 't1', name: 'Theirs', contentRevision: 2 };
		await settle();

		// Closing commits the typed text in the same tick.
		name.value = 'Loaded + typed';
		inlineOpen.value = false;
		await settle();

		expect(name.value).toBe('Loaded + typed');
		expect(tracker.hasChanges.value).toBe(true);
		expect(tracker.beginSubmit().revision).toBe(1);
	});
});
