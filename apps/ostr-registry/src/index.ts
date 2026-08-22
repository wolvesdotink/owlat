/**
 * OSTR registry node entry point: the composition root (plan §4.1, §8, §12.1).
 *
 * Everything impure lives here and only here. The log, the aggregator and the
 * HTTP app are written against injected clocks, resolvers and stores precisely
 * so that this file is the single place that reads the environment, opens
 * SQLite files, resolves DNS, starts a listener and — the one that matters for
 * reproducibility — reads the clock.
 *
 * The determinism claim is about injection, not about greppability: every clock
 * in this workspace is a constructor or function argument, and this is the only
 * file that CALLS a wall clock unconditionally or arms a timer. Two modules
 * (`http/app.ts`, `keys/dns.ts`) name a wall-clock default for the argument they
 * take, so that a mis-wiring degrades to real time instead of crashing; the
 * composition root passes its own clock to both, and a test passes a counter. A
 * replay of the same submissions through the same modules therefore produces the
 * same tree, the same heads and the same snapshot bytes.
 *
 * Two schedules run, deliberately independent:
 *
 * - **STH publication** (`OSTR_STH_INTERVAL_SECONDS`) signs a head whether or
 *   not anything was appended. Silence and a stalled log must be
 *   distinguishable (spec 05 §5.3), and only a head published on a cadence
 *   makes them so.
 * - **Refresh** (`OSTR_REFRESH_INTERVAL_SECONDS`) recomputes every score from
 *   the log and re-materializes the zone, the snapshot and the diff feed.
 *
 * Neither is allowed to overlap itself: a refresh that runs longer than its
 * cadence must queue behind its predecessor rather than run two scoring passes
 * over one store.
 *
 * {@link startRegistry} returns the running node instead of hiding it, so the
 * end-to-end test boots this exact stack on an ephemeral port and drives the
 * two schedules by hand. There is no test-only wiring: what the test exercises
 * is what runs in production, minus the timers.
 */
import { resolveTxt } from 'node:dns/promises';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import type { MiddlewareHandler } from 'hono';
import pino, { type Logger } from 'pino';
import type { SignedTreeHead } from '@owlat/ostr-core';
import { MaterializedScoreIndex } from './aggregator/index.js';
import { loadConfig, type OstrRegistryConfig } from './config.js';
import type { KeyDirectory, RegistryLog, ScoreIndex } from './contracts.js';
import { createApp, toErrorResponse } from './http/index.js';
import {
	AllowlistKeyDirectory,
	DnsKeyDirectory,
	KeyLookupOverloadError,
	type ResolveTxt,
} from './keys/index.js';
import { SqliteRegistryLog } from './log/index.js';

/** Grace period for in-flight requests before a shutdown stops waiting. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * A running node: the services, the listener, and the two schedules' triggers.
 *
 * The two services are typed as their frozen contracts plus exactly what this
 * root needs on top — `contracts.ts` exists so the storage choice does not leak
 * (plan D1), and the node's public surface is where that leak would matter.
 */
export interface RegistryNode {
	readonly log: RegistryLog & {
		/** Leaf hash to leaf index, backing the `?hash=` inclusion-proof form. */
		indexOfLeafHash(hash: string): Promise<number | null>;
		close(): void;
	};
	readonly scores: ScoreIndex & { close(): void };
	readonly server: ServerType;
	/** The port actually bound — the configured one, or the OS's pick when it was 0. */
	readonly port: number;
	/** `http://<listenAddress>:<port>`, for a client that wants to talk to this node. */
	readonly baseUrl: string;
	/** Publish a signed tree head now, at this node's clock. */
	publishHead(): Promise<SignedTreeHead>;
	/** Recompute scores, zone, snapshot and diff feed now, at this node's clock. */
	refresh(): Promise<{ subjects: number; asOf: string }>;
	/** Stop the timers, drain the listener, close both databases. Idempotent. */
	stop(): Promise<void>;
}

