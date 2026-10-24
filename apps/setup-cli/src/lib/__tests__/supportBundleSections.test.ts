import { describe, expect, it } from 'vitest';
import { parseComposePs } from '@owlat/shared/containerHealth';
import {
	projectComposeServices,
	projectDoctorReport,
	projectMigrationState,
	projectRolloutRecord,
	projectServiceLog,
	versionToken,
} from '../supportBundleSections';
import type { DoctorReport } from '../doctorReport';

describe('projectComposeServices', () => {
	const row = (fields: Record<string, string>) => JSON.stringify(fields);

	it('reads both compose output shapes, sorted by service, stopped containers included', () => {
		const rows = [
			{
				Service: 'web',
				State: 'running',
				Status: 'Up 2 hours (healthy)',
				Health: 'healthy',
				Image: 'ghcr.io/wolvesdotink/web:0.6.16',
			},
			{
				Service: 'mta',
				State: 'exited',
				Status: 'Exited (1) 3 minutes ago',
				Image: 'ghcr.io/wolvesdotink/mta:0.6.16',
			},
		];
		const expected = [
			{
				service: 'mta',
				state: 'exited',
				status: 'Exited (1) 3 minutes ago',
				health: null,
				image: 'ghcr.io/wolvesdotink/mta:0.6.16',
				imageTag: '0.6.16',
			},
			{
				service: 'web',
				state: 'running',
				status: 'Up 2 hours (healthy)',
				health: 'healthy',
				image: 'ghcr.io/wolvesdotink/web:0.6.16',
				imageTag: '0.6.16',
			},
		];
		expect(projectComposeServices(parseComposePs(JSON.stringify(rows)))).toEqual(expected);
		expect(
			projectComposeServices(parseComposePs(rows.map((entry) => JSON.stringify(entry)).join('\n')))
		).toEqual(expected);
	});

	it('drops rows without a usable service name and fields that are not docker-shaped', () => {
		const services = projectComposeServices(
			parseComposePs(
				[
					row({ Service: '../escape', State: 'running' }),
					row({ Service: '', State: 'running' }),
					row({
						Service: 'web',
						State: 'running',
						Status: 'Up <script>',
						Image: 'not an image ref',
					}),
				].join('\n')
			)
		);
		expect(services).toEqual([
			{ service: 'web', state: 'running', status: null, health: null, image: null, imageTag: null },
		]);
	});
});

describe('versionToken', () => {
	it('keeps version-shaped tokens only', () => {
		expect(versionToken('0.6.16')).toBe('0.6.16');
		expect(versionToken(' "27.3.1" \n')).toBe('27.3.1');
		expect(versionToken('v2.29.7-desktop.1')).toBe('v2.29.7-desktop.1');
		expect(versionToken('Error: Cannot connect to the Docker daemon')).toBeNull();
		expect(versionToken('')).toBeNull();
		expect(versionToken(undefined)).toBeNull();
	});
});

describe('projectDoctorReport', () => {
	const report: DoctorReport = {
		schemaVersion: 1,
		command: 'doctor',
		generatedAt: '2026-10-24T10:00:00.000Z',
		ok: false,
		summary: { total: 2, passed: 1, failed: 1 },
		activeFeatures: ['campaigns'],
		checks: [
			{
				id: 'mta.ip_audit',
				subject: '192.0.2.10',
				component: 'mta',
				status: 'fail',
				severity: 'error',
				message: 'IP audit for 192.0.2.10: listed after a complaint from postmaster@example.net.',
				remediation: 'replace_or_delist_ip',
			},
			{
				id: 'env.required',
				subject: 'owner marcel@example.com',
				component: 'config',
				status: 'pass',
				severity: 'error',
				message: 'DEFAULT_FROM_EMAIL is set',
			},
		],
	};

	it('de-identifies embedded addresses and replaces a subject that is not an identifier', () => {
		const projected = projectDoctorReport(report);
		const text = JSON.stringify(projected);
		expect(text).not.toContain('postmaster');
		expect(text).not.toContain('marcel');
		expect(projected.checks[0]!.subject).toBe('192.0.2.10');
		expect(projected.checks[0]!.message).toMatch(/redacted-[0-9a-f]{12}@example\.net/);
		expect(projected.checks[1]!.subject).toMatch(/^redacted-[0-9a-f]{12}@example\.com$/);
		expect(projected.summary).toEqual(report.summary);
	});
});

