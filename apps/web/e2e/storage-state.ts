import { fileURLToPath } from 'node:url';

/**
 * Where the signed-in browser state lives, as ONE absolute path.
 *
 * The setup project writes it and `playwright.config.ts` hands it to every
 * authenticated project. They used to name it separately as `.auth/user.json`,
 * which Playwright resolves against the CWD — so the two agreed only while the
 * suite was run from `apps/web`, and silently disagreed otherwise: the tests
 * then loaded a STALE file from an earlier run. That was not a clean failure,
 * because `/dev/reset` then wiped users but not BetterAuth session rows, so the
 * old cookie still authenticated — as a user who no longer existed. The app
 * rendered its shell, every query came back empty, and 35 specs failed on
 * missing content with nothing pointing at the cause.
 *
 * The CI report scan reads this file too, for the cookie values it must never
 * find in the public report (scan-report-secrets.ts, `--storage-state`).
 */
export const STORAGE_STATE = fileURLToPath(new URL('.auth/user.json', import.meta.url));
