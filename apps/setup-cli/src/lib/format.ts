/**
 * Terminal formatting shared by the commands that report backend row counts
 * (`seed`, `reset`, `sample-data`).
 */

import pc from 'picocolors';

/**
 * `15 contacts, 3 topics` with the numbers highlighted and zero counts
 * dropped. An all-zero or empty map prints `emptyText`, dimmed, rather than
 * an empty line.
 */
export function formatCounts(counts: Record<string, number>, emptyText = 'none'): string {
	return (
		Object.entries(counts)
			.filter(([, n]) => n > 0)
			.map(([k, n]) => `${pc.cyan(String(n))} ${k}`)
			.join(', ') || pc.dim(emptyText)
	);
}
