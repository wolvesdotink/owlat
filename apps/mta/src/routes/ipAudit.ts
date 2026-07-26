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

function numericParam(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === '') return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function metricsFromQuery(query: Record<string, string | undefined>): DelistingMetrics {
	const metrics: DelistingMetrics = {};
	const hardBouncePct = numericParam(query['hardBouncePct']);
	const complaintPct = numericParam(query['complaintPct']);
	const sends24h = numericParam(query['sends24h']);
	const volumeRampMultiplier = numericParam(query['volumeRampMultiplier']);
	const sendingDays = numericParam(query['sendingDays']);
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

	app.use('*', masterKeyAuth(config));

	// Provider guidance for the installer. Static copy: no probe, no credentials.
	app.get('/provider-note/:provider', (c) =>
		c.json({ note: installerProviderNote(c.req.param('provider')) })
	);

	app.get('/', async (c) => {
		const metrics = metricsFromQuery(c.req.query());
		const records = await Promise.all(
			configuredAuditIps(config).map((ip) => getIpAuditRecord(redis, ip))
		);
		return c.json({
			audits: records
				.filter((record): record is IpAuditRecord => record !== null)
				.map((record) => decorate(record, config, metrics)),
		});
	});

	// Force a fresh sweep. Advisory only: it never changes pool eligibility.
	app.post('/run', async (c) => {
		const metrics = metricsFromQuery(c.req.query());
		const records = await runIpAuditSweep(redis, config, defaultIpAuditDeps());
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
