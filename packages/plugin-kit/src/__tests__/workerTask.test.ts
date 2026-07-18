import { describe, expect, it } from 'vitest';
import {
	PLUGIN_WORKER_CAPABILITY,
	PLUGIN_WORKER_JOB_KIND_LOCAL_ID_CASES,
	PLUGIN_WORKER_MAX_ATTEMPTS,
	PLUGIN_WORKER_MIN_ATTEMPTS,
	PLUGIN_WORKER_TIMEOUT_MAX_MS,
	PLUGIN_WORKER_TIMEOUT_MIN_MS,
	clampWorkerAttempts,
	clampWorkerTimeoutMs,
	isPluginWorkerJobKindOwnedBy,
	isPluginWorkerJobLocalId,
	parsePluginId,
	pluginWorkerJobKind,
	pluginWorkerJobLocalIdOf,
} from '../index';

const plugin = parsePluginId('deliverability-lab');
const other = parsePluginId('other-plugin');

describe('worker capability constant', () => {
	it('is the single source-of-truth capability string', () => {
		expect(PLUGIN_WORKER_CAPABILITY).toBe('worker:enqueue');
	});
});

describe('pluginWorkerJobKind', () => {
	it('namespaces a local id under its owning plugin', () => {
		expect(pluginWorkerJobKind(plugin, 'seed-test')).toBe('plugin.deliverability-lab.seed-test');
	});
});

describe('isPluginWorkerJobLocalId', () => {
	it.each(['seed-test', 'spam-score', 'a', 'x9-y'])('accepts %s', (id) => {
		expect(isPluginWorkerJobLocalId(id)).toBe(true);
	});

	it.each(['Seed', '-lead', 'trail-', 'has_underscore', 'has.dot', '9lead', '', 123, null])(
		'rejects %s',
		(id) => {
			expect(isPluginWorkerJobLocalId(id)).toBe(false);
		}
	);

	it('rejects an over-length local id', () => {
		expect(isPluginWorkerJobLocalId('a'.repeat(65))).toBe(false);
	});
});

describe('isPluginWorkerJobKindOwnedBy', () => {
	it('accepts a well-formed kind owned by the plugin', () => {
		expect(isPluginWorkerJobKindOwnedBy('plugin.deliverability-lab.seed-test', plugin)).toBe(true);
	});

	it('rejects a cross-plugin kind (another plugin cannot be impersonated)', () => {
		expect(isPluginWorkerJobKindOwnedBy('plugin.other-plugin.seed-test', plugin)).toBe(false);
		expect(isPluginWorkerJobKindOwnedBy(pluginWorkerJobKind(other, 'seed-test'), plugin)).toBe(
			false
		);
	});

	it('rejects a kind with a prefix-collision plugin id', () => {
		// `deliverability-lab-evil` shares the `deliverability-lab` prefix but is a
		// different plugin; the trailing `.` in the required prefix blocks it.
		expect(isPluginWorkerJobKindOwnedBy('plugin.deliverability-lab-evil.job', plugin)).toBe(false);
	});

	it.each([
		'plugin.deliverability-lab.',
		'plugin.deliverability-lab.Bad',
		'plugin.deliverability-lab.a.b',
		'deliverability-lab.seed-test',
		'plugin.deliverability-lab.has_underscore',
		42,
		null,
		undefined,
	])('rejects malformed kind %s', (kind) => {
		expect(isPluginWorkerJobKindOwnedBy(kind, plugin)).toBe(false);
	});
});

describe('pluginWorkerJobLocalIdOf — the single job-kind parser the worker also consumes', () => {
	it.each(PLUGIN_WORKER_JOB_KIND_LOCAL_ID_CASES)('maps $kind → $localId', ({ kind, localId }) => {
		expect(pluginWorkerJobLocalIdOf(kind)).toBe(localId);
	});

	it('rejects non-string kinds', () => {
		expect(pluginWorkerJobLocalIdOf(42)).toBeNull();
		expect(pluginWorkerJobLocalIdOf(null)).toBeNull();
		expect(pluginWorkerJobLocalIdOf(undefined)).toBeNull();
	});

	it('agrees with isPluginWorkerJobKindOwnedBy for the plugin that owns a kind', () => {
		// A kind parses to a local id iff it is owned by SOME plugin; when it does,
		// the owning plugin's ownership check must accept it. Guards against the two
		// helpers drifting apart.
		const owned = pluginWorkerJobKind(plugin, 'seed-test');
		expect(pluginWorkerJobLocalIdOf(owned)).toBe('seed-test');
		expect(isPluginWorkerJobKindOwnedBy(owned, plugin)).toBe(true);
	});
});

describe('clampWorkerAttempts', () => {
	it('floors an undefined/NaN request to the minimum', () => {
		expect(clampWorkerAttempts(undefined)).toBe(PLUGIN_WORKER_MIN_ATTEMPTS);
		expect(clampWorkerAttempts(Number.NaN)).toBe(PLUGIN_WORKER_MIN_ATTEMPTS);
	});

	it('clamps below/above the closed range', () => {
		expect(clampWorkerAttempts(0)).toBe(PLUGIN_WORKER_MIN_ATTEMPTS);
		expect(clampWorkerAttempts(-3)).toBe(PLUGIN_WORKER_MIN_ATTEMPTS);
		expect(clampWorkerAttempts(999)).toBe(PLUGIN_WORKER_MAX_ATTEMPTS);
	});

	it('passes a valid request through, flooring fractional values', () => {
		expect(clampWorkerAttempts(3)).toBe(3);
		expect(clampWorkerAttempts(2.9)).toBe(2);
	});
});

describe('clampWorkerTimeoutMs', () => {
	it('defaults an undefined/NaN request to the maximum budget', () => {
		expect(clampWorkerTimeoutMs(undefined)).toBe(PLUGIN_WORKER_TIMEOUT_MAX_MS);
		expect(clampWorkerTimeoutMs(Number.NaN)).toBe(PLUGIN_WORKER_TIMEOUT_MAX_MS);
	});

	it('clamps below/above the closed range', () => {
		expect(clampWorkerTimeoutMs(1)).toBe(PLUGIN_WORKER_TIMEOUT_MIN_MS);
		expect(clampWorkerTimeoutMs(999_999_999)).toBe(PLUGIN_WORKER_TIMEOUT_MAX_MS);
	});

	it('passes a valid request through', () => {
		expect(clampWorkerTimeoutMs(60_000)).toBe(60_000);
	});
});
