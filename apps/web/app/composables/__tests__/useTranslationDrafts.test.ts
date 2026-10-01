import { describe, it, expect, vi, afterEach } from 'vitest';
import { nextTick, ref } from 'vue';
import type { TranslationBase, TranslationFieldEdit } from '../translationSave';
import {
	useTranslationDrafts,
	type TranslationCell,
	type TranslationCommitResult,
} from '../useTranslationDrafts';

/**
 * Per-cell drafts of the translation table (issue #1001). Driven with real Vue
 * refs and a controllable backend port: each write the composable makes is
 * held until the test settles it, so overlapping saves, emissions during a
 * pending write and typing during an acknowledgement happen in a fixed order.
 */

const SUBJECT: TranslationCell = { language: 'de', rowId: '_subject', field: { kind: 'subject' } };
const BODY: TranslationCell = {
	language: 'de',
	rowId: 'b1',
	field: { kind: 'block', blockId: 'b1', property: 'html' },
};
const FR_SUBJECT: TranslationCell = { ...SUBJECT, language: 'fr' };

function row(revision: number, de: { subject?: string; body?: string } = {}): TranslationBase {
	return {
		content: '[]',
		subject: 'English',
		translations: {
			de: { subject: de.subject ?? 'Betreff', blocks: { b1: { html: de.body ?? 'Hallo' } } },
			fr: { subject: 'Sujet', blocks: {} },
		},
		revision,
	};
}

interface HeldWrite {
	base: TranslationBase;
	language: string;
	edits: readonly TranslationFieldEdit[];
	settle: (result: TranslationCommitResult) => void;
}

function setup(initial = row(1)) {
	const base = ref<TranslationBase | null>(initial);
	const writes: HeldWrite[] = [];
	const commit = vi.fn(
		(b: TranslationBase, language: string, edits: readonly TranslationFieldEdit[]) =>
			new Promise<TranslationCommitResult>((settle) => {
				writes.push({ base: b, language, edits, settle });
			})
	);
	const drafts = useTranslationDrafts({ base, commit, echoTimeoutMs: 1_000 });
	return { base, writes, commit, drafts };
}

/** Let queued writes and watchers run. */
const flush = async () => {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
		await nextTick();
	}
};

afterEach(() => {
	vi.useRealTimers();
});

