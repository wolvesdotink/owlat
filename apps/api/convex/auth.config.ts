import { getAuthConfigProvider } from '@convex-dev/better-auth/auth-config';
import type { AuthConfig } from 'convex/server';

// Convex instance auth configuration — MUST live at `convex/auth.config.ts`,
// exactly. This is a magic filename the Convex CLI evaluates at push time to
// register JWT providers; it is not a regular module. It was once moved into
// `auth/config.ts` during a domain-folder reorg, which silently pushed ZERO
// providers to fresh deployments: BetterAuth sessions kept working, but every
// JWT was rejected (`NoAuthProvider`) and every authed query threw
// "Not authenticated". Do not move or rename it again.
export default {
	providers: [getAuthConfigProvider()],
} satisfies AuthConfig;
