/**
 * Find in conversation's index: every loaded message, read once, with bounded
 * work.
 *   - a body the row carries is rendered without a load; an envelope asks the
 *     inline query first, a stored body goes straight to its blob;
 *   - at most FIND_LOAD_CONCURRENCY loads and one render run at once;
 *   - encrypted or signed content is never searched, even when only its
 *     loaded body says so;
 *   - a reset drops every answer still on its way.
 * Deferred promises stand in for the network and the render worker, so the
 * test decides when each answer lands.
 */
import { describe, expect, it } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import {
	renderPostboxBodyStage,
	type PostboxRenderStageInput,
} from '~/utils/postboxRenderPipeline';
import { postboxFindNeedle, countPostboxFindMatches } from '~/utils/postboxFindHighlights';
import type { ResolvedPostboxBody } from '../postboxBodyResolver';
import {
	FIND_LOAD_CONCURRENCY,
	createPostboxFindIndex,
	type PostboxFindRow,
} from '../postboxFindIndex';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function harness() {
	const loads: Array<{
		id: string;
		blobOnly: boolean;
		answer: ReturnType<typeof deferred<ResolvedPostboxBody>>;
	}> = [];
	const renders: Array<{
		input: PostboxRenderStageInput;
		answer: ReturnType<typeof deferred<string>>;
		cancelled: boolean;
	}> = [];
	const index = createPostboxFindIndex({
		loadBody: (id, { blobOnly }) => {
			const answer = deferred<ResolvedPostboxBody>();
			loads.push({ id, blobOnly, answer });
			return answer.promise;
		},
		render: (input) => {
			const entry = { input, answer: deferred<string>(), cancelled: false };
			renders.push(entry);
			return {
				promise: entry.answer.promise,
				cancel: () => {
					entry.cancelled = true;
				},
			};
		},
		parse: (html) => new DOMParser().parseFromString(html, 'text/html'),
	});
	/** Answer the next unanswered render with the real pipeline's output. */
	async function finishRender(at = renders.length - 1) {
		const entry = renders[at]!;
		entry.answer.resolve(renderPostboxBodyStage(entry.input).html);
		await flushPromises();
	}
	return { index, loads, renders, finishRender };
}

const row = (id: string, extra: Partial<PostboxFindRow> = {}): PostboxFindRow => ({
	_id: id,
	...extra,
});
const all = () => true;
const matches = (index: ReturnType<typeof harness>['index'], id: string, word: string) => {
	const text = index.textOf(id);
	return text ? countPostboxFindMatches(text, postboxFindNeedle(word)).total : undefined;
};

describe('createPostboxFindIndex', () => {
	it('renders a body the row carries without loading anything', async () => {
		const { index, loads, renders, finishRender } = harness();
		index.ensure([row('m1', { htmlBodyInline: '<p>Refund due</p>' })], all);
		expect(index.stateOf('m1')).toBe('pending');
		expect(loads).toHaveLength(0);
		expect(renders[0]!.input).toMatchObject({ showQuoted: true, markQuoteDivider: true });
		await finishRender();
		expect(index.stateOf('m1')).toBe('ready');
		expect(matches(index, 'm1', 'refund')).toBe(1);
	});

	it('asks an envelope inline first and a stored body straight from its blob', async () => {
		const { index, loads } = harness();
		index.ensure([row('env'), row('blob', { htmlBodyStorageId: 'st1' })], all);
		expect(loads.map((l) => [l.id, l.blobOnly])).toEqual([
			['env', false],
			['blob', true],
		]);
	});

	it('loads a bounded number of bodies at once and renders one at a time', async () => {
		const { index, loads, renders, finishRender } = harness();
		const rows = Array.from({ length: 7 }, (_, i) => row(`e${i}`));
		index.ensure(rows, all);
		expect(loads).toHaveLength(FIND_LOAD_CONCURRENCY);
		loads[0]!.answer.resolve({ html: '<p>one refund</p>', text: null });
		loads[1]!.answer.resolve({ html: '<p>two refund</p>', text: null });
		await flushPromises();
		// Two finished loads free two slots; only one render is in flight.
		expect(loads).toHaveLength(FIND_LOAD_CONCURRENCY + 2);
		expect(renders).toHaveLength(1);
		await finishRender(0);
		expect(renders).toHaveLength(2);
		await finishRender(1);
		expect(index.stateOf('e0')).toBe('ready');
		expect(index.stateOf('e1')).toBe('ready');
		// Known rows are not read again.
		index.ensure(rows, all);
		expect(loads).toHaveLength(FIND_LOAD_CONCURRENCY + 2);
	});

	it('never searches encrypted or signed content, even once its body says so', async () => {
		const { index, loads, renders } = harness();
		index.ensure(
			[row('sealed'), row('plain', { textBodyInline: 'refund' })],
			(r) => r._id !== 'sealed'
		);
		expect(index.stateOf('sealed')).toBe('unsearchable');
		index.ensure([row('clear')], all);
		loads[0]!.answer.resolve({
			html: null,
			text: '-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nrefund\n-----BEGIN PGP SIGNATURE-----\nabc\n-----END PGP SIGNATURE-----',
		});
		await flushPromises();
		expect(index.stateOf('clear')).toBe('unsearchable');
		expect(renders.map((r) => r.input.text)).toEqual(['refund']);
	});

	it('reports a body it could not read, and tries it again on request', async () => {
		const { index, loads } = harness();
		index.ensure([row('a'), row('b')], all);
		loads[0]!.answer.reject(new Error('offline'));
		loads[1]!.answer.resolve(null);
		await flushPromises();
		expect(index.stateOf('a')).toBe('failed');
		expect(index.stateOf('b')).toBe('failed');
		index.forgetFailed();
		index.ensure([row('a'), row('b')], all);
		expect(loads.map((l) => l.id)).toEqual(['a', 'b', 'a', 'b']);
	});

	it('waits for a body that is still on its way to the row', () => {
		const { index, loads, renders } = harness();
		index.ensure([row('m1', { bodyPending: true })], all);
		expect(index.stateOf('m1')).toBeUndefined();
		expect(loads).toHaveLength(0);
		expect(renders).toHaveLength(0);
	});

	it('drops every answer still on its way after a reset', async () => {
		const { index, loads, renders } = harness();
		index.ensure([row('env'), row('inline', { textBodyInline: 'refund' })], all);
		index.reset();
		expect(renders[0]!.cancelled).toBe(true);
		loads[0]!.answer.resolve({ html: '<p>refund</p>', text: null });
		renders[0]!.answer.resolve('<p>refund</p>');
		await flushPromises();
		expect(index.stateOf('env')).toBeUndefined();
		expect(index.stateOf('inline')).toBeUndefined();
		// The stale load did not start a render either.
		expect(renders).toHaveLength(1);
	});
});