export interface StartRegistryOptions {
	/**
	 * Key discovery. Defaults to DNS (plus the configured bootstrap allowlist);
	 * a test passes a {@link StaticKeyDirectory} and never resolves anything.
	 */
	keys?: KeyDirectory;
	logger?: Logger;
	/** RFC 3339 UTC clock for received-at, head and refresh instants. */
	now?: () => string;
	/** False boots the node without the two schedules — the test's mode. */
	startTimers?: boolean;
}

function wallClock(): string {
	return new Date().toISOString();
}

/**
 * The production key directory: DNS discovery, wrapped in the §4.2 allowlist
 * when one is configured. Unset allowlist means open submission, which is the
 * end state; a listed one is an editorial trust anchor and is meant to sunset.
 *
 * The resolver is a parameter with a production default so this decision — the
 * one that says whether a deployment enforces the allowlist or resolves openly —
 * can be exercised without a real zone.
 */
export function defaultKeyDirectory(
	config: OstrRegistryConfig,
	resolve: ResolveTxt = resolveTxt
): KeyDirectory {
	const dns = new DnsKeyDirectory({ resolveTxt: resolve });
	if (config.bootstrapObservers === null) return dns;
	return new AllowlistKeyDirectory(config.bootstrapObservers, dns);
}

/**
 * A node-wide ceiling on submissions per minute, as the middleware `createApp`
 * takes (spec 08 §8.2 permits limits and requires that they be published).
 *
 * Node-wide and not per-IP on purpose: the resource this protects is a third
 * party's nameservers, not this node's CPU. A submission naming an unseen
 * observer costs an outbound DNS lookup, the observer field is attacker-chosen,
 * and the source address of a flood is the one part of it that is free to
 * forge — so a per-IP bucket would bound nothing that matters here while a
 * node-wide valve bounds exactly it. Reads are never limited: they touch no
 * third party and they are the surface monitors depend on.
 *
 * Fixed window rather than a token bucket because the answer must be a number
 * an operator can publish: "at most N submissions in any clock minute".
 */
export function submitRateLimit(
	perMinute: number,
	nowMs: () => number = Date.now
): MiddlewareHandler {
	let windowStart = 0;
	let count = 0;
	return async (c, next) => {
		if (c.req.method !== 'POST') return next();
		const current = Math.floor(nowMs() / 60_000);
		if (current !== windowStart) {
			windowStart = current;
			count = 0;
		}
		count += 1;
		if (count > perMinute) {
			c.header('retry-after', String(60 - Math.floor((nowMs() % 60_000) / 1000)));
			return c.json({ error: 'submission rate limit exceeded' }, 429);
		}
		return next();
	};
}

/**
 * A repeating task that cannot overlap itself and cannot kill the process.
 *
 * A throw inside a `setInterval` callback is an unhandled rejection, and an
 * hourly schedule that dies on one transient error is a node that silently
 * stops publishing while still serving. Both schedules here are idempotent
 * retries by nature — the next tick redoes the whole job — so a failed run is
 * logged and dropped.
 *
 * `Promise.resolve().then(task)` rather than `task()` so that a SYNCHRONOUS
 * throw is caught by the same chain. Called directly, it would escape the whole
 * expression, leave `running` latched at true and permanently kill the schedule
 * while the node kept serving — the stalled-log condition spec 05 §5.3 exists to
 * make visible, arriving invisibly.
 */
export function schedule(
	intervalSeconds: number,
	logger: Logger,
	name: string,
	task: () => Promise<unknown>
): NodeJS.Timeout {
	let running = false;
	return setInterval(() => {
		if (running) {
			logger.warn({ task: name }, 'registry: previous run still in progress; skipping this tick');
			return;
		}
		running = true;
		void Promise.resolve()
			.then(task)
			.catch((error: unknown) => {
				logger.error({ err: error, task: name }, 'registry: scheduled task failed');
			})
			.finally(() => {
				running = false;
			});
	}, intervalSeconds * 1000);
}

