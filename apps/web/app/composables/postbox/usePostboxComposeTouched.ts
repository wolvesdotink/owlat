/**
 * Which composer fields the person has set during this mount, by name.
 *
 * One tracker shared by everything that writes server or default values into
 * the composer: hydration (the loaded row only fills untouched fields), row
 * creation (the server's To/Subject only fill untouched fields), the device
 * mirror's Restore, and the compose page parking unsaved text (only touched
 * fields of a row that never loaded are real; the rest are placeholders).
 *
 * - Every field the seed explicitly supplies counts as touched from the start,
 *   empty values included: an empty string or list in a seed is a statement.
 * - A change made outside `applying()` marks the field touched. Clearing a
 *   field is a change like any other.
 * - A body edit (HTML or blocks) also marks the composer mode touched: the
 *   body is judged in the mode it was typed in, so the row's mode must not
 *   switch the editor away from it. A seeded body does not (the seed names
 *   its mode explicitly when it has one).
 * - `applying(fn)` runs server/default writes without marking anything. It is
 *   synchronous and nest-safe (a depth counter), and every watcher here is
 *   `flush: 'sync'`, so a write is attributed the moment it happens.
 */

import { watch, type WatchSource, type WatchStopHandle } from 'vue';
import { MIRROR_FIELD_NAMES, type MirrorFieldName } from '~/utils/postboxDraftMirror';

export type TrackedComposeField = MirrorFieldName;

export function usePostboxComposeTouched(
	fields: Record<TrackedComposeField, WatchSource<unknown>>,
	seeded: readonly TrackedComposeField[]
) {
	// A seed's body does not pin the mode (only an explicit seed mode does): a
	// reopened draft's quoted HTML stays one switch away from its row's blocks.
	const touched = new Set<TrackedComposeField>(seeded);
	let depth = 0;

	const stops: WatchStopHandle[] = MIRROR_FIELD_NAMES.map((name) =>
		watch(
			fields[name],
			() => {
				if (depth > 0) return;
				touched.add(name);
				if (name === 'bodyHtml' || name === 'bodyBlocks') touched.add('composerMode');
			},
			{ deep: true, flush: 'sync' }
		)
	);

	/** Run server/default writes without marking the fields they set. */
	function applying<T>(fn: () => T): T {
		depth += 1;
		try {
			return fn();
		} finally {
			depth -= 1;
		}
	}

	return {
		isTouched: (name: TrackedComposeField) => touched.has(name),
		/** The touched fields, in a stable order. */
		list: (): TrackedComposeField[] => MIRROR_FIELD_NAMES.filter((name) => touched.has(name)),
		applying,
		stop: () => {
			for (const stop of stops) stop();
		},
	};
}

export type ComposeTouched = ReturnType<typeof usePostboxComposeTouched>;
