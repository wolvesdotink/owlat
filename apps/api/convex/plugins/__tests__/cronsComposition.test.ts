import { describe, expect, it } from 'vitest';
import crons from '../../crons';

interface CronRecord {
	readonly crons: Record<string, { readonly name: string; readonly schedule: unknown }>;
}

const registered = (crons as unknown as CronRecord).crons;

// A representative slice of the built-in cron identifiers. If appending plugin
// crons ever disturbed the hand-written core table, these would disappear.
const CORE_CRON_SAMPLE = [
	'process scheduled campaigns',
	'reconcile sending campaigns',
	'process account deletions',
	'cleanup webhook logs',
	'retention: audit logs',
	'inbox wake snoozed threads',
	'postbox dispatch overdue drafts',
	'auto-merge duplicate contacts',
];

describe('cron composition', () => {
	it('preserves every sampled built-in cron identifier', () => {
		for (const identifier of CORE_CRON_SAMPLE) {
			expect(registered[identifier]).toBeDefined();
		}
	});

	it('registers no plugin crons from the empty bundled catalog (no-op append)', () => {
		const pluginCronNames = Object.keys(registered).filter((identifier) =>
			identifier.startsWith('plugin.')
		);
		expect(pluginCronNames).toEqual([]);
	});

	it('keeps every core cron identifier collision-safe from the plugin namespace', () => {
		// Core crons are human-readable phrases; the plugin namespace is
		// `plugin.<id>.<localId>`. No core identifier may start with `plugin.`.
		for (const identifier of Object.keys(registered)) {
			expect(identifier.startsWith('plugin.')).toBe(false);
		}
	});
});
