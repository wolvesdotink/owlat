/**
 * The suppression sunset's day windows: the deployment-wide defaults and the
 * floor below which a configured window is rejected.
 *
 * Shared so the settings form and the Convex backend cannot drift: a minimum
 * the form offers that `setSunsetPolicy` rejects is a value nobody can save,
 * and a minimum the form enforces above the backend's hides values it would
 * accept. The decision logic itself stays in
 * `apps/api/convex/contacts/sunsetPolicy.ts`.
 */

/** Quiet days before a contact moves onto the re-engagement track. */
export const SUNSET_REENGAGE_AFTER_DAYS = 180;

/** Quiet days before a contact is auto-suppressed. */
export const SUNSET_SUPPRESS_AFTER_DAYS = 270;

/** Lower bound on a configured window. Below this the policy is treated as invalid. */
export const SUNSET_MIN_WINDOW_DAYS = 30;
