/**
 * What the desktop smoke harness accepts as a passing run
 * (scripts/desktop-smoke/verdicts.ts and report.ts), over synthetic runs.
 */

import { describe, expect, it } from 'vitest';
import { fatalMatch, parseReport, type Report } from '../desktop-smoke/report';
import type { RunResult } from '../desktop-smoke/supervise';
import {
	livenessProblems,
	noUpdateProblems,
	rejectedProblems,
	smokeProblems,
	steps,
	updatedProblems,
} from '../desktop-smoke/verdicts';

const N = '0.6.16';
const NEXT = '0.6.17';
const MOUNTED = { path: '/desktop/welcome', title: 'Welcome to Owlat' };

function run(reports: Report[], overrides: Partial<RunResult> = {}): RunResult {
	return {
		lines: [],
		reports,
		fatal: [],
		exit: { code: 0, signal: null },
		aliveAtDeadline: false,
		stoppedAtDeadline: false,
		spawnError: null,
		...overrides,
	};
}

const r = (pid: number, event: string, fields: Record<string, unknown> = {}): Report => ({
	event,
	pid,
	...fields,
});

const smokeRun = () => run([r(1, 'boot', { version: N }), r(1, 'mounted', MOUNTED), r(1, 'done')]);

const updateRun = () =>
	run([
		r(1, 'boot', { version: N }),
		r(1, 'mounted', MOUNTED),
		r(1, 'update-found', { version: NEXT, currentVersion: N }),
		r(1, 'update-downloaded'),
		r(1, 'restarting'),
		r(2, 'boot', { version: NEXT }),
		r(2, 'mounted', MOUNTED),
		r(2, 'no-update', { version: NEXT }),
		r(2, 'done'),
	]);

describe('parseReport', () => {
	it('reads a prefixed JSON report anywhere in the line', () => {
		expect(parseReport('owlat-e2e {"event":"boot","pid":3,"version":"1.0.0"}')).toEqual({
			event: 'boot',
			pid: 3,
			version: '1.0.0',
		});
		expect(parseReport('[stdout] owlat-e2e {"event":"done","pid":3}')?.event).toBe('done');
	});

	it('ignores ordinary output and malformed reports', () => {
		expect(parseReport('Gtk-Message: Failed to load module "canberra-gtk-module"')).toBeNull();
		expect(parseReport('owlat-e2e {not json')).toBeNull();
		expect(parseReport('owlat-e2e {"pid":3}')).toBeNull();
		expect(parseReport('owlat-e2e {"event":"boot","pid":"3"}')).toBeNull();
		expect(parseReport('owlat-e2e "boot"')).toBeNull();
	});
});

describe('fatalMatch', () => {
	it('names output only a broken launch produces', () => {
		expect(fatalMatch("thread 'tokio-runtime-worker' panicked at src/updater.rs:9:1:")).toBe(
			'Rust panic'
		);
		expect(
			fatalMatch('Owlat: error while loading shared libraries: libwebkit2gtk-4.1.so.0: cannot open')
		).toBe('missing shared library');
		expect(fatalMatch('Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...')).toBe(
			'no EGL display'
		);
		expect(fatalMatch('Segmentation fault (core dumped)')).toBe('native crash');
		expect(fatalMatch('(owlat-desktop:42): Gtk-WARNING **: cannot open display: :99')).toBe(
			'no display'
		);
	});

	it('lets the usual GTK and WebKit noise through', () => {
		for (const line of [
			'Gtk-Message: 10:00:00.000: Failed to load module "canberra-gtk-module"',
			"(owlat-desktop:42): dbind-WARNING **: Couldn't connect to accessibility bus: Failed to connect to socket",
			'libEGL warning: DRI3: Screen seems not DRI3 capable',
			'[WARNING] The updater endpoint "http://127.0.0.1:1/" doesn\'t use `https` protocol.',
		]) {
			expect(fatalMatch(line), line).toBeNull();
		}
	});
});

describe('steps', () => {
	it('tags each native step with the version of the process that reported it', () => {
		expect(steps(updateRun().reports)).toEqual([
			`boot@${N}`,
			`mounted@${N}`,
			`update-found@${N}`,
			`update-downloaded@${N}`,
			`restarting@${N}`,
			`boot@${NEXT}`,
			`mounted@${NEXT}`,
			`no-update@${NEXT}`,
			`done@${NEXT}`,
		]);
	});

	it('leaves renderer reports out of the sequence', () => {
		const reports = [...smokeRun().reports];
		reports.splice(1, 0, r(1, 'renderer-error', { kind: 'uncaught', detail: 'x' }));
		expect(steps(reports)).toEqual([`boot@${N}`, `mounted@${N}`, `done@${N}`]);
	});
});

