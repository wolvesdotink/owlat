/**
 * (d)/(step 3) The seed-probe sweep: the poller walks seed accounts, reports
 * folders, and EXECUTES the hygiene the backend planned — marks read, fires
 * the occasional click, and surfaces the rotation reminder.
 *
 * Every dependency is injected, so this exercises the real sweep with no IMAP
 * server and no network at all.
 */

import { describe, it, expect } from 'vitest';
import { extractLinkTargets } from '../seedMailbox.js';
import {
	runSeedProbeSweep,
	type SeedMailboxSession,
	type SeedProbeDeps,
	type SeedProbeLocation,
	type SeedProbeWorkItem,
} from '../seedProbes.js';

const NOW = 1_800_000_000_000;

interface Recorded {
	probeId: string;
	folderName: string | null;
}

function buildDeps(overrides: {
	work: SeedProbeWorkItem[];
	folders?: Record<string, string>;
	hygiene?: Record<string, { markRead: boolean; click: boolean }>;
	placements?: Record<string, 'inbox' | 'category' | 'spam' | 'deleted' | 'missing'>;
}): {
	deps: SeedProbeDeps;
	recorded: Recorded[];
	markedRead: SeedProbeLocation[];
	clicked: string[];
	reminded: string[];
	opened: number;
} {
	const recorded: Recorded[] = [];
	const markedRead: SeedProbeLocation[] = [];
	const clicked: string[] = [];
	const reminded: string[] = [];
	let opened = 0;

	const session: SeedMailboxSession = {
		findProbe: async (probeId) => {
			const folderName = overrides.folders?.[probeId];
			return folderName === undefined ? null : { folderName, uid: 7 };
		},
		markRead: async (location) => {
			markedRead.push(location);
		},
		linkTargets: async () => ['https://track.example/t/c/sp_x/abc/sig'],
		close: async () => undefined,
	};

	const deps: SeedProbeDeps = {
		now: () => NOW,
		random: () => 0.05,
		listWork: async () => overrides.work,
		openMailbox: async () => {
			opened += 1;
			return session;
		},
		recordClassification: async ({ probeId, folderName }) => {
			recorded.push({ probeId, folderName });
			return {
				recorded: true,
				placement: overrides.placements?.[probeId] ?? (folderName === null ? 'missing' : 'inbox'),
				hygiene: overrides.hygiene?.[probeId] ?? { markRead: true, click: false },
			};
		},
		markRotationReminded: async ({ accountId }) => {
			reminded.push(accountId);
		},
		click: async (url) => {
			clicked.push(url);
		},
	};
	return { deps, recorded, markedRead, clicked, reminded, opened };
}

const account: SeedProbeWorkItem = {
	organizationId: 'org_1',
	accountId: 'acct_1',
	address: 'owlat.seed.01@gmail.example',
	provider: 'gmail',
	probeIds: ['sp_a'],
	expiredProbeIds: [],
	rotationReminderDue: false,
};

describe('runSeedProbeSweep — classification', () => {
	it('reports the folder a probe was found in', async () => {
		const h = buildDeps({ work: [account], folders: { sp_a: '[Gmail]/Spam' } });
		const result = await runSeedProbeSweep(h.deps);
		expect(h.recorded).toEqual([{ probeId: 'sp_a', folderName: '[Gmail]/Spam' }]);
		expect(result.classified).toBe(1);
	});

	it('reports MISSING when the probe is in no folder at all', async () => {
		const h = buildDeps({ work: [account], folders: {} });
		const result = await runSeedProbeSweep(h.deps);
		expect(h.recorded).toEqual([{ probeId: 'sp_a', folderName: null }]);
		expect(result.missing).toBe(1);
	});

	it('reports a probe past the give-up horizon without opening the mailbox', async () => {
		const h = buildDeps({
			work: [{ ...account, probeIds: [], expiredProbeIds: ['sp_old'] }],
		});
		const result = await runSeedProbeSweep(h.deps);
		expect(h.opened).toBe(0);
		expect(h.recorded).toEqual([{ probeId: 'sp_old', folderName: null }]);
		expect(result.missing).toBe(1);
	});
});

describe('runSeedProbeSweep — the hygiene EXECUTOR', () => {
	it('marks a found probe read', async () => {
		const h = buildDeps({ work: [account], folders: { sp_a: 'INBOX' } });
		const result = await runSeedProbeSweep(h.deps);
		expect(h.markedRead).toEqual([{ folderName: 'INBOX', uid: 7 }]);
		expect(result.markedRead).toBe(1);
	});

	it('fires the occasional click when the backend asks for one', async () => {
		const h = buildDeps({
			work: [account],
			folders: { sp_a: 'INBOX' },
			hygiene: { sp_a: { markRead: true, click: true } },
		});
		const result = await runSeedProbeSweep(h.deps);
		expect(h.clicked).toEqual(['https://track.example/t/c/sp_x/abc/sig']);
		expect(result.clicked).toBe(1);
	});

	it('does not click when the backend did not ask', async () => {
		const h = buildDeps({ work: [account], folders: { sp_a: 'INBOX' } });
		await runSeedProbeSweep(h.deps);
		expect(h.clicked).toEqual([]);
	});

	it('never opens or clicks a probe it could not find', async () => {
		const h = buildDeps({
			work: [account],
			folders: {},
			hygiene: { sp_a: { markRead: true, click: true } },
		});
		await runSeedProbeSweep(h.deps);
		expect(h.markedRead).toEqual([]);
		expect(h.clicked).toEqual([]);
	});

	it('surfaces the rotation reminder on schedule', async () => {
		const h = buildDeps({
			work: [{ ...account, rotationReminderDue: true }],
			folders: { sp_a: 'INBOX' },
		});
		const result = await runSeedProbeSweep(h.deps);
		expect(h.reminded).toEqual(['acct_1']);
		expect(result.rotationReminders).toBe(1);
	});
});

describe('runSeedProbeSweep — D2: absence is a supported configuration', () => {
	it('is a silent no-op with no seed mailboxes', async () => {
		const h = buildDeps({ work: [] });
		const result = await runSeedProbeSweep(h.deps);
		expect(result).toEqual({
			accounts: 0,
			classified: 0,
			missing: 0,
			markedRead: 0,
			clicked: 0,
			rotationReminders: 0,
		});
		expect(h.opened).toBe(0);
		expect(h.recorded).toEqual([]);
	});

	it('never throws when a seed mailbox cannot be opened', async () => {
		const h = buildDeps({ work: [account] });
		const deps: SeedProbeDeps = {
			...h.deps,
			openMailbox: async () => {
				throw new Error('auth failed');
			},
		};
		await expect(runSeedProbeSweep(deps)).resolves.toMatchObject({ accounts: 1, classified: 0 });
	});
});

describe('extractLinkTargets', () => {
	it('finds the wrapped redirect links a probe carries', () => {
		expect(
			extractLinkTargets(
				'<a href="https://track.example/t/c/1/2/3">x</a><a href="mailto:a@b">y</a>'
			)
		).toEqual(['https://track.example/t/c/1/2/3']);
	});

	it('returns nothing for a body with no links', () => {
		expect(extractLinkTargets('<p>hi</p>')).toEqual([]);
	});
});
