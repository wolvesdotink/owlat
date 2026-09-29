import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as TelemetryModule from '~/lib/perfTelemetry';
import type * as ComposableModule from '../usePerfMark';

type Telemetry = typeof TelemetryModule;
type Composable = typeof ComposableModule;

/**
 * The real telemetry module behind the composable, armed with a recording
 * sender, so a case sees exactly what would reach PostHog.
 */
async function load(): Promise<{
	telemetry: Telemetry;
	composable: Composable;
	sent: unknown[][];
}> {
	vi.resetModules();
	const telemetry = await import('~/lib/perfTelemetry');
	const composable = await import('../usePerfMark');
	const sent: unknown[][] = [];
	telemetry.armPerfReporting({ currentRoute: () => 'dashboard-postbox-folder' });
	telemetry.setPerfSender((event, properties) => sent.push([event, properties]));
	return { telemetry, composable, sent };
}

describe('usePerfMark', () => {
	beforeEach(() => {
		performance.clearMarks();
		performance.clearMeasures();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('measures from a mark and reports the span with the route name', async () => {
		const { composable, sent } = await load();
		const { mark, measure } = composable.usePerfMark();

		mark('owlat_test_start');
		const duration = measure('owlat_test_ms', 'owlat_test_start');

		expect(duration).not.toBeNull();
		expect(sent).toEqual([
			[
				'owlat_test_ms',
				{ route: 'dashboard-postbox-folder', duration_ms: Math.round(duration as number) },
			],
		]);
		expect(performance.getEntriesByName('owlat_test_ms', 'measure')).toHaveLength(1);
		// The start mark is spent, so a second measure cannot reuse a stale start.
		expect(performance.getEntriesByName('owlat_test_start', 'mark')).toHaveLength(0);
	});

	it('can start the span at an earlier time, such as an input event', async () => {
		const { composable, sent } = await load();
		const { mark, measure } = composable.usePerfMark();

		const startTime = Math.max(0, performance.now() - 40);
		mark('owlat_test_start', startTime);

		expect(performance.getEntriesByName('owlat_test_start', 'mark')[0]?.startTime).toBe(startTime);
		const before = performance.now();
		expect(measure('owlat_test_ms', 'owlat_test_start')).toBeGreaterThanOrEqual(before - startTime);
		expect(sent).toHaveLength(1);
	});

	it('reports nothing for a start mark that was never set', async () => {
		const { composable, sent } = await load();

		expect(composable.usePerfMark().measure('owlat_test_ms', 'never_set')).toBeNull();
		expect(sent).toEqual([]);
	});

	it('times the boot from navigation start, once per page load', async () => {
		const { composable, sent } = await load();
		const { measureBoot } = composable.usePerfMark();

		measureBoot('owlat_boot_shell_ms');
		// The shell remounts after a section change: not a second boot.
		measureBoot('owlat_boot_shell_ms');

		expect(sent).toHaveLength(1);
		expect(sent[0]?.[0]).toBe('owlat_boot_shell_ms');
		expect(performance.getEntriesByName('owlat_boot_shell_ms', 'measure')[0]?.startTime).toBe(0);
	});

	it('does not time a shell reached by navigating from another page', async () => {
		const { telemetry, composable, sent } = await load();
		telemetry.noteViewSettled('auth-login');
		telemetry.noteViewSettled('dashboard');

		composable.usePerfMark().measureBoot('owlat_boot_shell_ms');

		expect(sent).toEqual([]);
	});
});
