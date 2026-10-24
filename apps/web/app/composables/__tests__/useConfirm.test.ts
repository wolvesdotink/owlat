/**
 * `useConfirm()`: one promise-returning question, answered by the one host.
 *
 * The store is what keeps a destructive action honest, so its rules are pinned
 * here without a DOM: only the confirm button says yes, each question is
 * answered once, two callers queue rather than overwrite each other, a caller
 * that goes away withdraws its question, and losing the host answers no
 * instead of leaving anyone waiting.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { effectScope } from 'vue';
import {
	pendingConfirms,
	registerConfirmHost,
	respondToConfirm,
	useConfirm,
} from '~/composables/useConfirm';

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()!();
});

function host() {
	const unregister = registerConfirmHost();
	cleanups.push(unregister);
	return unregister;
}

/** A caller with its own scope, the way a component's setup has one. */
function caller() {
	const scope = effectScope();
	const confirm = scope.run(() => useConfirm())!;
	cleanups.push(() => scope.stop());
	return { confirm, dispose: () => scope.stop() };
}

/** Whether a promise has settled yet, without waiting on any clock. */
async function settled<T>(promise: Promise<T>): Promise<{ done: boolean; value?: T }> {
	const marker = Symbol('pending');
	const value = await Promise.race([promise, Promise.resolve(marker)]);
	return value === marker ? { done: false } : { done: true, value: value as T };
}

const head = () => pendingConfirms.value[0]!;

describe('useConfirm', () => {
	it('resolves true only once the host answers yes', async () => {
		host();
		const { confirm } = caller();
		const answer = confirm({ title: 'Delete forever?', body: 'This cannot be undone.' });

		expect(await settled(answer)).toEqual({ done: false });
		expect(head()).toMatchObject({ title: 'Delete forever?', body: 'This cannot be undone.' });

		respondToConfirm(head().id, true);
		await expect(answer).resolves.toBe(true);
		expect(pendingConfirms.value).toEqual([]);
	});

	it('resolves false when the host answers no', async () => {
		host();
		const answer = caller().confirm({ title: 'Unsubscribe?' });
		respondToConfirm(head().id, false);
		await expect(answer).resolves.toBe(false);
	});

	it('answers each question once and ignores a late or stale response', async () => {
		host();
		const first = caller().confirm({ title: 'First?' });
		const second = caller().confirm({ title: 'Second?' });
		const firstId = head().id;

		respondToConfirm(firstId, true);
		// A repeated click on the closing dialog must not answer the next question.
		respondToConfirm(firstId, false);
		await expect(first).resolves.toBe(true);
		expect(head().title).toBe('Second?');
		expect(await settled(second)).toEqual({ done: false });
	});

	it('queues questions from different callers oldest first', async () => {
		host();
		const first = caller().confirm({ title: 'First?' });
		const second = caller().confirm({ title: 'Second?' });
		expect(pendingConfirms.value.map((request) => request.title)).toEqual(['First?', 'Second?']);

		// Only the question on screen can be answered.
		const secondId = pendingConfirms.value[1]!.id;
		respondToConfirm(secondId, true);
		expect(pendingConfirms.value).toHaveLength(2);

		respondToConfirm(head().id, false);
		respondToConfirm(head().id, true);
		await expect(Promise.all([first, second])).resolves.toEqual([false, true]);
	});

	it('answers a second question from the same caller no while the first is open', async () => {
		host();
		const { confirm } = caller();
		const first = confirm({ title: 'Delete forever?' });
		const repeat = confirm({ title: 'Delete forever?' });

		await expect(repeat).resolves.toBe(false);
		expect(pendingConfirms.value).toHaveLength(1);
		respondToConfirm(head().id, true);
		await expect(first).resolves.toBe(true);
	});

	it('withdraws a caller’s open questions when its scope is disposed', async () => {
		host();
		const leaving = caller();
		const staying = caller();
		const withdrawn = leaving.confirm({ title: 'Reset?' });
		const kept = staying.confirm({ title: 'Unsubscribe?' });

		leaving.dispose();
		await expect(withdrawn).resolves.toBe(false);
		expect(pendingConfirms.value.map((request) => request.title)).toEqual(['Unsubscribe?']);
		expect(await settled(kept)).toEqual({ done: false });
	});

	it('answers every open question no when the last host goes away', async () => {
		const unregister = host();
		const second = host();
		const active = caller().confirm({ title: 'First?' });
		const queued = caller().confirm({ title: 'Second?' });

		unregister();
		// Another host is still mounted: nothing is answered yet.
		expect(await settled(active)).toEqual({ done: false });
		second();
		await expect(Promise.all([active, queued])).resolves.toEqual([false, false]);
		expect(pendingConfirms.value).toEqual([]);
	});

	it('answers no at once when no host is mounted, instead of hanging', async () => {
		await expect(caller().confirm({ title: 'Delete?' })).resolves.toBe(false);
		expect(pendingConfirms.value).toEqual([]);
	});
});
