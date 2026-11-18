/**
 * The query key a link uses to open a mail settings page on one mailbox:
 * `/dashboard/preferences/filters?settingsMailbox=<id>`.
 *
 * The page reads it once, as a seed for the mailbox choice the settings pages
 * share, and never follows it afterwards, so a later link without it (the
 * Settings sidebar, Back) cannot move an open draft onto another mailbox. It
 * must not be `mailbox`: `usePostboxMailbox` writes that one into the Postbox's
 * own selection.
 */
export const SETTINGS_MAILBOX_QUERY = 'settingsMailbox';
