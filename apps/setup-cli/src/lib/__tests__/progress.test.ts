import { describe, it, expect } from 'vitest';
import {
	createReporter,
	parseProgressLine,
	PROGRESS_SENTINEL,
	SetupStep,
	type ProgressEvent,
	type ProgressStepEvent,
} from '../progress';

/** A reporter whose emitted lines are captured into an array, with a fixed clock. */
function capturing() {
	const lines: string[] = [];
	const reporter = createReporter({ json: true, write: (line) => lines.push(line), now: () => 1000 });
	// Each emitted line is one sentinel-prefixed JSON record terminated by \n.
	const events = (): ProgressEvent[] => lines.map((l) => parseProgressLine(l)).filter((e): e is ProgressEvent => e !== null);
	return { reporter, lines, events };
}

describe('createReporter', () => {
	it('returns a no-op reporter that emits nothing when json is off', () => {
		const lines: string[] = [];
		const reporter = createReporter({ json: false, write: (l) => lines.push(l) });
		expect(reporter.isJson).toBe(false);
		reporter.step(SetupStep.ComposeUp, 'Starting');
		reporter.ok('done');
		reporter.log('noise');
		reporter.done(true, { siteUrl: 'x' });
		expect(lines).toEqual([]);
	});

	it('selects json mode from OWLAT_PROGRESS=json when not given explicitly', () => {
		const prev = process.env['OWLAT_PROGRESS'];
		process.env['OWLAT_PROGRESS'] = 'json';
		try {
			expect(createReporter().isJson).toBe(true);
		} finally {
			if (prev === undefined) delete process.env['OWLAT_PROGRESS'];
			else process.env['OWLAT_PROGRESS'] = prev;
		}
	});
});

describe('JSON reporter wire format', () => {
	it('emits one sentinel-prefixed JSON line per event, newline-terminated', () => {
		const { reporter, lines } = capturing();
		reporter.step(SetupStep.ComposeUp, 'Starting containers');
		expect(lines).toHaveLength(1);
		expect(lines[0]!.startsWith(PROGRESS_SENTINEL)).toBe(true);
		expect(lines[0]!.endsWith('\n')).toBe(true);
	});

	it('opens a step as running and closes it as ok with detail', () => {
		const { reporter, events } = capturing();
		reporter.step(SetupStep.ComposeUp, 'Starting containers');
		reporter.ok('Stack is up');
		expect(events()).toEqual([
			{ v: 1, event: 'step', id: 'compose-up', title: 'Starting containers', status: 'running', ts: 1000 },
			{ v: 1, event: 'step', id: 'compose-up', title: 'Starting containers', status: 'ok', detail: 'Stack is up', ts: 1000 },
		]);
	});

	it('maps warn() to an ok status flagged warn:true (soft failure, pipeline continues)', () => {
		const { reporter, events } = capturing();
		reporter.step(SetupStep.WaitRoutes, 'Waiting for routes');
		reporter.warn('still warming up');
		const close = events()[1] as ProgressStepEvent;
		expect(close.status).toBe('ok');
		expect(close.warn).toBe(true);
		expect(close.detail).toBe('still warming up');
	});

	it('emits failed and skipped statuses', () => {
		const a = capturing();
		a.reporter.step(SetupStep.DeployFunctions, 'Deploying');
		a.reporter.fail('boom');
		expect((a.events()[1] as ProgressStepEvent).status).toBe('failed');

		const b = capturing();
		b.reporter.step(SetupStep.SeedDemo, 'Seeding');
		b.reporter.skip('not requested');
		expect((b.events()[1] as ProgressStepEvent).status).toBe('skipped');
	});

	it('auto-closes a still-open step as ok when the next step opens', () => {
		const { reporter, events } = capturing();
		reporter.step(SetupStep.AdminKey, 'Minting key');
		reporter.step(SetupStep.DeployFunctions, 'Deploying');
		const evs = events();
		// running(admin-key), ok(admin-key, auto), running(deploy-functions)
		expect(evs.map((e) => (e as ProgressStepEvent).status)).toEqual(['running', 'ok', 'running']);
		expect((evs[1] as ProgressStepEvent).id).toBe('admin-key');
	});

	it('emits raw log lines with a stream tag', () => {
		const { reporter, events } = capturing();
		reporter.step(SetupStep.DeployFunctions, 'Deploying');
		reporter.log('pushed 12 functions');
		reporter.log('warning: slow', 'stderr');
		const logs = events().filter((e) => e.event === 'log');
		expect(logs).toEqual([
			{ v: 1, event: 'log', line: 'pushed 12 functions', stream: 'stdout', ts: 1000 },
			{ v: 1, event: 'log', line: 'warning: slow', stream: 'stderr', ts: 1000 },
		]);
	});

	it('emits a terminal done event with the connection summary, closing any open step', () => {
		const { reporter, events } = capturing();
		reporter.step(SetupStep.SeedDemo, 'Seeding');
		reporter.done(true, { siteUrl: 'http://host:3000', adminEmail: 'a@b.co' });
		const evs = events();
		expect((evs.at(-2) as ProgressStepEvent).status).toBe('ok'); // auto-closed step
		expect(evs.at(-1)).toEqual({
			v: 1,
			event: 'done',
			ok: true,
			summary: { siteUrl: 'http://host:3000', adminEmail: 'a@b.co' },
			ts: 1000,
		});
	});
});

describe('parseProgressLine', () => {
	it('round-trips a sentinel-prefixed event regardless of leading raw text', () => {
		const event: ProgressEvent = { v: 1, event: 'done', ok: true, ts: 5 };
		const line = `\r\x1b[2K${PROGRESS_SENTINEL}${JSON.stringify(event)}\n`;
		expect(parseProgressLine(line)).toEqual(event);
	});

	it('returns null for raw installer output (no sentinel) and malformed JSON', () => {
		expect(parseProgressLine('docker compose: pulling image...')).toBeNull();
		expect(parseProgressLine(`${PROGRESS_SENTINEL}{not json`)).toBeNull();
		expect(parseProgressLine(`${PROGRESS_SENTINEL}`)).toBeNull();
	});
});
