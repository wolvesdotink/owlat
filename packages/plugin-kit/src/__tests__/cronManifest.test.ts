import { describe, expect, it } from 'vitest';
import {
	PLUGIN_CRON_MAX_INTERVAL_MINUTES,
	PLUGIN_CRON_MIN_INTERVAL_MINUTES,
	PLUGIN_CRON_TIMEOUT_MAX_MS,
	PLUGIN_CRON_TIMEOUT_MIN_MS,
	pluginCronKind,
} from '../cron';
import { parsePluginManifest, validatePluginManifest } from '../manifest';
import { parsePluginId } from '../pluginId';

function manifest(cron: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
	return {
		id: 'seed-lab',
		version: '1.0.0',
		capabilities: ['scheduler:cron'],
		flag: { default: false },
		contributes: {
			crons: [
				{
					id: 'refresh-scores',
					label: 'Refresh seed scores',
					module: { exportPath: './crons/refresh' },
					schedule: { intervalMinutes: 360 },
					timeoutMs: 30_000,
					...cron,
				},
			],
		},
		...overrides,
	};
}

describe('plugin cron manifest contract', () => {
	it('snapshots and freezes the complete data-only descriptor', () => {
		const input = manifest({});
		const parsed = parsePluginManifest(input);
		const parsedCron = parsed.contributes?.crons?.[0];
		expect(parsedCron).toEqual({
			id: 'refresh-scores',
			label: 'Refresh seed scores',
			module: { exportPath: './crons/refresh' },
			schedule: { intervalMinutes: 360 },
			timeoutMs: 30_000,
		});
		expect(parsedCron).not.toBe(input.contributes.crons[0]);
		expect(Object.isFrozen(parsedCron)).toBe(true);
		expect(Object.isFrozen(parsedCron?.module)).toBe(true);
		expect(Object.isFrozen(parsedCron?.schedule)).toBe(true);

		input.contributes.crons[0]!.label = 'Mutated';
		input.contributes.crons[0]!.schedule.intervalMinutes = 1;
		expect(parsedCron).toMatchObject({
			label: 'Refresh seed scores',
			schedule: { intervalMinutes: 360 },
		});
	});

	it('accepts the exact scheduling and timeout boundaries', () => {
		expect(
			validatePluginManifest(
				manifest({ schedule: { intervalMinutes: PLUGIN_CRON_MIN_INTERVAL_MINUTES } })
			).ok
		).toBe(true);
		expect(
			validatePluginManifest(
				manifest({ schedule: { intervalMinutes: PLUGIN_CRON_MAX_INTERVAL_MINUTES } })
			).ok
		).toBe(true);
		expect(validatePluginManifest(manifest({ timeoutMs: PLUGIN_CRON_TIMEOUT_MIN_MS })).ok).toBe(
			true
		);
		expect(validatePluginManifest(manifest({ timeoutMs: PLUGIN_CRON_TIMEOUT_MAX_MS })).ok).toBe(
			true
		);
	});

	it.each([
		['uppercase id', { id: 'Refresh' }],
		['reserved id', { id: 'prototype' }],
		['padded label', { label: ' Refresh ' }],
		['unsafe export', { module: { exportPath: '../secret' } }],
		['missing schedule', { schedule: undefined }],
		['non-object schedule', { schedule: 5 }],
		[
			'too-frequent interval',
			{ schedule: { intervalMinutes: PLUGIN_CRON_MIN_INTERVAL_MINUTES - 1 } },
		],
		['too-rare interval', { schedule: { intervalMinutes: PLUGIN_CRON_MAX_INTERVAL_MINUTES + 1 } }],
		['fractional interval', { schedule: { intervalMinutes: 15.5 } }],
		['zero interval', { schedule: { intervalMinutes: 0 } }],
		['unknown schedule field', { schedule: { intervalMinutes: 30, hourUTC: 3 } }],
		['short timeout', { timeoutMs: PLUGIN_CRON_TIMEOUT_MIN_MS - 1 }],
		['long timeout', { timeoutMs: PLUGIN_CRON_TIMEOUT_MAX_MS + 1 }],
		['fractional timeout', { timeoutMs: 1_000.5 }],
		['unknown field', { endpoint: 'https://example.test' }],
	])('rejects %s', (_label, change) => {
		expect(validatePluginManifest(manifest(change)).ok).toBe(false);
	});

	it('rejects duplicate cron ids', () => {
		const value = manifest({});
		(value.contributes.crons as unknown[]).push({
			id: 'refresh-scores',
			label: 'Duplicate',
			module: { exportPath: './crons/duplicate' },
			schedule: { intervalMinutes: 60 },
			timeoutMs: 1_000,
		});
		expect(validatePluginManifest(value).ok).toBe(false);
	});

	it('requires the exact capability and a feature flag', () => {
		expect(validatePluginManifest(manifest({}, { capabilities: [] })).ok).toBe(false);
		expect(validatePluginManifest(manifest({}, { flag: undefined })).ok).toBe(false);
	});

	it('never invokes contribution accessors', () => {
		const descriptor = manifest({});
		Object.defineProperty(descriptor.contributes.crons[0], 'label', {
			enumerable: true,
			get: () => {
				throw new Error('must not execute');
			},
		});
		expect(validatePluginManifest(descriptor).ok).toBe(false);
	});

	it('namespaces the cron kind with the owning plugin id', () => {
		expect(pluginCronKind(parsePluginId('seed-lab'), 'refresh-scores')).toBe(
			'plugin.seed-lab.refresh-scores'
		);
	});
});
