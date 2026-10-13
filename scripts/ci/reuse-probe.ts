import { assertVerification, eligibleRun, type Run, type Verification } from './reuse';

export const MAIN_WAIT_MS = 35 * 60 * 1000;
export function mainDecision(run: Run | undefined, elapsed: number) {
	if (!run) return elapsed < 90_000 ? 'wait' : 'fallback';
	if (run.status !== 'completed') return elapsed < MAIN_WAIT_MS ? 'wait' : 'fallback';
	if (run.conclusion === 'cancelled' || run.conclusion === 'skipped') return 'fallback';
	return run.conclusion === 'success' ? 'inspect' : 'block';
}
interface Probe {
	repo: string;
	sha: string;
	runs: () => Run[];
	current: (run: Run) => Run;
	evidence: (run: Run) => Verification;
	now: () => number;
	sleep: () => Promise<unknown>;
}
// Failures in trusted completed main CI block publication. Missing or uncertain
// evidence never grants reuse: it requests the full exact-commit fallback.
export async function probeMainCI(probe: Probe): Promise<{ run?: Run; reason?: string }> {
	const start = probe.now();
	const newest = () =>
		probe
			.runs()
			.filter((candidate) => eligibleRun(candidate, probe.sha, probe.now()))
			.sort((a, b) => b.id - a.id)[0];
	while (probe.now() - start < MAIN_WAIT_MS) {
		let run: Run | undefined;
		try {
			run = newest();
		} catch {
			return { reason: 'Main lookup unavailable' };
		}
		const decision = mainDecision(run, probe.now() - start);
		if (decision === 'block') throw new Error(`Main CI failed: ${run!.html_url}`);
		if (decision === 'fallback') return { reason: 'No qualifying main run' };
		if (decision === 'inspect' && run) {
			let evidence: Verification, current: Run, latest: Run | undefined;
			try {
				evidence = probe.evidence(run);
				current = probe.current(run);
				latest = newest();
			} catch {
				return { reason: 'Verification evidence unavailable' };
			}
			if (mainDecision(latest, probe.now() - start) === 'block')
				throw new Error(`Main CI failed: ${latest!.html_url}`);
			if (latest?.id === current.id && mainDecision(current, probe.now() - start) === 'block')
				throw new Error(`Main CI failed: ${current.html_url}`);
			if (
				latest?.id !== run.id ||
				latest.run_attempt !== run.run_attempt ||
				latest.status !== 'completed' ||
				latest.conclusion !== 'success' ||
				current.id !== run.id ||
				current.run_attempt !== run.run_attempt ||
				current.status !== 'completed' ||
				current.conclusion !== 'success'
			)
				return { reason: 'Main CI changed during evidence lookup' };
			try {
				assertVerification(evidence, current, probe.repo);
			} catch {
				return { reason: 'Verification evidence does not match the full run' };
			}
			return { run: current };
		}
		await probe.sleep();
	}
	return { reason: 'Main wait budget exhausted' };
}
