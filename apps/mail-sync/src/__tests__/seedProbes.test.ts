/**
 * (d)/(step 3) The seed-probe sweep: the poller walks seed accounts, reports
 * folders, and EXECUTES the hygiene the backend planned — marks read, fires
 * the occasional click, and surfaces the rotation reminder.
 *
 * Every dependency is injected, so this exercises the real sweep with no IMAP
 * server and no network at all.
 */

import { describe, it, expect } from 'vitest';
import { extractLinkTargets, extractProbeLinkTargets } from '../seedMailbox.js';
import { chooseHygieneClickTarget } from '../seedProbes.js';
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
	// Counters are read through getters: a plain number is snapshotted at build
	// time and every assertion against it silently passes.
	opened: () => number;
	searches: () => number;
} {
	const recorded: Recorded[] = [];
	const markedRead: SeedProbeLocation[] = [];
	const clicked: string[] = [];
	const reminded: string[] = [];
	let opened = 0;
	let foldersSearched = 0;

	const session: SeedMailboxSession = {
		findProbes: async (probeIds) => {
			foldersSearched += 1;
			const found = new Map<string, SeedProbeLocation>();
			for (const probeId of probeIds) {
				const folderName = overrides.folders?.[probeId];
				if (folderName !== undefined) found.set(probeId, { folderName, uid: 7 });
			}
			return found;
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
		listWork: async () => ({ items: overrides.work, cursor: null, isDone: true }),
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
	return {
		deps,
		recorded,
		markedRead,
		clicked,
		reminded,
		opened: () => opened,
		searches: () => foldersSearched,
	};
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

	it('locates a whole batch of probes in ONE pass, not one pass per probe', async () => {
		const h = buildDeps({
			work: [{ ...account, probeIds: ['sp_a', 'sp_b', 'sp_c'] }],
			folders: { sp_a: 'INBOX', sp_b: '[Gmail]/Spam' },
		});
		const result = await runSeedProbeSweep(h.deps);
		expect(h.searches()).toBe(1);
		expect(h.recorded).toEqual([
			{ probeId: 'sp_a', folderName: 'INBOX' },
			{ probeId: 'sp_b', folderName: '[Gmail]/Spam' },
			{ probeId: 'sp_c', folderName: null },
		]);
		expect(result.missing).toBe(1);
	});

	it('reports a probe past the give-up horizon without opening the mailbox', async () => {
		const h = buildDeps({
			work: [{ ...account, probeIds: [], expiredProbeIds: ['sp_old'] }],
		});
		const result = await runSeedProbeSweep(h.deps);
		expect(h.opened()).toBe(0);
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

describe('runSeedProbeSweep — the cursor', () => {
	it('asks for the page the caller resumed from and hands back the next one', async () => {
		const asked: Array<string | null> = [];
		const h = buildDeps({ work: [account], folders: { sp_a: 'INBOX' } });
		const deps: SeedProbeDeps = {
			...h.deps,
			listWork: async (_now, cursor) => {
				asked.push(cursor);
				return { items: [account], cursor: 'page-2', isDone: false };
			},
		};
		const result = await runSeedProbeSweep(deps, 'page-1');
		expect(asked).toEqual(['page-1']);
		expect(result.cursor).toBe('page-2');
	});

	it('reports a null cursor once the sweep wrapped around', async () => {
		const h = buildDeps({ work: [account], folders: { sp_a: 'INBOX' } });
		const result = await runSeedProbeSweep(h.deps);
		expect(result.cursor).toBeNull();
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
			cursor: null,
		});
		expect(h.opened()).toBe(0);
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

/**
 * The click has to survive the wire, not just a fixture.
 *
 * A real probe is a full RFC 822 message, and campaign HTML with wrapped
 * tracking links is emitted QUOTED-PRINTABLE: every long href is broken across
 * `=\r\n` soft line breaks. Scanning the raw source hands
 * `chooseHygieneClickTarget` a corrupted URL that still starts with `https://`,
 * so the click is fired at an address that does not exist and the failure is
 * swallowed — the hygiene click never happens in production while a test on
 * plain unencoded HTML stays green. This is that test.
 */
describe('extractProbeLinkTargets — the RAW probe, transfer-encoded', () => {
	const longUrl =
		'https://track.example/t/c/sp_abcdefghij0123456789kl/9f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e/3f9d';

	function quotedPrintableMessage(url: string): string {
		// Exactly the shape compose/encoding.ts produces: <=76 octet lines with a
		// trailing `=` soft break.
		const html = `<html><body><p>Hi</p><a href="${url}">Read more</a></body></html>`;
		const lines: string[] = [];
		for (let i = 0; i < html.length; i += 60) lines.push(html.slice(i, i + 60));
		return [
			'From: news@org.example',
			'To: owlat.seed.01@gmail.example',
			'Subject: March newsletter',
			'MIME-Version: 1.0',
			'Content-Type: text/html; charset=utf-8',
			'Content-Transfer-Encoding: quoted-printable',
			'',
			lines.join('=\r\n'),
		].join('\r\n');
	}

	it('recovers a soft-line-broken href intact', () => {
		const targets = extractProbeLinkTargets(quotedPrintableMessage(longUrl));
		expect(targets).toEqual([longUrl]);
	});

	it('yields a target the hygiene chooser will actually click', () => {
		const targets = extractProbeLinkTargets(quotedPrintableMessage(longUrl));
		expect(chooseHygieneClickTarget(targets)).toBe(longUrl);
	});

	it('scanning the RAW source instead would have produced a broken URL', () => {
		// The regression this guards, stated as an assertion: the naive path finds
		// a truncated href that still passes the `^https?://` shape check.
		const raw = quotedPrintableMessage(longUrl);
		const naive = extractLinkTargets(raw);
		expect(naive).not.toEqual([longUrl]);
	});

	it('returns nothing for a message with no HTML part', () => {
		const plain = [
			'From: news@org.example',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'no links here',
		].join('\r\n');
		expect(extractProbeLinkTargets(plain)).toEqual([]);
	});
});

/**
 * "The occasional click" has to look like a subscriber reading the mail, which
 * means it must be a CONTENT link. The first href in a template is just as
 * likely to be the footer's one-click unsubscribe.
 */
describe('the hygiene click is chosen deliberately', () => {
	it('skips the unsubscribe and preference footer links', () => {
		expect(
			chooseHygieneClickTarget([
				'https://convex.example/unsub/probe/token',
				'https://app.example/preferences?token=abc',
				'https://track.example/t/c/sp_x/abc/sig',
			])
		).toBe('https://track.example/t/c/sp_x/abc/sig');
	});

	it('skips the open pixel and any other image target', () => {
		expect(
			chooseHygieneClickTarget([
				'https://track.example/t/o/sp_x',
				'https://cdn.example/hero.png',
				'https://org.example/read',
			])
		).toBe('https://org.example/read');
	});

	it('clicks NOTHING rather than clicking an unsubscribe link', () => {
		expect(
			chooseHygieneClickTarget([
				'https://convex.example/unsub/probe/token',
				'mailto:unsubscribe@org.example',
			])
		).toBeUndefined();
	});

	it('is undefined for an empty template', () => {
		expect(chooseHygieneClickTarget([])).toBeUndefined();
	});
});
