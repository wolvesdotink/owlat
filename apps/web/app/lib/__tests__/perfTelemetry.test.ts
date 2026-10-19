import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as TelemetryModule from '../perfTelemetry';

type Telemetry = typeof TelemetryModule;

/** A fresh module per case: the queue and the view count are module state. */
async function load(): Promise<Telemetry> {
	vi.resetModules();
	return import('../perfTelemetry');
}

describe('perfTelemetry', () => {
	let telemetry: Telemetry;

	beforeEach(async () => {
		telemetry = await load();
	});

	it('drops every sample until a PostHog key armed it', () => {
		const send = vi.fn();
		telemetry.reportPerf('owlat_boot_shell_ms', { duration_ms: 300 });
		telemetry.setPerfSender(send);

		expect(send).not.toHaveBeenCalled();
	});

	it('holds samples taken before the client runs and sends them when it starts', () => {
		telemetry.armPerfReporting({ currentRoute: () => 'dashboard-postbox-folder' });
		telemetry.reportPerf('owlat_boot_shell_ms', { duration_ms: 300 });

		const send = vi.fn();
		telemetry.setPerfSender(send);
		telemetry.reportPerf('owlat_web_vitals', { lcp_ms: 900 });

		expect(send.mock.calls).toEqual([
			['owlat_boot_shell_ms', { route: 'dashboard-postbox-folder', duration_ms: 300 }],
			['owlat_web_vitals', { route: 'dashboard-postbox-folder', lcp_ms: 900 }],
		]);
	});

	it('forgets waiting samples when the flag switches off', () => {
		telemetry.armPerfReporting({ currentRoute: () => 'dashboard' });
		const first = vi.fn();
		telemetry.setPerfSender(first);
		telemetry.setPerfSender(null);
		telemetry.reportPerf('owlat_boot_shell_ms', { duration_ms: 300 });
		telemetry.setPerfSender(null);

		const second = vi.fn();
		telemetry.setPerfSender(second);

		expect(first).not.toHaveBeenCalled();
		expect(second).not.toHaveBeenCalled();
	});

	it('keeps at most twenty waiting samples', () => {
		telemetry.armPerfReporting({ currentRoute: () => 'dashboard' });
		for (let i = 0; i < 30; i += 1) telemetry.reportPerf('owlat_boot_shell_ms', { duration_ms: i });

		const send = vi.fn();
		telemetry.setPerfSender(send);

		expect(send).toHaveBeenCalledTimes(20);
	});

	it('knows whether the app still shows the route it booted into', () => {
		expect(telemetry.isFirstView()).toBe(true);
		expect(telemetry.landingRoute()).toBe('unknown');

		telemetry.noteViewSettled('auth-login');
		expect(telemetry.isFirstView()).toBe(true);
		expect(telemetry.landingRoute()).toBe('auth-login');

		telemetry.noteViewSettled('dashboard');
		expect(telemetry.isFirstView()).toBe(false);
		expect(telemetry.landingRoute()).toBe('auth-login');
	});

	it('does no work at all without PostHog armed or a local trace', () => {
		const currentRoute = vi.fn(() => 'dashboard');
		telemetry.setLocalPerfSink(null, { currentRoute });
		telemetry.reportPerf('owlat_boot_shell_ms', { duration_ms: 300 });

		expect(currentRoute).not.toHaveBeenCalled();
	});

	it('hands every sample to a local trace while PostHog is absent', () => {
		const local = vi.fn();
		telemetry.setLocalPerfSink(local, { currentRoute: () => 'dashboard-postbox-folder' });
		telemetry.reportPerf('owlat_boot_shell_ms', { duration_ms: 300 });

		const send = vi.fn();
		telemetry.setPerfSender(send);

		expect(local.mock.calls).toEqual([
			['owlat_boot_shell_ms', { route: 'dashboard-postbox-folder', duration_ms: 300 }],
		]);
		// Not armed: nothing waits for a PostHog sender.
		expect(send).not.toHaveBeenCalled();
	});

	it('feeds both sinks when PostHog is armed and a local trace is on', () => {
		const local = vi.fn();
		const send = vi.fn();
		telemetry.armPerfReporting({ currentRoute: () => 'dashboard' });
		telemetry.setLocalPerfSink(local);
		telemetry.setPerfSender(send);
		telemetry.reportPerf('owlat_reader_open_ms', { duration_ms: 90 });

		const sample = { route: 'dashboard', duration_ms: 90 };
		expect(local).toHaveBeenCalledWith('owlat_reader_open_ms', sample);
		expect(send).toHaveBeenCalledWith('owlat_reader_open_ms', sample);
	});

	it('stops feeding a local trace once its sink is removed', () => {
		const local = vi.fn();
		telemetry.setLocalPerfSink(local, { currentRoute: () => 'dashboard' });
		telemetry.setLocalPerfSink(null);
		telemetry.reportPerf('owlat_boot_shell_ms', { duration_ms: 300 });

		expect(local).not.toHaveBeenCalled();
	});

	it('starts the shared page-load collection once, whichever sink asks first', () => {
		const afterEach = vi.fn();
		telemetry.startPerfCollection({ afterEach });
		telemetry.startPerfCollection({ afterEach });

		expect(afterEach).toHaveBeenCalledTimes(1);
		const guard = afterEach.mock.calls[0]![0] as (
			to: { name: unknown },
			from: unknown,
			failure?: unknown
		) => void;
		guard({ name: 'auth-login' }, {});
		guard({ name: 'dashboard' }, {}, new Error('aborted'));
		expect(telemetry.landingRoute()).toBe('auth-login');
		expect(telemetry.isFirstView()).toBe(true);
	});
});