/**
 * Resolve once the listener is bound, with the port the OS actually gave us.
 *
 * The boot handler is swapped for a logging one as soon as the promise settles.
 * Left attached, the first post-boot server error would be swallowed into an
 * already-resolved promise — no log line, no restart signal — and it would
 * consume the only `error` listener, so the second one crashes the process with
 * a bare EventEmitter trace instead of a pino line.
 */
async function listen(
	fetchHandler: (request: Request) => Response | Promise<Response>,
	config: OstrRegistryConfig,
	logger: Logger
): Promise<{ server: ServerType; port: number }> {
	return new Promise((resolve, reject) => {
		const server = serve(
			{ fetch: fetchHandler, port: config.port, hostname: config.listenAddress },
			(info) => {
				server.off('error', reject);
				server.on('error', (error: unknown) => {
					logger.error({ err: error }, 'registry: server error');
				});
				resolve({ server, port: info.port });
			}
		);
		server.once('error', reject);
	});
}

/**
 * Boot the whole node: open the stores, wire the API, bind the port and start
 * the schedules.
 *
 * The startup publication is conditional on purpose. A restart must not mint a
 * head that commits to nothing new — a crash loop would otherwise fill the head
 * table — but it must also not leave leaves that were appended before the crash
 * uncovered until the next tick, because nothing can be proven about them
 * meanwhile. So: publish only when the log has grown past its latest head.
 */
export async function startRegistry(
	config: OstrRegistryConfig,
	options: StartRegistryOptions = {}
): Promise<RegistryNode> {
	const logger = options.logger ?? pino({ name: 'owlat-ostr-registry' });
	const now = options.now ?? wallClock;

	mkdirSync(config.dbDir, { recursive: true });
	const log = new SqliteRegistryLog({
		dbPath: join(config.dbDir, 'log.sqlite'),
		logId: config.logId,
		privateKeyBase64: config.logPrivateKeyBase64,
		keys: options.keys ?? defaultKeyDirectory(config),
		mmdSeconds: config.mmdSeconds,
	});

	let scores: MaterializedScoreIndex;
	try {
		scores = new MaterializedScoreIndex({
			dbPath: join(config.dbDir, 'scores.sqlite'),
			log,
			aggregatorPrivateKeyBase64: config.aggregatorPrivateKeyBase64,
			zone: { origin: config.zoneOrigin, refBaseUrl: config.refBaseUrl },
			logger,
		});
	} catch (error) {
		// The log holds the writer lock; leaving it held after a failed boot
		// would make the next start fail for the wrong reason.
		log.close();
		throw error;
	}

	const app = createApp(
		{ log, scores },
		{
			now,
			leafIndex: (hash) => log.indexOfLeafHash(hash),
			...(config.submitRatePerMinute === null
				? {}
				: { rateLimit: submitRateLimit(config.submitRatePerMinute) }),
		}
	);
	// The API renders its own errors and must keep doing so; what it cannot do
	// is log, because a library that logs decides an operator's format for them.
	// Replacing the handler with the same renderer plus a pino line is the seam
	// `http/app.ts` describes, and it keeps every served body byte-identical.
	app.onError((error, c) => {
		// Key discovery refusing a lookup because too many are already in flight
		// is a load condition, not a fault: the caller's submission is fine and
		// retrying it later will work. Answering 503 with `Retry-After` is what
		// says so, and deciding that is the composition root's job — the key
		// directory must not know that an HTTP layer exists, and `http/errors.ts`
		// only knows about its own vocabulary.
		if (error instanceof KeyLookupOverloadError) {
			logger.warn({ err: error, path: c.req.path }, 'registry: key lookups saturated');
			c.header('retry-after', '5');
			return c.json({ error: 'key discovery is saturated; retry shortly' }, 503);
		}
		const { status, body } = toErrorResponse(error);
		if (status >= 500) {
			logger.error(
				{ err: error, method: c.req.method, path: c.req.path },
				'registry: request failed'
			);
		}
		return c.json(body, status);
	});

	const publishHead = (): Promise<SignedTreeHead> => log.publishHead(now());
	const refresh = (): Promise<{ subjects: number; asOf: string }> => scores.refresh(now());

	let server: ServerType;
	let port: number;
	try {
		const head = await log.head();
		if (head === null || head.treeSize < (await log.size())) await publishHead();
		// The port is bound LAST, so the first request served reads fresh scores
		// rather than an empty index. On a log with real volume that leaves the
		// process up with a closed port for the length of one scoring pass, which
		// an orchestrator cannot tell from a hung start — hence this line, and the
		// startup note in the README.
		logger.info({ size: await log.size() }, 'registry: scoring the log before binding the port');
		await refresh();
		({ server, port } = await listen(app.fetch, config, logger));
	} catch (error) {
		// Same reason as above, one failure later: a port already in use must not
		// leave this process holding the log's writer lock, or the operator's
		// second attempt fails with a message about the lock instead of the port.
		scores.close();
		log.close();
		throw error;
	}

	const timers =
		options.startTimers === false
			? []
			: [
					schedule(config.sthIntervalSeconds, logger, 'sth', publishHead),
					schedule(config.refreshIntervalSeconds, logger, 'refresh', refresh),
				];

	// The in-flight shutdown is memoized rather than guarded by a boolean: a
	// second caller must await the SAME drain, not return from a flag that was
	// set before the first await. A SIGTERM racing an explicit shutdown would
	// otherwise let the caller proceed — deleting the data directory, say —
	// while the listener is still draining and both SQLite handles are open.
	let stopping: Promise<void> | null = null;
	const doStop = async (): Promise<void> => {
		for (const timer of timers) clearInterval(timer);
		await closeServer(server);
		scores.close();
		log.close();
	};
	const stop = (): Promise<void> => (stopping ??= doStop());

	logger.info(
		{
			port,
			logId: config.logId,
			zoneOrigin: config.zoneOrigin,
			dbDir: config.dbDir,
			bootstrapObservers: config.bootstrapObservers?.length ?? null,
			submitRatePerMinute: config.submitRatePerMinute,
		},
		'registry: listening'
	);
	return {
		log,
		scores,
		server,
		port,
		baseUrl: `http://${config.listenAddress}:${port}`,
		publishHead,
		refresh,
		stop,
	};
}