describe('projectMigrationState', () => {
	const value = {
		deployedVersion: '0.6.16',
		migrations: [
			{
				migration: '0067_empty_retired_summaries',
				introducedIn: '0.6.10',
				state: 'failed',
				stalledAt: null,
				hasError: true,
				error: 'Document of marcel@example.com is invalid',
				cursor: 'secret-cursor',
				startedAt: 1,
				updatedAt: 2,
				completedAt: null,
				pageCount: 3,
				scannedCount: 300,
				changedCount: 12,
			},
			{ migration: 'not a migration', state: 'completed' },
			{ migration: '0068_seal_fact_keys', state: 'exploded' },
		],
		runner: {
			status: 'stopped',
			startedBy: 'user_marcel',
			startedAt: 1,
			updatedAt: 2,
			finishedAt: 3,
			stoppedMigration: '0067_empty_retired_summaries',
			stoppedError: 'Document of marcel@example.com is invalid',
			hasStoppedError: true,
		},
	};

	it('keeps states, counts and timestamps and drops error text, cursors and user ids', () => {
		const projected = projectMigrationState(JSON.stringify(value, null, 2));
		expect(projected).toEqual({
			deployedVersion: '0.6.16',
			migrations: [
				{
					migration: '0067_empty_retired_summaries',
					introducedIn: '0.6.10',
					state: 'failed',
					stalledAt: null,
					hasError: true,
					startedAt: 1,
					updatedAt: 2,
					completedAt: null,
					pageCount: 3,
					scannedCount: 300,
					changedCount: 12,
				},
			],
			runner: {
				status: 'stopped',
				startedAt: 1,
				updatedAt: 2,
				finishedAt: 3,
				stoppedMigration: '0067_empty_retired_summaries',
				hasStoppedError: true,
			},
		});
		expect(JSON.stringify(projected)).not.toMatch(/marcel|secret-cursor/);
	});

	it('reads the value when the Convex CLI prints notices around it', () => {
		const stdout = `A newer version of Convex is available\n${JSON.stringify(value)}\n`;
		expect(projectMigrationState(stdout)?.migrations).toHaveLength(1);
	});

	it('answers null for output that is not the query result', () => {
		expect(projectMigrationState('')).toBeNull();
		expect(projectMigrationState('Error: Could not find function')).toBeNull();
		expect(projectMigrationState('{"migrations": "nope"}')).toBeNull();
		expect(projectMigrationState('[1,2]')).toBeNull();
	});
});

describe('projectRolloutRecord', () => {
	it('reports a missing record as absent, not as a failure', () => {
		expect(projectRolloutRecord(null)).toEqual({ result: { status: 'absent' }, rollout: null });
	});

	it('reports a corrupt or foreign record as invalid', () => {
		for (const text of [
			'{ not json',
			'[]',
			'{"phase":"done"}',
			'{"targetVersion":1,"startedAt":1,"phase":"done"}',
		]) {
			expect(projectRolloutRecord(text)).toEqual({
				result: { status: 'unavailable', reason: 'invalid_record' },
				rollout: null,
			});
		}
	});

	it('keeps the verdict and drops the prose', () => {
		const projected = projectRolloutRecord(
			JSON.stringify({
				attempt: 'attempt-123456',
				targetVersion: '0.6.16',
				startedAt: 100,
				phase: 'done',
				committed: true,
				outcome: 'partially-applied',
				summary: 'docker said: pull access denied for registry.example.com, user marcel',
				warnings: ['mta did not become healthy: marcel@example.com'],
				finishedAt: 200,
			})
		);
		expect(projected).toEqual({
			result: { status: 'ok' },
			rollout: {
				targetVersion: '0.6.16',
				startedAt: 100,
				finishedAt: 200,
				phase: 'done',
				committed: true,
				outcome: 'partially-applied',
				warningCount: 1,
				hasSummary: true,
			},
		});
	});

	it('reports an unfinished record as it is, with no verdict', () => {
		const projected = projectRolloutRecord(
			JSON.stringify({ targetVersion: null, startedAt: 100, phase: 'verifying', outcome: 'bogus' })
		);
		expect(projected.rollout).toMatchObject({ phase: 'verifying', outcome: null, committed: null });
	});
});

describe('projectServiceLog', () => {
	it('keeps docker timestamps, projects each line and keeps the newest lines only', () => {
		const raw = [
			'2026-10-24T10:00:00.000000001Z {"level":30,"msg":"one marcel@example.com"}',
			'2026-10-24T10:00:01.000000001Z {"level":50,"msg":"two"}',
			'',
			'no timestamp ERROR Marcel failed',
		].join('\n');
		const projected = projectServiceLog(raw, 2);
		expect(projected.lines).toBe(2);
		const records = projected.ndjson
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(records[0]).toMatchObject({
			t: '2026-10-24T10:00:01.000000001Z',
			format: 'json',
			level: 'error',
		});
		expect(records[1]).toMatchObject({ format: 'text' });
		expect(records[1]).not.toHaveProperty('t');
		expect(projected.ndjson).not.toMatch(/marcel/i);
	});

	it('writes nothing for an empty log', () => {
		expect(projectServiceLog('\n\n', 10)).toEqual({ ndjson: '', lines: 0 });
	});
});
