/**
 * Find in conversation's index: the searchable text of every loaded message of
 * one reader, collapsed, quoted away or off screen alike.
 *
 * The browser's own find cannot help here: each body renders in its own
 * iframe, a collapsed message renders no body, a quoted chain is cut out of the
 * document until it is shown, and an envelope's body is not even loaded. So
 * each message's body goes through the same render pipeline the reader uses
 * (sanitized, link-checked, quote shown with its divider marked), into an
 * inert `DOMParser` document that loads nothing and runs nothing, and its
 * visible text is kept (utils/postboxFindHighlights). The text is independent
 * of the query: typing never refetches.
 *
 * Bounded work: bodies a row does not carry load {@link FIND_LOAD_CONCURRENCY}
 * at a time through the body resolver without filling its cache, and the
 * pipeline runs one message at a time, so the shared render worker never
 * queues more than one index job ahead of a body the reader is opening. A
 * message is indexed once per reader; `reset` drops everything and makes every
 * answer still in flight land nowhere.
 */
import { shallowReactive } from 'vue';
import { classifySecureMessage } from '@owlat/shared/secureMessage';
import { getPostboxRenderClient } from '~/lib/postboxRenderWorker';
import {
	renderPostboxBodyStage,
	type PostboxRenderStageInput,
} from '~/utils/postboxRenderPipeline';
import { postboxFindTextOf, type PostboxFindText } from '~/utils/postboxFindHighlights';
import { readPostboxMessageBodyUncached, type ResolvedPostboxBody } from './postboxBodyResolver';
import type { OpenRowMessage } from './usePostboxReaderOpenRow';

/** Bodies loaded at once while indexing. */
export const FIND_LOAD_CONCURRENCY = 3;

/**
 * Where a message stands: being read, searchable, its body could not be read,
 * or it is not searched at all (encrypted or signed content the reader shows
 * through its security badge, never as an ordinary body).
 */
export type PostboxFindIndexState = 'pending' | 'ready' | 'failed' | 'unsearchable';

/** What the index reads of a message row. */
export interface PostboxFindRow extends OpenRowMessage {
	attachments?: ReadonlyArray<{ contentType: string; filename?: string }>;
}

export interface PostboxFindIndexDeps {
	/** A body the row does not carry; `blobOnly` when the row says it is a blob. */
	loadBody: (messageId: string, options: { blobOnly: boolean }) => Promise<ResolvedPostboxBody>;
	/** The render pipeline's string stage; resolves to the rendered HTML. */
	render: (input: PostboxRenderStageInput) => { promise: Promise<string>; cancel: () => void };
	/** Parse rendered HTML into an inert document. */
	parse: (html: string) => Document;
}

export interface PostboxFindIndex {
	/** Index every row not yet known; `searchable` false marks a row unsearchable. */
	ensure: (rows: readonly PostboxFindRow[], searchable: (row: PostboxFindRow) => boolean) => void;
	/** Undefined for a row never handed to `ensure` (or one waiting for its inline body). */
	stateOf: (messageId: string) => PostboxFindIndexState | undefined;
	textOf: (messageId: string) => PostboxFindText | undefined;
	/** Forget the messages whose body could not be read, so `ensure` tries them again. */
	forgetFailed: () => void;
	/** Forget everything; answers still in flight are dropped. */
	reset: () => void;
}

type BodyPlan =
	| { kind: 'wait' }
	| { kind: 'inline'; body: { html: string | null; text: string | null } }
	| { kind: 'load'; blobOnly: boolean };

/** Where a row's body comes from, as PostboxMessageBody would read it. */
function planBody(row: PostboxFindRow): BodyPlan {
	if (row.bodyPending) return { kind: 'wait' };
	if (row.htmlBodyInline) {
		return {
			kind: 'inline',
			body: { html: row.htmlBodyInline, text: row.textBodyInline ?? null },
		};
	}
	if (row.htmlBodyStorageId || row.hasBodyBlob) return { kind: 'load', blobOnly: true };
	if (row.textBodyInline) return { kind: 'inline', body: { html: null, text: row.textBodyInline } };
	if (row.textBodyStorageId) return { kind: 'load', blobOnly: true };
	// An envelope: no body and no word on where it lives; ask the inline query first.
	return { kind: 'load', blobOnly: false };
}

function stageInput(body: { html: string | null; text: string | null }): PostboxRenderStageInput {
	return {
		html: body.html ?? '',
		text: body.text ?? '',
		showQuoted: true,
		// Text is the same in every scheme; light skips the dark adaptation.
		scheme: 'light',
		cidUrls: new Map(),
		markQuoteDivider: true,
	};
}

