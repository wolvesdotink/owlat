/**
 * What each run has to show, as a list of problems (empty means it passed).
 * Pure functions over a finished run, so every rule is unit-tested without
 * launching anything.
 */

import type { Report } from './report';
import type { RunResult } from './supervise';

/** Problems every fixture run shares: it started, finished and stayed clean. */
function launchProblems(result: RunResult): string[] {
	const problems: string[] = [];
	if (result.spawnError) problems.push(`could not start the app: ${result.spawnError}`);
	if (result.stoppedAtDeadline) problems.push('the app did not finish before the deadline');
	for (const line of result.fatal) problems.push(`fatal output: ${line}`);
	for (const report of result.reports) {
		if (report.event === 'renderer-error') {
			problems.push(`renderer error (${String(report['kind'])}): ${String(report['detail'])}`);
		} else if (report.event === 'renderer-unknown') {
			problems.push(`unexpected renderer report: ${JSON.stringify(report)}`);
		}
	}
	const exit = result.exit;
	if (exit && !result.stoppedAtDeadline && (exit.code !== 0 || exit.signal !== null)) {
		problems.push(`the app exited with ${exit.signal ?? `code ${exit.code}`}`);
	}
	return problems;
}

/**
 * The native steps in order, each tagged with the version of the process that
 * reported it (from that process's `boot`), e.g. `mounted@0.6.16`.
 */
export function steps(reports: readonly Report[]): string[] {
	const versions = new Map<number, string>();
	const out: string[] = [];
	for (const report of reports) {
		if (report.event === 'renderer-error' || report.event === 'renderer-unknown') continue;
		if (report.event === 'boot') versions.set(report.pid, String(report['version']));
		out.push(`${report.event}@${versions.get(report.pid) ?? '?'}`);
	}
	return out;
}

function sequenceProblems(result: RunResult, expected: readonly string[]): string[] {
	const actual = steps(result.reports);
	if (actual.join(' ') === expected.join(' ')) return [];
	return [`expected steps\n    ${expected.join(' ')}\n  got\n    ${actual.join(' ') || '(none)'}`];
}

/** An i18n key left untranslated, e.g. `desktop.welcome.pageTitle`. */
const I18N_KEY = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/;

function mountProblems(result: RunResult): string[] {
	const problems: string[] = [];
	for (const report of result.reports.filter((r) => r.event === 'mounted')) {
		const path = String(report['path']);
		const title = String(report['title']);
		if (!path.startsWith('/desktop/welcome'))
			problems.push(`mounted on ${path}, not the welcome page`);
		if (I18N_KEY.test(title)) problems.push(`the page title is an untranslated key: ${title}`);
	}
	return problems;
}

/** A fresh profile boots `version` and mounts the welcome page. */
export function smokeProblems(result: RunResult, version: string): string[] {
	return [
		...launchProblems(result),
		...sequenceProblems(result, [`boot@${version}`, `mounted@${version}`, `done@${version}`]),
		...mountProblems(result),
	];
}

/** `from` finds, verifies and installs `to`, restarts, and `to` is current. */
export function updatedProblems(result: RunResult, from: string, to: string): string[] {
	const problems = [
		...launchProblems(result),
		...sequenceProblems(result, [
			`boot@${from}`,
			`mounted@${from}`,
			`update-found@${from}`,
			`update-downloaded@${from}`,
			`restarting@${from}`,
			`boot@${to}`,
			`mounted@${to}`,
			`no-update@${to}`,
			`done@${to}`,
		]),
		...mountProblems(result),
	];
	const found = result.reports.find((r) => r.event === 'update-found');
	if (found && (found['version'] !== to || found['currentVersion'] !== from)) {
		problems.push(`update-found reported ${JSON.stringify(found)}`);
	}
	const pids = new Set(result.reports.filter((r) => r.event === 'boot').map((r) => r.pid));
	if (pids.size !== 2) problems.push(`expected two processes to boot, saw ${pids.size}`);
	return problems;
}

/** The endpoint answers 204: `version` keeps running. */
export function noUpdateProblems(result: RunResult, version: string): string[] {
	return [
		...launchProblems(result),
		...sequenceProblems(result, [
			`boot@${version}`,
			`mounted@${version}`,
			`no-update@${version}`,
			`done@${version}`,
		]),
	];
}

/** The bundle fails verification: nothing is installed and `version` keeps running. */
export function rejectedProblems(result: RunResult, version: string): string[] {
	const problems = [
		...launchProblems(result),
		...sequenceProblems(result, [
			`boot@${version}`,
			`mounted@${version}`,
			`update-found@${version}`,
			`update-error@${version}`,
			`done@${version}`,
		]),
	];
	const error = result.reports.find((r) => r.event === 'update-error');
	if (error && (error['stage'] !== 'download' || error['kind'] !== 'signature')) {
		problems.push(`expected a signature failure while downloading, got ${JSON.stringify(error)}`);
	}
	return problems;
}

/**
 * A release build has no report channel: it must still be running when the
 * deadline passes, and must not have printed anything fatal on the way.
 */
export function livenessProblems(result: RunResult): string[] {
	const problems: string[] = [];
	if (result.spawnError) problems.push(`could not start the app: ${result.spawnError}`);
	if (!result.aliveAtDeadline) {
		const exit = result.exit;
		problems.push(
			`the app exited before the deadline${exit ? ` (${exit.signal ?? `code ${exit.code}`})` : ''}`
		);
	}
	for (const line of result.fatal) problems.push(`fatal output: ${line}`);
	return problems;
}
