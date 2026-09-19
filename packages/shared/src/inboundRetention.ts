/**
 * How long the shared inbox keeps the FILES belonging to a received message —
 * the sealed raw `.eml` and the attachment blobs captured out of it.
 *
 * Shared so the admin form's options, the Convex validator and the sweep's
 * horizon cannot diverge: a choice the UI offers that the validator rejects is
 * a setting nobody can save.
 *
 * There is deliberately no `0` / "forever" option. Unbounded storage growth on
 * a route any sender can reach is the defect this horizon exists to close, and
 * an arbitrary day count is a footgun — the same reasoning the mail
 * trash-auto-purge choices are a closed set for.
 *
 * Only the bytes age out. The message row, its sender, subject, bodies,
 * attachment metadata and verdicts are all retained past the horizon.
 */
export const INBOUND_RAW_RETENTION_DAY_CHOICES = [30, 90, 180, 365] as const;

export type InboundRawRetentionDays = (typeof INBOUND_RAW_RETENTION_DAY_CHOICES)[number];

/** Applied when `instanceSettings.inboundRawRetentionDays` is unset. */
export const DEFAULT_INBOUND_RAW_RETENTION_DAYS = 90;
