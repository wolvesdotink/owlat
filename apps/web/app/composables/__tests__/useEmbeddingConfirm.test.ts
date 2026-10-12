/**
 * One held confirmation at a time: free work runs at once, paid or
 * irreversible work waits, runs on confirm, and the dialog closes only once
 * the work landed. A held confirmation is bound to its target: it lapses when
 * the live target moves or a blocker appears, and Confirm re-checks both
 * before it runs anything (Sol r6 F1).
 */
import { describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { useEmbeddingConfirm } from '../useEmbeddingConfirm';

const target = ref<string | null>('space-A');
const block = ref<string | null>(null);
const held = (run: () => Promise<boolean>) => ({
	title: 'T',
	body: 'B',
	confirmText: 'Go',
	targetKey: 'space-A',
	currentKey: () => target.value,
	blocker: () => block.value,
	run,
});

describe('useEmbeddingConfirm', () => {
	it('runs free work at once and holds nothing', async () => {
		const run = vi.fn(async () => true);
		const confirm = useEmbeddingConfirm();
		await confirm.ask(false, held(run));
		expect(run).toHaveBeenCalledTimes(1);
		expect(confirm.pending.value).toBeNull();
	});

	it('holds paid work until confirmed, and closes once it landed', async () => {
		const run = vi.fn(async () => true);
		const confirm = useEmbeddingConfirm();
		await confirm.ask(true, held(run));
		expect(run).not.toHaveBeenCalled();
		await confirm.confirm();
		expect(run).toHaveBeenCalledTimes(1);
		expect(confirm.pending.value).toBeNull();
	});

	it('stays open when the work was refused, and drops it when dismissed', async () => {
		const run = vi.fn(async () => false);
		const confirm = useEmbeddingConfirm();
		await confirm.ask(true, held(run));
		await confirm.confirm();
		expect(confirm.pending.value).not.toBeNull();
		confirm.dismiss(false);
		expect(confirm.pending.value).toBeNull();
		await confirm.confirm();
		expect(run).toHaveBeenCalledTimes(1);
	});

	it('drops a held dialog when its target is replaced, and never runs it', async () => {
		target.value = 'space-A';
		const run = vi.fn(async () => true);
		const confirm = useEmbeddingConfirm();
		await confirm.ask(true, held(run));
		target.value = 'space-B';
		await nextTick();
		expect(confirm.pending.value).toBeNull();
		await confirm.confirm();
		expect(run).not.toHaveBeenCalled();
	});

	it('re-checks target and blocker at Confirm, even before the watcher ran', async () => {
		target.value = 'space-A';
		block.value = null;
		const run = vi.fn(async () => true);
		const confirm = useEmbeddingConfirm();
		await confirm.ask(true, held(run));
		block.value = 'paid.unavailable';
		await confirm.confirm();
		expect(run).not.toHaveBeenCalled();
		block.value = null;
		await confirm.ask(true, held(run));
		target.value = null;
		await confirm.confirm();
		expect(run).not.toHaveBeenCalled();
		target.value = 'space-A';
	});

	it('does not even ask for a target that is already gone', async () => {
		target.value = 'space-B';
		const run = vi.fn(async () => true);
		const confirm = useEmbeddingConfirm();
		await confirm.ask(false, held(run));
		await confirm.ask(true, held(run));
		expect(run).not.toHaveBeenCalled();
		expect(confirm.pending.value).toBeNull();
		target.value = 'space-A';
	});
});