describe('smokeProblems', () => {
	it('passes a clean boot, mount and exit', () => {
		expect(smokeProblems(smokeRun(), N)).toEqual([]);
	});

	it('fails a run that never mounted', () => {
		const problems = smokeProblems(
			run([r(1, 'boot', { version: N })], { stoppedAtDeadline: true, exit: null }),
			N
		);
		expect(problems).toContain('the app did not finish before the deadline');
		expect(problems.join('\n')).toContain('expected steps');
	});

	it('fails renderer errors, fatal output and a non-zero exit', () => {
		const result = smokeRun();
		const problems = smokeProblems(
			{
				...result,
				reports: [
					...result.reports,
					r(1, 'renderer-error', { kind: 'resource', detail: 'tauri://localhost/_nuxt/x.js' }),
				],
				fatal: ['Rust panic: boom'],
				exit: { code: 101, signal: null },
			},
			N
		);
		expect(problems).toEqual([
			'fatal output: Rust panic: boom',
			'renderer error (resource): tauri://localhost/_nuxt/x.js',
			'the app exited with code 101',
		]);
	});

	it('fails a mount on the wrong page or with an untranslated title', () => {
		const result = run([
			r(1, 'boot', { version: N }),
			r(1, 'mounted', { path: '/dashboard', title: 'desktop.welcome.pageTitle' }),
			r(1, 'done'),
		]);
		expect(smokeProblems(result, N)).toEqual([
			'mounted on /dashboard, not the welcome page',
			'the page title is an untranslated key: desktop.welcome.pageTitle',
		]);
	});

	it('fails a page that tries to report a native step', () => {
		const result = smokeRun();
		const reports = [...result.reports, r(1, 'renderer-unknown', { event: 'renderer-unknown' })];
		expect(smokeProblems({ ...result, reports }, N)[0]).toMatch(/unexpected renderer report/);
	});
});

describe('updatedProblems', () => {
	it('passes N finding, verifying and installing N+1, then N+1 running', () => {
		expect(updatedProblems(updateRun(), N, NEXT)).toEqual([]);
	});

	it('fails when the relaunched binary still reports the old version', () => {
		const result = updateRun();
		const reports = result.reports.map((report) =>
			report.pid === 2 && report.event === 'boot' ? { ...report, version: N } : report
		);
		expect(updatedProblems({ ...result, reports }, N, NEXT).join('\n')).toContain('expected steps');
	});

	it('fails when no second process booted', () => {
		const reports = updateRun().reports.map((report) => ({ ...report, pid: 1 }));
		const problems = updatedProblems(run(reports), N, NEXT);
		expect(problems).toContain('expected two processes to boot, saw 1');
	});

	it('fails an update-found that names the wrong versions', () => {
		const result = updateRun();
		const reports = result.reports.map((report) =>
			report.event === 'update-found' ? { ...report, version: '9.9.9' } : report
		);
		expect(updatedProblems({ ...result, reports }, N, NEXT)[0]).toMatch(/^update-found reported/);
	});
});

describe('noUpdateProblems', () => {
	it('passes N staying on N after a 204', () => {
		const result = run([
			r(1, 'boot', { version: N }),
			r(1, 'mounted', MOUNTED),
			r(1, 'no-update', { version: N }),
			r(1, 'done'),
		]);
		expect(noUpdateProblems(result, N)).toEqual([]);
	});
});

describe('rejectedProblems', () => {
	const rejected = (error: Record<string, unknown>) =>
		run([
			r(1, 'boot', { version: N }),
			r(1, 'mounted', MOUNTED),
			r(1, 'update-found', { version: NEXT, currentVersion: N }),
			r(1, 'update-error', error),
			r(1, 'done'),
		]);

	it('passes a bundle refused for its signature while downloading', () => {
		expect(rejectedProblems(rejected({ stage: 'download', kind: 'signature' }), N)).toEqual([]);
	});

	it('fails a refusal for any other reason', () => {
		expect(rejectedProblems(rejected({ stage: 'download', kind: 'network' }), N)[0]).toMatch(
			/expected a signature failure/
		);
		expect(rejectedProblems(rejected({ stage: 'check', kind: 'signature' }), N)[0]).toMatch(
			/expected a signature failure/
		);
	});

	it('fails a tampered bundle that got installed', () => {
		expect(rejectedProblems(updateRun(), N).join('\n')).toContain('expected steps');
	});
});

describe('livenessProblems', () => {
	it('passes an app still running at the deadline', () => {
		expect(
			livenessProblems(run([], { aliveAtDeadline: true, stoppedAtDeadline: true, exit: null }))
		).toEqual([]);
	});

	it('fails an app that exited early or printed something fatal', () => {
		expect(livenessProblems(run([], { exit: { code: 1, signal: null } }))).toEqual([
			'the app exited before the deadline (code 1)',
		]);
		expect(
			livenessProblems(
				run([], { aliveAtDeadline: true, stoppedAtDeadline: true, fatal: ['no display: x'] })
			)
		).toEqual(['fatal output: no display: x']);
	});
});
