import { computed, ref, watch, type Ref } from 'vue';
import {
	readOverlayField,
	type TranslationBase,
	type TranslationField,
	type TranslationFieldEdit,
} from './translationSave';

/**
 * Per-cell dirty tracking for the translation table.
 *
 * The table edits many small values that save one at a time, so the single
 * draft of `useEditorDirtyTracking` does not fit. The same three states are kept
 * apart, per cell:
 *
 *   - the SERVER BASELINE: the latest row the query emitted, which always
 *     refreshes what clean cells show;
 *   - a LOCAL DRAFT per edited cell, kept until its own write is acknowledged
 *     or the author discards it. An emission never overwrites one, and a failed
 *     write leaves it on screen to retry;
 *   - a SUBMISSION: the value frozen when the cell was saved. Writes run one at
 *     a time, each built on the server row at its turn and named by that row's
 *     revision; a write only clears the drafts it carried, and only while they
 *     still hold the value it wrote.
 *
 * Text still open in a cell editor is reported through `setOpenEdit`, so the
 * navigation guard sees it before it is committed.
 */

/** One table cell: a field of a language's overlay. */
export interface TranslationCell {
	language: string;
	/** The table row's id (`_subject`, `_previewText` or a block id). */
	rowId: string;
	field: TranslationField;
}

/** What a cell shows about its saving state. */
export type TranslationCellStatus = 'idle' | 'saving' | 'failed' | 'conflict';

/** The outcome of one write: the revision it stored, or that it did not land. */
export type TranslationCommitResult = { ok: true; revision: number } | { ok: false };

interface CellDraft {
	readonly cell: TranslationCell;
	readonly value: string;
	/** The server value the draft was typed over; a change to it is a conflict. */
	readonly baseValue: string;
	/** The submission carrying `value`. */
	readonly submission: number;
	/** `saved` waits for the server row to show the write, then goes away. */
	readonly status: 'pending' | 'failed' | 'saved';
	readonly landedRevision?: number;
}

export interface UseTranslationDraftsOptions {
	/** The latest server row, frozen into a base; null while it loads. */
	base: Ref<TranslationBase | null>;
	/** Write `edits` to `language` on `base`. Resolve `ok: false` when it did not land. */
	commit: (
		base: TranslationBase,
		language: string,
		edits: readonly TranslationFieldEdit[]
	) => Promise<TranslationCommitResult>;
	/**
	 * How long a write waits for the server row to show the previous write
	 * before it gives up as failed (it would otherwise be refused as stale).
	 */
	echoTimeoutMs?: number;
}

const cellKey = (cell: Pick<TranslationCell, 'language' | 'rowId'>) =>
	`${cell.language}:${cell.rowId}`;

