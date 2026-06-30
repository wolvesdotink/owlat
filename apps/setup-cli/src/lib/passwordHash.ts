/**
 * BetterAuth-compatible password hashing.
 *
 * Re-exported from `@owlat/shared/passwordHash` so the CLI and the web setup
 * wizard (apps/web/server/api/setup/apply.post.ts) share one implementation.
 * Round-trip compatibility with the real `@better-auth/utils` is verified by
 * passwordHash.test.ts in this package.
 */

export { hashPassword, verifyPassword } from '@owlat/shared/passwordHash';
