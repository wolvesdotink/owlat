/**
 * Pre-flight IP audit API (master-key protected).
 *
 * Serves the stored audit for each configured sending address, with the
 * delisting assistant attached to any listing that was found. Recent sending
 * metrics are supplied by the caller (Convex owns those numbers) so the "likely
 * cause" is drawn from our own data rather than guessed; without them the
 * guidance falls back to the zone's generic cause and nothing breaks.
 */

import { Hono } from 'hono';
import type Redis from 'ioredis';
import {
	delistingGuidanceForFindings,
	type DelistingMetrics,
} from '@owlat/shared/ipAuditDelisting';
import { installerProviderNote } from '@owlat/shared/ipAuditProviders';
import { masterKeyAuth } from '../auth/masterKeyAuth.js';
import type { MtaConfig } from '../config.js';
import { resolveEhloForIp } from '../config.js';
import {
	configuredAuditIps,
	defaultIpAuditDeps,
	getIpAuditRecord,
	runIpAuditSweep,
	type IpAuditRecord,
} from '../scaling/ipAudit.js';

/** How long a stored sweep counts as fresh enough to answer `POST /run` with. */
const RUN_COALESCE_WINDOW_MS = 5 * 60 * 1000;

function numericParam(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === '') return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** Percentages are quoted verbatim in a removal request: keep them in range. */
function percentParam(value: string | undefined): number | undefined {
	const parsed = numericParam(value);
	return parsed === undefined ? undefined : Math.min(100, Math.max(0, parsed));
}

/** A negative count is nonsense in operator-facing copy: treat it as absent. */
function countParam(value: string | undefined): number | undefined {
	const parsed = numericParam(value);
	return parsed === undefined || parsed < 0 ? undefined : parsed;
}

function metricsFromQuery(query: Record<string, string | undefined>): DelistingMetrics {
	const metrics: DelistingMetrics = {};
	const hardBouncePct = percentParam(query['hardBouncePct']);
	const complaintPct = percentParam(query['complaintPct']);
	const sends24h = countParam(query['sends24h']);
	const volumeRampMultiplier = countParam(query['volumeRampMultiplier']);
	const sendingDays = countParam(query['sendingDays']);
	if (hardBouncePct !== undefined) metrics.hardBouncePct = hardBouncePct;
	if (complaintPct !== undefined) metrics.complaintPct = complaintPct;
	if (sends24h !== undefined) metrics.sends24h = sends24h;
	if (volumeRampMultiplier !== undefined) metrics.volumeRampMultiplier = volumeRampMultiplier;
	if (sendingDays !== undefined) metrics.sendingDays = sendingDays;
	return metrics;
}

function decorate(record: IpAuditRecord, config: MtaConfig, metrics: DelistingMetrics) {
	return {
		...record,
		delisting: delistingGuidanceForFindings(record.findings, {
			ip: record.ip,
			ehlo: resolveEhloForIp(config, record.ip),
			metrics,
		}),
	};
}

export function createIpAuditRoutes(redis: Redis, config: MtaConfig) {
	const app = new Hono();

	// A sweep opens a TCP/25 connection per target MX per address FROM THE SENDING
	// IP, so it is not something a caller may loop on. Coalesce concurrent runs
	// and serve a recent sweep instead of re-probing, in the shape of
	// getSmtpReachability.
	let inFlightSweep: Promise<IpAuditRecord[]> | undefined;

	const storedRecords = async (): Promise<IpAuditRecord[]> => {
		const records = await Promise.all(
			configuredAuditIps(config).map((ip) => getIpAuditRecord(redis, ip))
		);
		return records.filter((record): record is IpAuditRecord => record !== null);
	};

	const sweepOrReuse = async (): Promise<IpAuditRecord[]> => {
		const ips = configuredAuditIps(config);
		const stored = await storedRecords();
		const fresh =
			ips.length > 0 &&
			stored.length === ips.length &&
			stored.every((record) => Date.now() - record.checkedAt < RUN_COALESCE_WINDOW_MS);
		if (fresh) return stored;
		if (inFlightSweep) return inFlightSweep;
		inFlightSweep = runIpAuditSweep(redis, config, defaultIpAuditDeps());
		try {
			return await inFlightSweep;
		} finally {
			inFlightSweep = undefined;
		}
	};

	app.use('*', masterKeyAuth(config));

	// Provider guidance for the installer. Static copy: no probe, no credentials.
	app.get('/provider-note/:provider', (c) =>
		c.json({ note: installerProviderNote(c.req.param('provider')) })
	);

	app.get('/', async (c) => {
		const metrics = metricsFromQuery(c.req.query());
		const records = await storedRecords();
		return c.json({ audits: records.map((record) => decorate(record, config, metrics)) });
	});

	// Request a fresh sweep. Advisory only: it never changes pool eligibility, and
	// a sweep from the last few minutes is served as-is rather than repeated.
	app.post('/run', async (c) => {
		const metrics = metricsFromQuery(c.req.query());
		const records = await sweepOrReuse();
		return c.json({ audits: records.map((record) => decorate(record, config, metrics)) });
	});

	app.get('/:ip', async (c) => {
		const ip = c.req.param('ip');
		const record = await getIpAuditRecord(redis, ip);
		if (!record) return c.json({ error: 'No audit recorded for this address yet' }, 404);
		return c.json(decorate(record, config, metricsFromQuery(c.req.query())));
	});

	return app;
}
