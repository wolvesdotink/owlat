import { createApi } from '@convex-dev/better-auth';
import schema from './schema';
import { createAuthOptions } from '../auth/auth';

// Export adapter functions using the local schema with organization support.
// `incrementOne` comes from patches/@convex-dev%2Fbetter-auth@0.12.6.patch,
// which adapts the adapter to Better Auth 1.7: the client adapter calls it for
// atomic counter updates (two-factor lockout, backup codes), so it must stay
// exported or those calls fail at runtime.
export const {
	create,
	findOne,
	findMany,
	updateOne,
	incrementOne,
	updateMany,
	deleteOne,
	deleteMany,
} = createApi(schema, createAuthOptions);
