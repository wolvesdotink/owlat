/**
 * HTTP layer barrel: the composition root imports `createApp` from here and
 * serves the returned Hono app with `@hono/node-server`.
 */
export { createApp, type CreateAppOptions } from './app.js';
export { DEFAULT_MAX_BODY_BYTES } from './body.js';
export {
	CACHE_ANSWER,
	CACHE_BULK,
	CACHE_IMMUTABLE,
	CACHE_NONE,
	entityTag,
	matchesIfNoneMatch,
} from './cache.js';
export { HttpError, toErrorResponse, type ErrorBody } from './errors.js';
export { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from './params.js';
export type { LeafIndexLookup } from './routes/log.js';
export type { EvidenceEntry, EvidencePage } from './routes/subject.js';
