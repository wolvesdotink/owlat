import { fileURLToPath } from 'node:url';

/**
 * Where the signed-in browser state lives, as ONE absolute path.
 *
 * The setup project writes it and `playwright.config.ts` hands it to every
 * authenticated project. They used to name it separately as `.auth/user.json`,
 * which Playwright resolves against the CWD — so the two agreed only while the
 * suite was run from `apps/web`, and silently disagreed otherwise: the tests
 * then loaded a STALE file from an earlier run. That is not a clean failure,
 * because `/dev/reset` wipes users but not BetterAuth session rows, so the old
 * cookie still authenticates — as a user who no longer exists. The app renders
 * its shell, every query comes back empty, and 35 specs fail on missing content
 * with nothing pointing at the cause.
 */
export const STORAGE_STATE = fileURLToPath(new URL('.auth/user.json', import.meta.url));
