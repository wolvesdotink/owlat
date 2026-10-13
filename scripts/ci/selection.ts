export interface Task {
	task: string;
	package: string;
	directory: string;
	command?: string;
}
export interface Workspace {
	package: string;
	name: string;
	directory: string;
}
export function coverageWorkspaces(tasks: Task[]): Workspace[] {
	const unique = new Map<string, Workspace>();
	for (const task of tasks) {
		if (task.task !== 'test:coverage' || !task.command || task.command === '<NONEXISTENT>')
			continue;
		if (!/^@owlat\/[a-z0-9-]+$/.test(task.package)) throw new Error('Invalid CI workspace');
		unique.set(task.package, {
			package: task.package,
			name: task.package.slice(7),
			directory: task.directory,
		});
	}
	return [...unique.values()].sort((a, b) => a.package.localeCompare(b.package));
}
// Duration weights balance small suites; heavy suites have dedicated jobs.
const weights: Record<string, number> = { 'email-builder': 4, shared: 3, docs: 3, 'plugin-kit': 2 };
export function groupWorkspaces(workspaces: Workspace[], count = 4) {
	const small = workspaces.filter((w) => !['api', 'web', 'mta', 'desktop'].includes(w.name));
	const bins = Array.from({ length: Math.min(count, small.length) }, (_, id) => ({
		id: id + 1,
		workspaces: [] as Workspace[],
		weight: 0,
	}));
	for (const workspace of [...small].sort(
		(a, b) => (weights[b.name] ?? 1) - (weights[a.name] ?? 1)
	)) {
		const bin = [...bins].sort((a, b) => a.weight - b.weight || a.id - b.id)[0]!;
		bin.workspaces.push(workspace);
		bin.weight += weights[workspace.name] ?? 1;
	}
	return bins.map(({ id, workspaces: items }) => ({ id, workspaces: items }));
}
export function expectedJobs(selection: {
	groups: unknown[];
	api: boolean;
	web: boolean;
	mta: boolean;
	images: unknown[];
	java: boolean;
}): string[] {
	return [
		'detect',
		'lint',
		'typecheck',
		'ramp-gate-matrix',
		...(selection.groups.length ? ['test'] : []),
		...(selection.api ? ['test-api', 'test-api-merge'] : []),
		...(selection.web ? ['test-web', 'test-web-merge'] : []),
		...(selection.mta ? ['test-mta'] : []),
		...(selection.images.length ? ['docker-build'] : []),
		...(selection.java ? ['sdk-java'] : []),
	];
}
export function assertJobResults(expected: string[], needs: Record<string, { result: string }>) {
	if (!expected.includes('detect') || new Set(expected).size !== expected.length)
		throw new Error('Invalid expected CI job manifest');
	for (const job of expected)
		if (needs[job]?.result !== 'success') throw new Error(`Selected CI job ${job} did not succeed`);
	for (const [job, outcome] of Object.entries(needs))
		if (!expected.includes(job) && outcome.result !== 'skipped')
			throw new Error(`Unexpected CI job ${job}: ${outcome.result}`);
}
