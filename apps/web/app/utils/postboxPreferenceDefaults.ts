/**
 * What the Preferences controls outside the Reading card read as for someone
 * who never saved them: the value `usePostboxSettings` resolves an unset
 * settings row to. Each card compares against this for its "changed from
 * default" marker and writes it back on Reset.
 *
 * The notification scope is not here: its default depends on whether smart
 * categories are live, so it comes from `defaultPostboxNotifyAbout`.
 *
 * Option-backed values come from their own module's default; the switches have
 * none, so theirs are stated here, and
 * `__tests__/postboxPreferenceDefaults.test.ts` pins every entry to what
 * `usePostboxSettings` resolves an empty row to.
 */
import {
	resolveAttachmentShareExpiryDays,
	type AttachmentShareExpiryDays,
} from '@owlat/shared/attachmentShares';
import type { PostboxQuietHours } from './postboxQuietHours';
import { POSTBOX_QUIET_HOURS_DEFAULT } from './postboxQuietHours';
import type { ShortcutPreset } from './shortcutPresets';
import { SHORTCUT_PRESET_DEFAULT } from './shortcutPresets';
import type { PostboxTrashAutoPurgeDays } from './postboxTrashRetention';
import { POSTBOX_TRASH_AUTO_PURGE_DEFAULT } from './postboxTrashRetention';
import type { PostboxUndoSendSeconds } from './postboxUndoSendWindow';
import { POSTBOX_UNDO_SEND_DEFAULT_SECONDS } from './postboxUndoSendWindow';

interface PostboxPreferenceValues {
	undoSendSeconds: PostboxUndoSendSeconds;
	trashAutoPurgeDays: PostboxTrashAutoPurgeDays;
	shareLinkExpiryDays: AttachmentShareExpiryDays;
	badgeNonPeople: boolean;
	hidePreview: boolean;
	senderScreener: boolean;
	codeAutoArchive: boolean;
	shortcutPreset: ShortcutPreset;
	quietHours: PostboxQuietHours;
}

export const POSTBOX_PREFERENCE_DEFAULTS: Readonly<PostboxPreferenceValues> = {
	undoSendSeconds: POSTBOX_UNDO_SEND_DEFAULT_SECONDS,
	trashAutoPurgeDays: POSTBOX_TRASH_AUTO_PURGE_DEFAULT,
	// The shared module keeps the 14-day fallback private; resolving "unset" is
	// the only way to read it, and the same way the backend does.
	shareLinkExpiryDays: resolveAttachmentShareExpiryDays(undefined),
	badgeNonPeople: true,
	hidePreview: false,
	senderScreener: false,
	codeAutoArchive: false,
	shortcutPreset: SHORTCUT_PRESET_DEFAULT,
	quietHours: POSTBOX_QUIET_HOURS_DEFAULT,
};

/** Quiet hours compare by window, not by object identity (`days` is a sorted mask). */
export function isSameQuietHours(a: PostboxQuietHours, b: PostboxQuietHours): boolean {
	return (
		a.enabled === b.enabled &&
		a.startMinute === b.startMinute &&
		a.endMinute === b.endMinute &&
		a.days.length === b.days.length &&
		a.days.every((day, index) => day === b.days[index])
	);
}