/**
 * Stop accepting connections and wait for the in-flight ones, but not forever:
 * an idle keep-alive connection would otherwise hold the process open past any
 * orchestrator's patience, and a SIGTERM that does not terminate becomes a
 * SIGKILL in the middle of a write.
 */
async function closeServer(server: ServerType): Promise<void> {
	await new Promise<void>((resolve) => {
		const forced = setTimeout(() => {
			resolve();
		}, SHUTDOWN_TIMEOUT_MS);
		forced.unref();
		server.close(() => {
			clearTimeout(forced);
			resolve();
		});
		if ('closeIdleConnections' in server) server.closeIdleConnections();
	});
}

export async function main(): Promise<void> {
	// Configuration first, logger second: `LOG_LEVEL` is config like every other
	// variable, and config.ts is where the process reads its environment.
	const config = loadConfig();
	const logger = pino({ name: 'owlat-ostr-registry', level: config.logLevel });
	const node = await startRegistry(config, { logger });

	const shutdown = (signal: string): void => {
		logger.info({ signal }, 'registry: shutting down');
		void node.stop().then(
			() => process.exit(0),
			(error: unknown) => {
				logger.error({ err: error }, 'registry: shutdown failed');
				process.exit(1);
			}
		);
	};
	process.on('SIGTERM', () => {
		shutdown('SIGTERM');
	});
	process.on('SIGINT', () => {
		shutdown('SIGINT');
	});
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
	void main().catch((error: unknown) => {
		// The logger may not exist yet — a configuration error throws before it
		// is built — so this one line goes straight to stderr.
		console.error('ostr-registry: fatal startup error', error);
		process.exit(1);
	});
}

export { loadConfig, type OstrRegistryConfig } from './config.js';
