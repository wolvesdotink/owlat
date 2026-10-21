import type { CanIEmailData } from '../types';

/**
 * Loads the Can I Email dataset bundled with the app
 * (`packages/shared/src/generated/caniemail-data.json`, refreshed with
 * `bun run update-caniemail` in packages/shared).
 *
 * The analysis used to fetch https://www.caniemail.com/api/data.json, which the
 * web app's CSP (`connect-src`) blocks, so every web report fell back to
 * heuristics. The snapshot needs no third-party request. It is a dynamic import,
 * so its ~1 MB stays in its own chunk and loads only when an analysis needs it.
 */
export async function loadCanIEmailSnapshot(): Promise<CanIEmailData> {
	const { default: snapshot } = await import('@owlat/shared/caniemailData');
	if (
		!Array.isArray(snapshot?.data) ||
		typeof snapshot.nicenames !== 'object' ||
		snapshot.nicenames === null
	) {
		throw new Error('The bundled Can I Email data is malformed');
	}
	return snapshot as CanIEmailData;
}