export function useTranslationDrafts(opts: UseTranslationDraftsOptions) {
	const echoTimeoutMs = opts.echoTimeoutMs ?? 10_000;
	const drafts = ref<Record<string, CellDraft>>({});
	const openEdits = ref<Record<string, { cell: TranslationCell; text: string }>>({});
	let lastSubmission = 0;
	// The revision our last acknowledged write stored. The next write is built
	// only once the server row has reached it, so it names the right revision.
	let landedFloor = 0;
	let queue: Promise<unknown> = Promise.resolve();

	const serverValue = (cell: TranslationCell) =>
		readOverlayField(opts.base.value?.translations[cell.language], cell.field);

	const setDraft = (key: string, draft: CellDraft | null) => {
		const { [key]: _previous, ...others } = drafts.value;
		drafts.value = draft ? { ...others, [key]: draft } : others;
	};

	// A saved draft stays on screen until the row shows its write, so the cell
	// never flashes back to the old value in between.
	const pruneSaved = () => {
		const revision = opts.base.value?.revision ?? -1;
		for (const [key, draft] of Object.entries(drafts.value)) {
			if (draft.status === 'saved' && revision >= (draft.landedRevision ?? 0)) setDraft(key, null);
		}
	};
	watch(() => opts.base.value?.revision, pruneSaved);

	const waitForRevision = (revision: number): Promise<boolean> =>
		new Promise((resolve) => {
			if ((opts.base.value?.revision ?? -1) >= revision) return resolve(true);
			let stop: (() => void) | undefined;
			const timer = setTimeout(() => {
				stop?.();
				resolve(false);
			}, echoTimeoutMs);
			stop = watch(
				() => opts.base.value?.revision ?? -1,
				(current) => {
					if (current < revision) return;
					clearTimeout(timer);
					stop?.();
					resolve(true);
				}
			);
		});

	/**
	 * Run `write` after every earlier write, on the server row as it is then.
	 * A thrown error counts as a write that did not land.
	 */
	const runWrite = (
		write: (base: TranslationBase) => Promise<TranslationCommitResult>
	): Promise<TranslationCommitResult> => {
		const run = queue.then(async (): Promise<TranslationCommitResult> => {
			if (!(await waitForRevision(landedFloor))) return { ok: false };
			const base = opts.base.value;
			if (!base) return { ok: false };
			let result: TranslationCommitResult;
			try {
				result = await write(base);
			} catch {
				result = { ok: false };
			}
			if (result.ok) landedFloor = Math.max(landedFloor, result.revision);
			return result;
		});
		queue = run;
		return run;
	};

	/**
	 * Save new values for cells of ONE language as one write. Each cell's draft
	 * shows the value at once and is cleared only by this write's success.
	 */
	const save = async (
		language: string,
		entries: ReadonlyArray<{ cell: TranslationCell; value: string }>
	): Promise<boolean> => {
		const submission = ++lastSubmission;
		for (const { cell, value } of entries) {
			const key = cellKey(cell);
			const existing = drafts.value[key];
			setDraft(key, {
				cell,
				value,
				// An earlier unsaved draft of this cell was typed over the older
				// value; keep that, so a change made elsewhere still shows.
				baseValue: existing && existing.status !== 'saved' ? existing.baseValue : serverValue(cell),
				submission,
				status: 'pending',
			});
		}
		const carried = () =>
			entries.filter(({ cell }) => drafts.value[cellKey(cell)]?.submission === submission);

		const result = await runWrite(async (base) => {
			// Superseded (saved again, or discarded) before its turn: write the rest.
			const edits = carried().map(({ cell, value }) => ({ field: cell.field, value }));
			if (edits.length === 0) return { ok: true, revision: base.revision };
			return await opts.commit(base, language, edits);
		});

		// Only drafts still holding what this write carried change; a newer
		// value typed meanwhile stays a draft of its own.
		for (const { cell } of carried()) {
			const key = cellKey(cell);
			const draft = drafts.value[key]!;
			setDraft(
				key,
				result.ok
					? { ...draft, status: 'saved', landedRevision: result.revision }
					: { ...draft, status: 'failed' }
			);
		}
		pruneSaved();
		return result.ok;
	};

	const saveCell = (cell: TranslationCell, value: string) => save(cell.language, [{ cell, value }]);

	const valueOf = (cell: TranslationCell): string =>
		drafts.value[cellKey(cell)]?.value ?? serverValue(cell);

	const statusOf = (cell: TranslationCell): TranslationCellStatus => {
		const draft = drafts.value[cellKey(cell)];
		if (!draft || draft.status === 'saved') return 'idle';
		if (draft.status === 'pending') return 'saving';
		return serverValue(cell) === draft.baseValue ? 'failed' : 'conflict';
	};

	/** Save a failed draft again, on the latest server row. */
	const retry = (cell: TranslationCell) => {
		const draft = drafts.value[cellKey(cell)];
		if (draft?.status === 'failed') void saveCell(draft.cell, draft.value);
	};

	/** Drop a failed draft; the cell shows the server value again. */
	const discard = (cell: TranslationCell) => {
		if (drafts.value[cellKey(cell)]?.status === 'failed') setDraft(cellKey(cell), null);
	};

	/** Drop every draft of a language that no longer exists. */
	const forgetLanguage = (language: string) => {
		for (const [key, draft] of Object.entries(drafts.value)) {
			if (draft.cell.language === language) setDraft(key, null);
		}
	};

	/** Text open in a cell editor, or null once the editor closed. */
	const setOpenEdit = (cell: TranslationCell, text: string | null) => {
		const key = cellKey(cell);
		const { [key]: _previous, ...others } = openEdits.value;
		openEdits.value = text === null ? others : { ...others, [key]: { cell, text } };
	};

	const uncommittedEdits = computed(() =>
		Object.values(openEdits.value).filter(({ cell, text }) => text !== valueOf(cell))
	);
	const failedCount = computed(
		() => Object.values(drafts.value).filter((draft) => draft.status === 'failed').length
	);
	const isSaving = computed(() =>
		Object.values(drafts.value).some((draft) => draft.status === 'pending')
	);
	/** Work that leaving the page would lose. */
	const hasUnsavedWork = computed(
		() => isSaving.value || failedCount.value > 0 || uncommittedEdits.value.length > 0
	);

	/**
	 * Save everything still local (open editor text and failed drafts) and wait
	 * for every write. Resolves whether nothing is left unsaved.
	 */
	const saveAll = async (): Promise<boolean> => {
		for (const { cell, text } of uncommittedEdits.value) void saveCell(cell, text);
		for (const draft of Object.values(drafts.value)) {
			if (draft.status === 'failed') void saveCell(draft.cell, draft.value);
		}
		await queue;
		return !hasUnsavedWork.value;
	};

	return {
		valueOf,
		statusOf,
		saveCell,
		save,
		retry,
		discard,
		forgetLanguage,
		setOpenEdit,
		runWrite,
		saveAll,
		failedCount,
		isSaving,
		hasUnsavedWork,
	};
}
