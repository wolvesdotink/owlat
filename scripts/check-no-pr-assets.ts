import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Plans, PR evidence and the screenshot harness stay out of the repository.
 *
 * A plan is tracked in the issue that owns it and a merged PR is the record of
 * what was built, so a committed copy is a second account that drifts. Before
 * and after captures are uploaded to the PR they prove. The mock-Convex
 * harness is local scaffolding (CLAUDE.md, "Pull requests").
 *
 * `.gitignore` lists the same directories, but `git add -f` gets past it, so
 * this reads the index (`git ls-files`) rather than the working tree. A file
 * deleted from the index is not listed, so removing one of these files passes.
 */

/** Tracked files under these directories fail the gate, whatever their type. */
export const PROHIBITED_DIRECTORIES: readonly string[] = [
	// Implementation plans and their review notes.
	'docs/plans/',
	'docs/ux-plan/',
	'docs/ui-polish/',
	// Before/after captures for a PR.
	'docs/screenshots/',
	// The mock-Convex screenshot harness and its fixtures.
	'scripts/uiaudit/',
	'apps/web/app/lib/uiMock/',
];

/**
 * Captures and recordings under the internal `docs/` tree. Product
 * documentation with images lives in `apps/docs/` and `apps/marketing/`, which
 * this does not touch.
 */
const DOCS_MEDIA = /^docs\/.+\.(?:png|jpe?g|gif|webp|avif|webm|mp4|mov)$/i;

/** Session plans written at the repository root, the shapes `.gitignore` lists. */
const ROOT_PLAN = /^[^/]*(?:_PLAN_[^/]*\.(?:md|html)|-plan\.html)$/;

export interface PrAssetFinding {
	readonly path: string;
	readonly reason: string;
}

export function findPrAssets(trackedPaths: readonly string[]): PrAssetFinding[] {
	const findings: PrAssetFinding[] = [];
	for (const path of trackedPaths) {
		const directory = PROHIBITED_DIRECTORIES.find((prefix) => path.startsWith(prefix));
		if (directory) findings.push({ path, reason: `under ${directory}` });
		else if (DOCS_MEDIA.test(path))
			findings.push({ path, reason: 'image or recording under docs/' });
		else if (ROOT_PLAN.test(path)) findings.push({ path, reason: 'plan at the repository root' });
	}
	return findings;
}

function trackedPaths(root: string): string[] {
	const output = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
	return output.split('\0').filter((path) => path !== '');
}

if (import.meta.main) {
	const root = join(import.meta.dirname, '..');
	const findings = findPrAssets(trackedPaths(root));
	if (findings.length > 0) {
		console.error('Plans, PR evidence and harness files must not be committed:');
		for (const { path, reason } of findings) console.error(`  ${path} (${reason})`);
		console.error(
			'Upload screenshots and recordings to the PR description, keep plans in the issue that owns the work, and keep the screenshot harness local.'
		);
		process.exit(1);
	}
	console.log('lint:no-pr-assets: no plans, PR evidence or harness files are tracked.');
}
