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
 *   - `readingPane` — where the reader sits relative to the list: 'right'
 *     (side-by-side, the default and today's geometry), 'bottom' (a full-width
 *     list above the reader) or 'off' (no reading pane; opening navigates).
 *     `listWidth` / `listHeight` carry the divider position per axis.
 *   - `inboxMode` — which surface the inbox route lands on: 'today' (the
 *     focused single-column view, the default) or 'browse' (the full
 *     three-pane UI). Persisted as the last-used mode.
 *   - `sortOrder` — which end of the folder the message list starts at:
 *     'newest' (arrival descending, the default) or 'oldest'. Date direction
 *     only; the server flips `.order()` on the existing arrival index.
 *   - `sendSound` — play a short confirmation sound when a message is
 *     dispatched. Defaults OFF (opt-in).
 *   - `undoSendSeconds` — how long a sent message is held before it dispatches
 *     (Off / 10 / 30 / 60). Defaults to 30s, the server's own default, so an
 *     unset preference is exactly the behaviour that shipped before it existed.
 *   - `quietHours` — a local-time window plus weekday mask during which desktop
 *     toasts are held back and rolled into one summary when it ends. Defaults
 *     OFF, so an untouched row suppresses nothing.
 *   - `hidePreview` — desktop notifications carry a generic "New message" line
 *     instead of the sender and subject. Defaults OFF.
 *   - `dailyBriefEmail` — opt-in delivery of the Daily Brief to the owner's own
 *     mailbox at a chosen LOCAL time. Absent means no delivery at all, which is
 *     exactly the behaviour before it existed; the stored `utcOffsetMinutes` is
 *     what lets a cron with no request behind it honour "07:00 my time".
 *   - `trashAutoPurgeDays` — how long a message sits in Trash before the
 *     retention sweep deletes it for good (Never / 7 / 30 / 90 days). Defaults
 *     to Never, so an untouched row keeps every trashed message forever, which
 *     is exactly the behaviour that shipped before the control existed.
 *   - `markReadPolicy` — when an opened conversation loses its unread flags:
 *     'immediate' (mark on render, the default and today's behaviour),
 *     'after-dwell' (mark after a short visible dwell, cancelled by navigating
 *     away first) or 'manual' (never automatic).
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
import type { PostboxReadingPane } from '~/utils/postboxReadingPane';
import { resolvePostboxListSize, resolvePostboxReadingPane } from '~/utils/postboxReadingPane';
import type { PostboxInboxMode } from '~/utils/postboxInboxMode';
import { resolvePostboxInboxMode } from '~/utils/postboxInboxMode';
import type { PostboxSortOrder } from '~/utils/postboxSortOrder';
import { resolvePostboxSortOrder } from '~/utils/postboxSortOrder';
import type { PostboxNotifyAbout } from '~/utils/postboxNotify';
import { resolvePostboxNotifyAbout } from '~/utils/postboxNotify';
import type { PostboxUndoSendSeconds } from '~/utils/postboxUndoSendWindow';
import { resolvePostboxUndoSendSeconds } from '~/utils/postboxUndoSendWindow';
import type { PostboxMarkReadPolicy } from '~/utils/postboxMarkReadPolicy';
import { resolvePostboxMarkReadPolicy } from '~/utils/postboxMarkReadPolicy';
import type { PostboxQuietHours } from '~/utils/postboxQuietHours';
import { resolvePostboxQuietHours } from '~/utils/postboxQuietHours';
import type { PostboxTrashAutoPurgeDays } from '~/utils/postboxTrashRetention';
import { resolvePostboxTrashAutoPurgeDays } from '~/utils/postboxTrashRetention';

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

	// Reading-pane layout + the divider position per axis. All three resolve
	// through the pure module, so an unset (or out-of-range) row reads as the
	// side-by-side 384px geometry the layout had before the control existed.
	const readingPane = computed<PostboxReadingPane>(() =>
		resolvePostboxReadingPane(data.value?.readingPane)
	);
	const listWidth = computed<number>(() => resolvePostboxListSize(data.value?.listWidth, 'width'));
	const listHeight = computed<number>(() =>
		resolvePostboxListSize(data.value?.listHeight, 'height')
	);

	// Inbox landing mode ('today' vs 'browse'). An unset (or unknown) value
	// resolves to 'today' — the focused single-column view is the default
	// landing experience; 'browse' is remembered once the user switches.
	const inboxMode = computed<PostboxInboxMode>(() =>
		resolvePostboxInboxMode(data.value?.inboxMode)
	);

	// Message-list sort order. An unset (or unknown) value resolves to 'newest' —
	// exactly the hardcoded order the list had before the control existed.
	const sortOrder = computed<PostboxSortOrder>(() =>
		resolvePostboxSortOrder(data.value?.sortOrder)
	);

	// Confirmation sound on send. Default OFF (opt-in): an unset preference means
	// no sound, so the composer stays silent unless the user turns it on.
	const sendSound = computed<boolean>(() => data.value?.isSendSoundOn ?? false);

	// Undo-send window. An unset (or unknown) value resolves to 30s — the server
	// default the composer gets by sending no `undoSendDelayMs` at all.
	const undoSendSeconds = computed<PostboxUndoSendSeconds>(() =>
		resolvePostboxUndoSendSeconds(data.value?.undoSendSeconds)
	);

	// Desktop notification scope. An unset value resolves to 'people-important'
	// once categories are live and 'everything' otherwise, so the desktop reader
	// can consume it unconditionally while the query loads.
	const notifyAbout = computed<PostboxNotifyAbout>(() =>
		resolvePostboxNotifyAbout(data.value?.notifyAbout, categoriesLive.value)
	);

	// Whether non-`person` mail still increments the dock/taskbar badge. Default ON
	// (unset => badge counts everything, the pre-existing behavior).
	const badgeNonPeople = computed<boolean>(() => data.value?.isBadgeNonPeopleOn ?? true);

	// Quiet-hours window + weekday mask. An unset value resolves to the OFF
	// default (with a 22:00–07:00 window pre-filled), so an untouched row
	// suppresses nothing — exactly the behaviour before the control existed.
	const quietHours = computed<PostboxQuietHours>(() =>
		resolvePostboxQuietHours(data.value?.quietHours)
	);

	// Hide message previews in desktop notifications (generic "New message" body
	// instead of sender + subject). Default OFF (opt-in) — the preview is what
	// shipped before this control existed.
	const hidePreview = computed<boolean>(() => data.value?.isHidePreviewOn ?? false);

	// HEY-style first-time-sender screener. Default OFF (opt-in): mail from an
	// unknown sender only skips the Reply Queue when the owner turns this on, so
	// a deploy that never toggles it keeps today's behavior.
	const senderScreener = computed<boolean>(() => data.value?.isSenderScreenerOn ?? false);

	// When an opened conversation is marked read. An unset (or unknown) value
	// resolves to 'immediate' — exactly the mark-on-render behaviour the reader
	// had before this control existed.
	const markReadPolicy = computed<PostboxMarkReadPolicy>(() =>
		resolvePostboxMarkReadPolicy(data.value?.markReadPolicy)
	);

	// Trash auto-purge horizon, in days. An unset (or unknown) value resolves to
	// 0 — "Never" — which is exactly what every mailbox did before the setting
	// existed: nothing in the bin is ever deleted unless the owner says so.
	const trashAutoPurgeDays = computed<PostboxTrashAutoPurgeDays>(() =>
		resolvePostboxTrashAutoPurgeDays(data.value?.trashAutoPurgeDays)
	);

	// Daily-brief email delivery. Deliberately NOT defaulted: absent means the
	// user has never opted in, and the card renders the off state rather than
	// inventing a schedule nobody chose.
	const dailyBriefEmail = computed(() => data.value?.dailyBriefEmail ?? null);

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
		return (await updateOp.run({ viewMode: mode })).ok;
	}

	// Same success contract as setViewMode: the layout flips optimistically and
	// snaps back when the save did not land.
	async function setReadingPane(pane: PostboxReadingPane): Promise<boolean> {
		return (await updateOp.run({ readingPane: pane })).ok;
	}

	// The divider drag writes ONCE, on release — a mutation per pointermove
	// would be a write storm. Clamped here as well as on read so a stray
	// pointer value can never be persisted out of range.
	async function setListSize(axis: 'width' | 'height', size: number): Promise<boolean> {
		const clamped = resolvePostboxListSize(size, axis);
		return (await updateOp.run(axis === 'width' ? { listWidth: clamped } : { listHeight: clamped }))
			.ok;
	}

	// Same success contract as setViewMode: callers with an optimistic override
	// snap back when the save failed (already toasted by useBackendOperation).
	async function setInboxMode(mode: PostboxInboxMode): Promise<boolean> {
		return (await updateOp.run({ inboxMode: mode })).ok;
	}

	// Same success contract as setViewMode: the header flips optimistically and
	// snaps back when the save did not land.
	async function setSortOrder(order: PostboxSortOrder): Promise<boolean> {
		return (await updateOp.run({ sortOrder: order })).ok;
	}

	async function setSendSound(enabled: boolean) {
		await updateOp.run({ isSendSoundOn: enabled });
	}

	async function setUndoSendSeconds(seconds: PostboxUndoSendSeconds) {
		await updateOp.run({ undoSendSeconds: seconds });
	}

	async function setNotifyAbout(mode: PostboxNotifyAbout) {
		await updateOp.run({ notifyAbout: mode });
	}

	async function setBadgeNonPeople(enabled: boolean) {
		await updateOp.run({ isBadgeNonPeopleOn: enabled });
	}

	async function setQuietHours(value: PostboxQuietHours) {
		await updateOp.run({ quietHours: value });
	}

	async function setHidePreview(enabled: boolean) {
		await updateOp.run({ isHidePreviewOn: enabled });
	}

	async function setSenderScreener(enabled: boolean) {
		await updateOp.run({ isSenderScreenerOn: enabled });
	}

	async function setMarkReadPolicy(policy: PostboxMarkReadPolicy) {
		await updateOp.run({ markReadPolicy: policy });
	}

	async function setTrashAutoPurgeDays(days: PostboxTrashAutoPurgeDays) {
		await updateOp.run({ trashAutoPurgeDays: days });
	}

	async function setDailyBriefEmail(value: {
		enabled: boolean;
		minute: number;
		utcOffsetMinutes: number;
	}) {
		await updateOp.run({ dailyBriefEmail: value });
	}

	return {
		autoAdvance,
		writingSuggestions,
		autoSummarize,
		replyDefault,
		density,
		viewMode,
		readingPane,
		listWidth,
		listHeight,
		inboxMode,
		sortOrder,
		sendSound,
		undoSendSeconds,
		notifyAbout,
		badgeNonPeople,
		quietHours,
		hidePreview,
		senderScreener,
		markReadPolicy,
		trashAutoPurgeDays,
		dailyBriefEmail,
		isLoading,
		setAutoAdvance,
		setWritingSuggestions,
		setAutoSummarize,
		setReplyDefault,
		setDensity,
		setViewMode,
		setReadingPane,
		setListSize,
		setInboxMode,
		setSortOrder,
		setSendSound,
		setUndoSendSeconds,
		setNotifyAbout,
		setBadgeNonPeople,
		setQuietHours,
		setHidePreview,
		setSenderScreener,
		setMarkReadPolicy,
		setTrashAutoPurgeDays,
		setDailyBriefEmail,
		isSaving: updateOp.isLoading,
	};
}
