/**
 * The wire-version handshake (ADR-0063): the IMAP server serves only a backend
 * that speaks its contract, refuses to start when the backend no longer serves
 * it, waits for a backend that is older than it, and stops on a later report
 * that says it is no longer served.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ImapServerReportResult } from '../convex.js';
import {
	WIRE_REPORT_INTERVAL_MS,
	WIRE_RETRY_MAX_MS,
	awaitWireCompatibility,
	classifyWireReport,
	startWireReports,
	type WireHandshakeDeps,
} from '../wireHandshake.js';

const served: ImapServerReportResult = {
	backendWireVersion: 1,
	minSupportedWireVersion: 0,
	compatible: true,
};

const missingFunction = new Error(
	"[Request ID: 1] Server Error\nCould not find public function for 'mail/imap/serverRegistry:report'. " +
		'Did you forget to run `npx convex dev` or `npx convex deploy`?'
);

function makeDeps(answers: Array<ImapServerReportResult | Error>, wireVersion = 1) {
	const log = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
	const sleeps: number[] = [];
	const report = vi.fn(async () => {
		const next = answers.shift();
		if (!next) throw new Error('no more answers');
		if (next instanceof Error) throw next;
		return next;
	});
	const deps: WireHandshakeDeps = {
		report,
		owlatVersion: '0.6.8',
		log,
		wireVersion,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	};
	return { deps, log, report, sleeps };
}

describe('classifyWireReport', () => {
	it('reads a missing report function as a backend older than this server', () => {
		expect(classifyWireReport({ err: missingFunction })).toEqual({
			kind: 'backendOlder',
			backendWireVersion: null,
		});
	});

	it('reads a missing function other than report as unreachable, not as an old backend', () => {
		const other = new Error("Could not find public function for 'mail/imap/session:listFolders'");
		expect(classifyWireReport({ err: other }).kind).toBe('unreachable');
	});

	it('reads a network failure as unreachable', () => {
		expect(classifyWireReport({ err: new TypeError('fetch failed') }).kind).toBe('unreachable');
	});

	it('reads a backend wire version below its own as a backend older than this server', () => {
		expect(
			classifyWireReport(
				{ result: { backendWireVersion: 1, minSupportedWireVersion: 0, compatible: false } },
				2
			)
		).toEqual({ kind: 'backendOlder', backendWireVersion: 1 });
	});

	it('reads a minimum above its own as too old', () => {
		expect(
			classifyWireReport(
				{ result: { backendWireVersion: 3, minSupportedWireVersion: 2, compatible: false } },
				1
			)
		).toMatchObject({ kind: 'tooOld', minSupportedWireVersion: 2 });
	});

	it('honours a refusal the numbers do not explain', () => {
		expect(
			classifyWireReport({ result: { ...served, compatible: false, reason: 'later_rule' } }, 1)
		).toMatchObject({ kind: 'tooOld', reason: 'later_rule' });
	});

	it('accepts an older but supported contract', () => {
		expect(
			classifyWireReport(
				{ result: { backendWireVersion: 2, minSupportedWireVersion: 1, compatible: true } },
				1
			).kind
		).toBe('compatible');
	});
});

describe('awaitWireCompatibility', () => {
	it('serves at once when the backend speaks its contract', async () => {
		const { deps, report, sleeps } = makeDeps([served]);
		await expect(awaitWireCompatibility(deps)).resolves.toBe('serve');
		expect(report).toHaveBeenCalledTimes(1);
		expect(sleeps).toEqual([]);
	});

	it('refuses to start, naming both versions and the fix, when it is too old', async () => {
		const { deps, log, report } = makeDeps(
			[{ backendWireVersion: 3, minSupportedWireVersion: 2, compatible: false }],
			1
		);
		await expect(awaitWireCompatibility(deps)).resolves.toBe('refuse');
		expect(report).toHaveBeenCalledTimes(1);
		const [fields, message] = log.error.mock.calls[0]!;
		expect(fields).toMatchObject({ wireVersion: 1, minSupportedWireVersion: 2 });
		expect(message).toContain('wire version 1');
		expect(message).toContain('wire version 2 or newer');
		expect(message).toContain('Update the IMAP container');
		expect(message).toContain('Refusing to start');
	});

	it('waits for a backend that has no handshake yet, then serves', async () => {
		const { deps, log, sleeps } = makeDeps([missingFunction, missingFunction, served]);
		await expect(awaitWireCompatibility(deps)).resolves.toBe('serve');
		expect(sleeps).toEqual([1_000, 2_000]);
		expect(log.error.mock.calls[0]![1]).toContain('Update the backend first');
	});

	it('waits for a backend with a lower wire version', async () => {
		const { deps, sleeps } = makeDeps(
			[
				{ backendWireVersion: 1, minSupportedWireVersion: 0, compatible: false },
				{ backendWireVersion: 2, minSupportedWireVersion: 0, compatible: true },
			],
			2
		);
		await expect(awaitWireCompatibility(deps)).resolves.toBe('serve');
		expect(sleeps).toEqual([1_000]);
	});

	it('retries an unreachable backend with capped backoff', async () => {
		const down = new TypeError('fetch failed');
		const { deps, log, sleeps } = makeDeps([
			down,
			down,
			down,
			down,
			down,
			down,
			down,
			down,
			served,
		]);
		await expect(awaitWireCompatibility(deps)).resolves.toBe('serve');
		expect(sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
		expect(Math.max(...sleeps)).toBe(WIRE_RETRY_MAX_MS);
		expect(log.warn).toHaveBeenCalledTimes(8);
		expect(log.error).not.toHaveBeenCalled();
	});
});

describe('startWireReports', () => {
	function withTimer(answers: Array<ImapServerReportResult | Error>) {
		const made = makeDeps(answers);
		let tick: (() => void) | undefined;
		const unref = vi.fn();
		const clear = vi.fn();
		made.deps.setInterval = (callback, ms) => {
			expect(ms).toBe(WIRE_REPORT_INTERVAL_MS);
			tick = callback;
			return { unref };
		};
		made.deps.clearInterval = clear;
		const fire = async () => {
			tick!();
			await vi.waitFor(() => expect(made.report).toHaveBeenCalled());
			await new Promise((r) => setImmediate(r));
		};
		return { ...made, fire, unref, clear };
	}

	it('re-reports on an unref’d timer and keeps serving while compatible', async () => {
		const { deps, fire, report, unref, clear } = withTimer([served, served]);
		const onIncompatible = vi.fn();
		startWireReports(deps, onIncompatible);
		expect(unref).toHaveBeenCalled();

		await fire();
		await fire();
		expect(report).toHaveBeenCalledTimes(2);
		expect(onIncompatible).not.toHaveBeenCalled();
		expect(clear).not.toHaveBeenCalled();
	});

	it('keeps serving through a failed report', async () => {
		const { deps, fire, log } = withTimer([new TypeError('fetch failed')]);
		const onIncompatible = vi.fn();
		startWireReports(deps, onIncompatible);

		await fire();
		expect(onIncompatible).not.toHaveBeenCalled();
		expect(log.warn).toHaveBeenCalledTimes(1);
	});

	it('shuts down once when a later report says this server is no longer served', async () => {
		const { deps, fire, log, clear, report } = withTimer([
			{ backendWireVersion: 3, minSupportedWireVersion: 2, compatible: false },
		]);
		const onIncompatible = vi.fn();
		startWireReports(deps, onIncompatible);

		await fire();
		expect(onIncompatible).toHaveBeenCalledTimes(1);
		expect(onIncompatible.mock.calls[0]![0]).toMatchObject({ kind: 'tooOld' });
		expect(log.error.mock.calls[0]![1]).toContain('Shutting down');
		expect(clear).toHaveBeenCalledTimes(1);

		// A stray tick after the stop reports nothing.
		await fire();
		expect(report).toHaveBeenCalledTimes(1);
	});

	it('shuts down when the backend was rolled back below this server', async () => {
		const { deps, fire } = withTimer([missingFunction]);
		const onIncompatible = vi.fn();
		startWireReports(deps, onIncompatible);

		await fire();
		expect(onIncompatible.mock.calls[0]![0]).toMatchObject({ kind: 'backendOlder' });
	});

	it('stop() cancels the timer', () => {
		const { deps, clear } = withTimer([]);
		startWireReports(deps, vi.fn()).stop();
		expect(clear).toHaveBeenCalledTimes(1);
	});
});
