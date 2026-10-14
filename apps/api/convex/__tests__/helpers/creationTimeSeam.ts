/**
 * Lets a test insert documents that share one `_creationTime`.
 *
 * convex-test gives every insert a distinct, strictly increasing creation time,
 * so a test can never build the ties production sees (many documents written in
 * one millisecond). Code that pages on `_creationTime` alone skips tied rows,
 * and only a tie shows it. This plugin rewrites the one line in convex-test
 * that stamps a new document's creation time to read an override from
 * `globalThis` first; {@link withCreationTime} sets that override around a
 * test's inserts. Without the override nothing changes.
 *
 * If a convex-test upgrade changes the line, the transform throws and every
 * test that loads convex-test fails, rather than the override going quiet.
 */

const CREATION_TIME_KEY = 'owlat.test.creationTime';

const CONVEX_TEST_ENTRY = /[\\/]node_modules[\\/]convex-test[\\/]dist[\\/]index\.js(\?.*)?$/;

const STAMP_LINE =
	'const _creationTime = now <= this._lastCreationTime ? this._lastCreationTime + 0.001 : now;';
const STAMP_WITH_OVERRIDE =
	`const _creationTime = globalThis[Symbol.for(${JSON.stringify(CREATION_TIME_KEY)})] ?? ` +
	'(now <= this._lastCreationTime ? this._lastCreationTime + 0.001 : now);';

/** Run `task` with every document it inserts created at exactly `at`. */
export async function withCreationTime<T>(at: number, task: () => Promise<T>): Promise<T> {
	const key = Symbol.for(CREATION_TIME_KEY);
	const scope = globalThis as unknown as Record<symbol, number | undefined>;
	scope[key] = at;
	try {
		return await task();
	} finally {
		delete scope[key];
	}
}

/** Structurally a Vite plugin; typed locally so the api package needs no `vite` import. */
export interface CreationTimeSeamPlugin {
	name: string;
	enforce: 'pre';
	transform(code: string, id: string): string | null;
}

export function creationTimeSeam(): CreationTimeSeamPlugin {
	return {
		name: 'owlat:creation-time-seam',
		enforce: 'pre',
		transform(code, id) {
			if (!CONVEX_TEST_ENTRY.test(id)) return null;
			const occurrences = code.split(STAMP_LINE).length - 1;
			if (occurrences !== 1) {
				throw new Error(
					`creationTimeSeam: expected one creation-time stamp in ${id}, found ${occurrences}. ` +
						'convex-test changed; update convex/__tests__/helpers/creationTimeSeam.ts.'
				);
			}
			return code.replace(STAMP_LINE, () => STAMP_WITH_OVERRIDE);
		},
	};
}
