/**
 * Per-user Postbox behavior preferences (api.mail.settings).
 *
 * Preferences:
 *   - `autoAdvance` — what the reader does after the open message is triaged
 *     away (archive / trash / snooze / spam). Reads default to 'next' while
 *     loading or when the user has never saved a row, so the reader can consume
 *     the value unconditionally.
 *   - `writingSuggestions` — inline ghost-text autocomplete in the composer.
 *     Defaults ON (undefined => true) so it's on by default wherever the `ai`
 *     feature flag is enabled; the flag itself is the master gate.
 *   - `autoSummarize` — the cached one-line AI summary strip on long threads.
 *     Defaults ON (undefined => true), same master-gate reasoning as above.
 *   - `replyDefault` — whether the primary reply affordance (Reply button /
 *     `r`) opens a plain Reply or a Reply-all. Defaults to 'reply'.
 *   - `density` — 'comfortable' (roomy default) vs 'compact' (tighter rows +
 *     single-line subject/snippet). Defaults to 'comfortable'.
 */

import { api } from '@owlat/api';
import type { PostboxAutoAdvanceMode } from '~/utils/postboxAutoAdvance';
import { POSTBOX_AUTO_ADVANCE_DEFAULT } from '~/utils/postboxAutoAdvance';
import type { PostboxReplyDefaultMode } from '~/utils/postboxReplyDefault';
import { POSTBOX_REPLY_DEFAULT } from '~/utils/postboxReplyDefault';
import type { PostboxDensity } from '~/utils/postboxDensity';
import { resolvePostboxDensity } from '~/utils/postboxDensity';

export function usePostboxSettings() {
	const { data, isLoading } = useConvexQuery(api.mail.settings.get, () => ({}));

	const autoAdvance = computed<PostboxAutoAdvanceMode>(
		() => data.value?.autoAdvance ?? POSTBOX_AUTO_ADVANCE_DEFAULT
	);

	// Default ON: an unset preference means "use suggestions" — the `ai` flag is
	// the real on/off switch, this is a user opt-out within an AI-enabled deploy.
	const writingSuggestions = computed<boolean>(
		() => data.value?.isWritingSuggestionsOn ?? true
	);

	// Default ON, same as writing suggestions: the `ai` flag is the master gate,
	// this is a per-user opt-out for the long-thread summary strip.
	const autoSummarize = computed<boolean>(
		() => data.value?.isAutoSummarizeOn ?? true
	);

	// Which mode the primary reply affordance (Reply button / `r`) uses. Reads
	// default to 'reply' while loading or when never saved, so the reader can
	// consume it unconditionally.
	const replyDefault = computed<PostboxReplyDefaultMode>(
		() => data.value?.replyDefault ?? POSTBOX_REPLY_DEFAULT
	);

	// List/reader density. An unset (or unknown) value resolves to 'comfortable',
	// so the reader can consume it unconditionally while the query loads.
	const density = computed<PostboxDensity>(() =>
		resolvePostboxDensity(data.value?.density)
	);

	const updateOp = useBackendOperation(api.mail.settings.update, {
		label: 'Save Postbox settings',
	});

	async function setAutoAdvance(mode: PostboxAutoAdvanceMode) {
		await updateOp.run({ autoAdvance: mode });
	}

	async function setWritingSuggestions(enabled: boolean) {
		await updateOp.run({ isWritingSuggestionsOn: enabled });
	}

	async function setAutoSummarize(enabled: boolean) {
		await updateOp.run({ isAutoSummarizeOn: enabled });
	}

	async function setReplyDefault(mode: PostboxReplyDefaultMode) {
		await updateOp.run({ replyDefault: mode });
	}

	async function setDensity(mode: PostboxDensity) {
		await updateOp.run({ density: mode });
	}

	return {
		autoAdvance,
		writingSuggestions,
		autoSummarize,
		replyDefault,
		density,
		isLoading,
		setAutoAdvance,
		setWritingSuggestions,
		setAutoSummarize,
		setReplyDefault,
		setDensity,
		isSaving: updateOp.isLoading,
	};
}