describe('useTranslationDrafts', () => {
	it('keeps a failed draft while a later save of another cell succeeds', async () => {
		const { base, writes, drafts } = setup();

		const a = drafts.saveCell(SUBJECT, 'Neuer Betreff');
		const b = drafts.saveCell(BODY, 'Neuer Text');
		await flush();

		// One write at a time: A first, built on revision 1.
		expect(writes).toHaveLength(1);
		writes[0]!.settle({ ok: false });
		await a;
		await flush();

		// B runs after A failed, on the same row, carrying only its own cell.
		expect(writes).toHaveLength(2);
		expect(writes[1]!.base.revision).toBe(1);
		expect(writes[1]!.edits).toEqual([{ field: BODY.field, value: 'Neuer Text' }]);
		writes[1]!.settle({ ok: true, revision: 2 });
		await b;
		base.value = row(2, { body: 'Neuer Text' });
		await flush();

		expect(drafts.statusOf(SUBJECT)).toBe('failed');
		expect(drafts.valueOf(SUBJECT)).toBe('Neuer Betreff');
		expect(drafts.statusOf(BODY)).toBe('idle');
		expect(drafts.valueOf(BODY)).toBe('Neuer Text');
		expect(drafts.failedCount.value).toBe(1);
		expect(drafts.hasUnsavedWork.value).toBe(true);
	});

	it('keeps the draft through a server emission while its write is pending', async () => {
		const { base, writes, drafts } = setup();

		const saving = drafts.saveCell(SUBJECT, 'Mein Betreff');
		await flush();
		// A collaborator's write to another language lands meanwhile.
		base.value = {
			...row(2),
			translations: { ...row(2).translations, fr: { subject: 'Autre', blocks: {} } },
		};
		await flush();

		expect(drafts.valueOf(SUBJECT)).toBe('Mein Betreff');
		expect(drafts.statusOf(SUBJECT)).toBe('saving');
		expect(drafts.valueOf(FR_SUBJECT)).toBe('Autre');

		// Built on revision 1, the write is refused as stale: the draft stays.
		writes[0]!.settle({ ok: false });
		await saving;
		await flush();
		expect(drafts.valueOf(SUBJECT)).toBe('Mein Betreff');
		expect(drafts.statusOf(SUBJECT)).toBe('failed');

		// Retrying builds on the newer row.
		drafts.retry(SUBJECT);
		await flush();
		expect(writes[1]!.base.revision).toBe(2);
		expect(writes[1]!.edits).toEqual([{ field: SUBJECT.field, value: 'Mein Betreff' }]);
	});

	it('survives an unrelated emission after a failure, and flags a change to its own cell', async () => {
		const { base, writes, drafts } = setup();

		const saving = drafts.saveCell(SUBJECT, 'Mein Betreff');
		await flush();
		writes[0]!.settle({ ok: false });
		await saving;

		base.value = row(2, { body: 'Anderer Text' });
		await flush();
		expect(drafts.valueOf(SUBJECT)).toBe('Mein Betreff');
		expect(drafts.statusOf(SUBJECT)).toBe('failed');
		expect(drafts.valueOf(BODY)).toBe('Anderer Text');

		// Someone else changed the very value the draft was typed over.
		base.value = row(3, { subject: 'Fremder Betreff' });
		await flush();
		expect(drafts.valueOf(SUBJECT)).toBe('Mein Betreff');
		expect(drafts.statusOf(SUBJECT)).toBe('conflict');

		// Discarding takes the server's value.
		drafts.discard(SUBJECT);
		expect(drafts.valueOf(SUBJECT)).toBe('Fremder Betreff');
		expect(drafts.hasUnsavedWork.value).toBe(false);
	});

	it('keeps newer typing when an earlier write of the same cell is acknowledged', async () => {
		const { base, writes, drafts } = setup();

		const first = drafts.saveCell(SUBJECT, 'Erster');
		await flush();
		const second = drafts.saveCell(SUBJECT, 'Zweiter');
		writes[0]!.settle({ ok: true, revision: 2 });
		await first;
		await flush();

		// The acknowledgement of "Erster" does not clear "Zweiter".
		expect(drafts.valueOf(SUBJECT)).toBe('Zweiter');
		expect(drafts.statusOf(SUBJECT)).toBe('saving');

		// The second write waits for the row to show the first, then names it.
		expect(writes).toHaveLength(1);
		base.value = row(2, { subject: 'Erster' });
		await flush();
		expect(writes).toHaveLength(2);
		expect(writes[1]!.base.revision).toBe(2);
		writes[1]!.settle({ ok: true, revision: 3 });
		await second;
		await flush();

		// Shown until the server row has it, then the server value takes over.
		expect(drafts.valueOf(SUBJECT)).toBe('Zweiter');
		base.value = row(3, { subject: 'Zweiter' });
		await flush();
		expect(drafts.statusOf(SUBJECT)).toBe('idle');
		expect(drafts.hasUnsavedWork.value).toBe(false);
	});

	it('fails a write whose predecessor never shows up on the server', async () => {
		vi.useFakeTimers();
		const { writes, drafts } = setup();

		const first = drafts.saveCell(SUBJECT, 'Erster');
		await flush();
		writes[0]!.settle({ ok: true, revision: 2 });
		await first;
		const second = drafts.saveCell(BODY, 'Text');
		await flush();

		await vi.advanceTimersByTimeAsync(1_000);
		await second;
		expect(writes).toHaveLength(1);
		expect(drafts.statusOf(BODY)).toBe('failed');
		expect(drafts.valueOf(BODY)).toBe('Text');
	});

	it('counts open editor text as unsaved until it is saved', async () => {
		const { base, writes, drafts } = setup();

		drafts.setOpenEdit(SUBJECT, 'Betreff');
		expect(drafts.hasUnsavedWork.value).toBe(false);
		drafts.setOpenEdit(SUBJECT, 'Getippt');
		expect(drafts.hasUnsavedWork.value).toBe(true);

		// saveAll writes the open text and resolves once it landed.
		const all = drafts.saveAll();
		await flush();
		writes[0]!.settle({ ok: true, revision: 2 });
		base.value = row(2, { subject: 'Getippt' });
		await expect(all).resolves.toBe(true);
		expect(writes[0]!.edits).toEqual([{ field: SUBJECT.field, value: 'Getippt' }]);

		drafts.setOpenEdit(SUBJECT, null);
		expect(drafts.hasUnsavedWork.value).toBe(false);
	});

	it('forgets the open editor text and drafts of a removed language', async () => {
		const { base, writes, drafts } = setup();

		drafts.setOpenEdit(SUBJECT, 'Getippt');
		drafts.setOpenEdit(FR_SUBJECT, 'Tapé');
		const failed = drafts.saveCell(BODY, 'Neuer Text');
		await flush();
		writes[0]!.settle({ ok: false });
		await failed;
		expect(drafts.statusOf(BODY)).toBe('failed');

		// The language is removed; the server row no longer carries it.
		drafts.forgetLanguage('de');
		const { de: _removed, ...rest } = row(2).translations;
		base.value = { ...row(2), translations: rest };
		await flush();
		expect(drafts.statusOf(BODY)).toBe('idle');

		// Only the other language's open text is still unsaved, and only it is saved.
		expect(drafts.hasUnsavedWork.value).toBe(true);
		const all = drafts.saveAll();
		await flush();
		expect(writes).toHaveLength(2);
		expect(writes[1]!.language).toBe('fr');
		writes[1]!.settle({ ok: true, revision: 3 });
		base.value = { ...row(3), translations: { fr: { subject: 'Tapé', blocks: {} } } };
		await expect(all).resolves.toBe(true);
		expect(writes.map((write) => write.language)).toEqual(['de', 'fr']);

		drafts.setOpenEdit(FR_SUBJECT, null);
		expect(drafts.hasUnsavedWork.value).toBe(false);
	});

	it('saves generated values for one language as one write', async () => {
		const { writes, drafts } = setup();

		const saving = drafts.save('de', [
			{ cell: SUBJECT, value: 'KI-Betreff' },
			{ cell: BODY, value: 'KI-Text' },
		]);
		await flush();
		expect(writes).toHaveLength(1);
		expect(writes[0]!.edits).toEqual([
			{ field: SUBJECT.field, value: 'KI-Betreff' },
			{ field: BODY.field, value: 'KI-Text' },
		]);
		writes[0]!.settle({ ok: false });
		await expect(saving).resolves.toBe(false);
		expect(drafts.statusOf(SUBJECT)).toBe('failed');
		expect(drafts.statusOf(BODY)).toBe('failed');
	});

	it('treats a write that throws (e.g. a render failure) as not landed', async () => {
		const base = ref<TranslationBase | null>(row(1));
		const drafts = useTranslationDrafts({
			base,
			commit: () => Promise.reject(new Error('render failed')),
		});

		await expect(drafts.saveCell(SUBJECT, 'Neu')).resolves.toBe(false);
		expect(drafts.statusOf(SUBJECT)).toBe('failed');
		expect(drafts.valueOf(SUBJECT)).toBe('Neu');
	});
});
