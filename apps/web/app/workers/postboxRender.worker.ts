/**
 * Dedicated worker for the string half of the Postbox body render (sanitize,
 * dark-mode adaptation, `cid:` images, link transparency). A thin adapter:
 * the pipeline itself is utils/postboxRenderPipeline, shared with the
 * main-thread fallback. Every request is answered, including the ones whose
 * render throws, so the client never waits on a request that cannot finish.
 */

import {
	renderPostboxBodyStage,
	type PostboxRenderWorkerRequest,
	type PostboxRenderWorkerResponse,
} from '../utils/postboxRenderPipeline';

function respond(response: PostboxRenderWorkerResponse): void {
	globalThis.postMessage(response);
}

globalThis.addEventListener('message', (event: MessageEvent<PostboxRenderWorkerRequest>) => {
	const { id, input } = event.data;
	try {
		respond({ id, ok: true, output: renderPostboxBodyStage(input) });
	} catch (error) {
		respond({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
	}
});
