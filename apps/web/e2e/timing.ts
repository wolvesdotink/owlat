/**
 * How long the setup waits on /welcome for the welcome stamp to settle.
 *
 * welcome.vue retries a failed `markWelcomed`, and a run settles (committed, or
 * given up with a note on screen) within `welcomeStampWorstCaseMs()` in
 * app/lib/welcomeStamp.ts: 88.4 s when every attempt waits out the auth wait
 * and the send deadline. Waiting less would fail a recovery that was still on
 * track. This is that figure plus room for the commit's round trip.
 *
 * A plain constant, because Playwright cannot resolve the app's `~` imports;
 * app/lib/__tests__/welcomeStampTiming.test.ts keeps it at or above the app's figure.
 */
export const WELCOME_STAMP_SETTLE_MS = 95_000;

/** The setup's budget before the welcome stamp: seed, sign-in and redirect. */
export const SETUP_BEFORE_STAMP_MS = 70_000;
