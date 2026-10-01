import type { AuthContext } from '../../server.js';

/** The Hono env of a test app whose middleware sets `auth` the way the MTA's own does. */
export type AuthEnv = { Variables: { auth: AuthContext } };
