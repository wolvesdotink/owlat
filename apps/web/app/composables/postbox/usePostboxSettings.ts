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
 *   - `viewMode` — which list renderer the inbox uses: 'flat' (default),
 *     'conversations' (thread-grouped), or 'categories' (smart-inbox
 *     sections). Inbox-only; other folders always render flat.
 *   - `inboxMode` — which surface the inbox route lands on: 'today' (the
 *     focused single-column view, the default) or 'browse' (the full
 *     three-pane UI). Persisted as the last-used mode.
 *   - `sendSound` — play a short confirmation sound when a message is
 *     dispatched. Defaults OFF (opt-in).
 */

import { api } from '@owlat/api';
import type { PostboxAutoAdvanceMode } from '~/utils/postboxAutoAdvance';
import { POSTBOX_AUTO_ADVANCE_DEFAULT } from '~/utils/postboxAutoAdvance';
import type { PostboxReplyDefaultMode } from '~/utils/postboxReplyDefault';
import { POSTBOX_REPLY_DEFAULT } from '~/utils/postboxReplyDefault';
import type { PostboxDensity } from '~/utils/postboxDensity';
import { resolvePostboxDensity } from '~/utils/postboxDensity';
import type { PostboxViewMode } from '~/utils/postboxViewMode';
import { resolvePostboxViewMode } from '~/utils/postboxViewMode';
import type { PostboxInboxMode } from '~/utils/postboxInboxMode';
import { resolvePostboxInboxMode } from '~/utils/postboxInboxMode';
import type { PostboxNotifyAbout } from '~/utils/postboxNotify';
import { resolvePostboxNotifyAbout } from '~/utils/postboxNotify';

export function usePostboxSettings() {
	const { data, isLoading } = useConvexQuery(api.mail.settings.get, () => ({}));
	const { isEnabled } = useFeatureFlag();
	// Smart categories are AI-gated (mailMessages.category is classified behind
	// the Postbox aiGate), so the `ai` flag is the client-side signal for whether
	// the quieter 'people-important' default is meaningful yet.
	const categoriesLive = computed(() => isEnabled('ai'));

	const autoAdvance = computed<PostboxAutoAdvanceMode>(
		() => data.value?.autoAdvance ?? POSTBOX_AUTO_ADVANCE_DEFAULT
	);

	// Default ON: an unset preference means "use suggestions" — the `ai` flag is
	// the real on/off switch, this is a user opt-out within an AI-enabled deploy.
	const writingSuggestions = computed<boolean>(() => data.value?.isWritingSuggestionsOn ?? true);

	// Default ON, same as writing suggestions: the `ai` flag is the master gate,
	// this is a per-user opt-out for the long-thread summary strip.
	const autoSummarize = computed<boolean>(() => data.value?.isAutoSummarizeOn ?? true);

	// Which mode the primary reply affordance (Reply button / `r`) uses. Reads
	// default to 'reply' while loading or when never saved, so the reader can
	// consume it unconditionally.
	const replyDefault = computed<PostboxReplyDefaultMode>(
		() => data.value?.replyDefault ?? POSTBOX_REPLY_DEFAULT
	);

	// List/reader density. An unset (or unknown) value resolves to 'comfortable',
	// so the reader can consume it unconditionally while the query loads.
	const density = computed<PostboxDensity>(() => resolvePostboxDensity(data.value?.density));

	// Inbox list view mode. An unset (or unknown) value resolves to 'flat', so
	// the layout can consume it unconditionally while the query loads.
	const viewMode = computed<PostboxViewMode>(() => resolvePostboxViewMode(data.value?.viewMode));

	// Inbox landing mode ('today' vs 'browse'). An unset (or unknown) value
	// resolves to 'today' — the focused single-column view is the default
	// landing experience; 'browse' is remembered once the user switches.
	const inboxMode = computed<PostboxInboxMode>(() =>
		resolvePostboxInboxMode(data.value?.inboxMode)
	);

	// Confirmation sound on send. Default OFF (opt-in): an unset preference means
	// no sound, so the composer stays silent unless the user turns it on.
	const sendSound = computed<boolean>(() => data.value?.isSendSoundOn ?? false);

	// Desktop notification scope. An unset value resolves to 'people-important'
	// once categories are live and 'everything' otherwise, so the desktop reader
	// can consume it unconditionally while the query loads.
	const notifyAbout = computed<PostboxNotifyAbout>(() =>
		resolvePostboxNotifyAbout(data.value?.notifyAbout, categoriesLive.value)
	);

	// Whether non-`person` mail still increments the dock/tray badge. Default ON
	// (unset => badge counts everything, the pre-existing behavior).
	const badgeNonPeople = computed<boolean>(() => data.value?.isBadgeNonPeopleOn ?? true);

	// HEY-style first-time-sender screener. Default OFF (opt-in): mail from an
	// unknown sender only skips the Reply Queue when the owner turns this on, so
	// a deploy that never toggles it keeps today's behavior.
	const senderScreener = computed<boolean>(() => data.value?.isSenderScreenerOn ?? false);

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

	// Reports success so callers with an optimistic override can snap back on
	// failure: the update mutation returns a row id, while a failed run()
	// resolves to undefined (the error is already toasted).
	async function setViewMode(mode: PostboxViewMode): Promise<boolean> {
		return (await updateOp.run({ viewMode: mode })) !== undefined;
	}

	// Same success contract as setViewMode: callers with an optimistic override
	// snap back when the save failed (already toasted by useBackendOperation).
	async function setInboxMode(mode: PostboxInboxMode): Promise<boolean> {
		return (await updateOp.run({ inboxMode: mode })) !== undefined;
	}

	async function setSendSound(enabled: boolean) {
		await updateOp.run({ isSendSoundOn: enabled });
	}

	async function setNotifyAbout(mode: PostboxNotifyAbout) {
		await updateOp.run({ notifyAbout: mode });
	}

	async function setBadgeNonPeople(enabled: boolean) {
		await updateOp.run({ isBadgeNonPeopleOn: enabled });
	}

	async function setSenderScreener(enabled: boolean) {
		await updateOp.run({ isSenderScreenerOn: enabled });
	}

	return {
		autoAdvance,
		writingSuggestions,
		autoSummarize,
		replyDefault,
		density,
		viewMode,
		inboxMode,
		sendSound,
		notifyAbout,
		badgeNonPeople,
		senderScreener,
		isLoading,
		setAutoAdvance,
		setWritingSuggestions,
		setAutoSummarize,
		setReplyDefault,
		setDensity,
		setViewMode,
		setInboxMode,
		setSendSound,
		setNotifyAbout,
		setBadgeNonPeople,
		setSenderScreener,
		isSaving: updateOp.isLoading,
	};
}
