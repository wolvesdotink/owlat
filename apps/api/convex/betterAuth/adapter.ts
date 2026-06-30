import { createApi } from '@convex-dev/better-auth';
import schema from './schema';
import { createAuthOptions } from '../auth/auth';

// Export adapter functions using the local schema with organization support
export const { create, findOne, findMany, updateOne, updateMany, deleteOne, deleteMany } =
	createApi(schema, createAuthOptions);