export function createPostboxFindIndex(deps: PostboxFindIndexDeps): PostboxFindIndex {
	const states = shallowReactive(new Map<string, PostboxFindIndexState>());
	const texts = new Map<string, PostboxFindText>();
	let generation = 0;
	let loading = 0;
	const loadQueue: Array<{ row: PostboxFindRow; blobOnly: boolean }> = [];
	const renderQueue: Array<{
		row: PostboxFindRow;
		body: { html: string | null; text: string | null };
	}> = [];
	let rendering: { cancel: () => void } | null = null;

	function settle(id: string, state: PostboxFindIndexState, text?: PostboxFindText) {
		if (text) texts.set(id, text);
		states.set(id, state);
	}

	/** Queue a body for the pipeline, unless it is not an ordinary body at all. */
	function queueRender(row: PostboxFindRow, body: { html: string | null; text: string | null }) {
		// Signed or encrypted content shows through the security badge, never as
		// an ordinary body, so its raw text is not searched. A row's own class can
		// miss it: an envelope's text arrives only with its body.
		const attachments = row.attachments ? [...row.attachments] : [];
		if (classifySecureMessage({ attachments, textBody: body.text ?? undefined }) !== 'none') {
			settle(row._id, 'unsearchable');
			return;
		}
		renderQueue.push({ row, body });
	}

	function pumpRender() {
		if (rendering) return;
		const next = renderQueue.shift();
		if (!next) return;
		const { row, body } = next;
		const at = generation;
		const job = deps.render(stageInput(body));
		rendering = job;
		job.promise
			.then((html) => {
				if (at !== generation) return;
				settle(row._id, 'ready', postboxFindTextOf(deps.parse(html)));
			})
			.catch(() => {
				if (at === generation) settle(row._id, 'failed');
			})
			.finally(() => {
				if (at !== generation) return;
				rendering = null;
				pumpRender();
			});
	}

	function pumpLoad() {
		while (loading < FIND_LOAD_CONCURRENCY && loadQueue.length > 0) {
			const { row, blobOnly } = loadQueue.shift()!;
			const at = generation;
			loading++;
			deps
				.loadBody(row._id, { blobOnly })
				.then((body) => {
					if (at !== generation) return;
					if (!body) {
						settle(row._id, 'failed');
						return;
					}
					queueRender(row, body);
					pumpRender();
				})
				.catch(() => {
					if (at === generation) settle(row._id, 'failed');
				})
				.finally(() => {
					if (at !== generation) return;
					loading--;
					pumpLoad();
				});
		}
	}

	function ensure(rows: readonly PostboxFindRow[], searchable: (row: PostboxFindRow) => boolean) {
		for (const row of rows) {
			if (states.has(row._id)) continue;
			if (!searchable(row)) {
				settle(row._id, 'unsearchable');
				continue;
			}
			const plan = planBody(row);
			if (plan.kind === 'wait') continue;
			states.set(row._id, 'pending');
			if (plan.kind === 'inline') queueRender(row, plan.body);
			else loadQueue.push({ row, blobOnly: plan.blobOnly });
		}
		pumpLoad();
		pumpRender();
	}

	function reset() {
		generation++;
		rendering?.cancel();
		rendering = null;
		loading = 0;
		loadQueue.length = 0;
		renderQueue.length = 0;
		texts.clear();
		states.clear();
	}

	function forgetFailed() {
		for (const [id, state] of states) if (state === 'failed') states.delete(id);
	}

	return {
		ensure,
		stateOf: (id) => states.get(id),
		textOf: (id) => texts.get(id),
		forgetFailed,
		reset,
	};
}

/** The reader's own wiring: the authenticated client, the render worker, DOMParser. */
export function defaultPostboxFindIndexDeps(): PostboxFindIndexDeps {
	return {
		loadBody: (messageId, { blobOnly }) =>
			readPostboxMessageBodyUncached(requireConvex(), messageId, { blobOnly }),
		render: (input) => {
			const client = getPostboxRenderClient();
			if (!client) {
				return {
					promise: Promise.resolve().then(() => renderPostboxBodyStage(input).html),
					cancel: () => {},
				};
			}
			const job = client.render(input);
			return {
				// A worker that fails mid-run hands its job back: the same pipeline
				// on the main thread, as the reader's own bodies do.
				promise: job.promise.then(
					(output) => output.html,
					() => renderPostboxBodyStage(input).html
				),
				cancel: job.cancel,
			};
		},
		parse: (html) => new DOMParser().parseFromString(html, 'text/html'),
	};
}
