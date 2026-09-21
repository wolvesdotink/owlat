/**
 * The registry's HTTPS API (plan §8.2, §9.1) as a pure factory.
 *
 * `createApp` builds a Hono app over the {@link RegistryServices} contracts and
 * returns it. It never listens, never reads configuration and never opens a
 * store: the composition root decides the port, the TLS termination, the
 * database and the clock, and hands this function the two services. That is
 * what lets the whole API be tested against in-memory fakes at full fidelity,
 * and it is why an operator can mount it inside another server if they want to.
 *
 * Cross-cutting decisions live here rather than in the route modules:
 *
 * - **Errors**: one `onError` renders every failure as `{ error }`. Routes
 *   throw; nothing formats an error body by hand. The thrown value stays on
 *   `c.error` for an outer mount, which is where the operator's pino logger
 *   picks up the message the caller is not told.
 * - **CORS**: wide open. Every endpoint here is public, anonymous, cacheable
 *   data and there are no cookies or credentials to protect — `*` is the honest
 *   description of the API, and without it no browser-side explorer or client
 *   library can read it.
 * - **`nosniff`**: served content includes a caller-supplied zone file and
 *   caller-supplied attestation bodies echoed back as evidence. None of it
 *   should ever be interpreted as something other than its declared type.
 * - **Caching**: each route states its own `Cache-Control` (see `cache.ts`);
 *   anything that states none — every error answer included — is `no-store`, so
 *   a new route cannot become cacheable by forgetting.
 * - **Rate limiting**: spec 08 §8.2 permits limits and requires that they be
 *   published, but what they are is an operator's decision, not this layer's.
 *   {@link CreateAppOptions.rateLimit} takes a middleware and runs it before
 *   every route, submission included; an operator who would rather limit in
 *   front of the process can equally mount this app inside an outer Hono.
 *   `/healthz` is inside that seam and is a **liveness** probe only: it answers
 *   without touching the log or the aggregator, so it says the process is up,
 *   never that the store is readable.
 */
import { cors } from 'hono/cors';
import { Hono, type MiddlewareHandler } from 'hono';
import type { RegistryServices } from '../contracts.js';
import { DEFAULT_MAX_BODY_BYTES } from './body.js';
import { CACHE_NONE } from './cache.js';
import { toErrorResponse } from './errors.js';
import { registerAttestationRoutes } from './routes/attestations.js';
import { registerDistributionRoutes } from './routes/distribution.js';
import { registerLogRoutes, type LeafIndexLookup } from './routes/log.js';
import { registerSubjectRoutes } from './routes/subject.js';

export interface CreateAppOptions {
	/**
	 * The log's clock, as an RFC 3339 UTC instant. Injected so submission
	 * receipt times are deterministic under test; defaults to the wall clock.
	 */
	now?: () => string;
	/** Hard ceiling on a submitted body, in bytes. */
	maxBodyBytes?: number;
	/**
	 * Leaf hash to leaf index, backing the `?hash=` form of the inclusion-proof
	 * endpoint that spec 05 §5.4 specifies. The frozen {@link RegistryLog}
	 * contract carries no such lookup, so the composition root supplies one over
	 * its store; without it that form answers 501 and only `?index=` works.
	 */
	leafIndex?: LeafIndexLookup;
	/**
	 * Optional rate-limiting middleware, applied to every request before the
	 * routes. Whatever it publishes about its limits is the operator's to
	 * document (spec 08 §8.2).
	 */
	rateLimit?: MiddlewareHandler;
}

function defaultNow(): string {
	return new Date().toISOString();
}

/**
 * Build the API over `services`. Pure: calling it twice yields two independent
 * apps over the same services, and nothing happens until a request arrives.
 */
export function createApp(services: RegistryServices, options: CreateAppOptions = {}): Hono {
	const app = new Hono();
	const now = options.now ?? defaultNow;
	const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

	app.use('*', cors({ origin: '*', allowMethods: ['GET', 'HEAD', 'POST', 'OPTIONS'] }));
	app.use('*', async (c, next) => {
		await next();
		c.header('X-Content-Type-Options', 'nosniff');
		if (c.res.headers.get('cache-control') === null) c.header('cache-control', CACHE_NONE);
	});
	if (options.rateLimit !== undefined) app.use('*', options.rateLimit);

	app.get('/healthz', (c) => c.json({ ok: true }));

	registerAttestationRoutes(app, { log: services.log, now, maxBodyBytes });
	registerSubjectRoutes(app, { scores: services.scores, log: services.log });
	registerLogRoutes(app, { log: services.log, leafIndex: options.leafIndex });
	registerDistributionRoutes(app, services.scores);

	app.notFound((c) => c.json({ error: 'not found' }, 404));
	app.onError((err, c) => {
		const { status, body } = toErrorResponse(err);
		return c.json(body, status);
	});

	return app;
}
