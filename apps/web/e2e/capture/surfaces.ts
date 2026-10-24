/**
 * The named surfaces `bun run capture --surface <name>` knows: how to reach
 * each one in the seeded app and what has to be on screen before it counts as
 * loaded. Detail pages are reached by clicking the seeded row, never by a
 * stored id, because ids differ per deployment and per reseed.
 *
 * The data comes from `bun run dev:seed` (apps/api/convex/seedDemo/fixtures).
 * A fixture the surface needs and cannot find fails the run; it never falls
 * back to capturing whatever is on screen.
 */

import type { Locator, Page } from '@playwright/test';

export class CaptureFailure extends Error {}

/** A cold `nuxt dev` compiles each route on first visit; the first load can take minutes. */
export const BOOT_TIMEOUT_MS = 180_000;
const READY_TIMEOUT_MS = 60_000;

const SEED_HINT = 'Is the stack seeded? `bun run dev:seed` adds the demo data.';
const POSTBOX_HINT =
	'The Postbox needs the Email client feature: turn it on under Settings > Features, then run the capture again.';

/** Navigates to an app route and waits until the SPA has booted. */
export async function openRoute(page: Page, appUrl: string, route: string): Promise<void> {
	await page.goto(new URL(route, appUrl).href, { waitUntil: 'domcontentloaded' });
	// The cold-boot splash (app/spa-loading-template.html) stays until Nuxt mounts.
	await page.locator('.owlat-spa').waitFor({ state: 'detached', timeout: BOOT_TIMEOUT_MS });
}

async function needs(locator: Locator, what: string, hint = SEED_HINT): Promise<void> {
	try {
		await locator.first().waitFor({ state: 'visible', timeout: READY_TIMEOUT_MS });
	} catch {
		throw new CaptureFailure(`${what} did not appear. ${hint}`);
	}
}

async function arrives(page: Page, pattern: RegExp, what: string): Promise<void> {
	try {
		await page.waitForURL(pattern, { timeout: READY_TIMEOUT_MS });
	} catch {
		throw new CaptureFailure(`${what} did not open (still at ${new URL(page.url()).pathname}).`);
	}
}

export interface Surface {
	readonly name: string;
	readonly description: string;
	open(page: Page, appUrl: string): Promise<void>;
}

const SEEDED_CONTACT = { email: 'ada.lovelace@example.com', name: 'Ada Lovelace' };
const SENT_CAMPAIGN = 'Summer Sale 2026';
const DRAFT_CAMPAIGN = 'June Announcements (draft)';
/** The topic the draft is addressed to (fixtures/campaigns.json, topics.json). */
const DRAFT_TOPIC = 'Announcements';
const SHARED_INBOX = 'Team';
const SHARED_MESSAGE = {
	subject: 'Invoice #2041 shows our old billing address',
	bodyLine: '42 Harbor Way, Suite 300',
};

async function openCampaignList(page: Page, appUrl: string): Promise<void> {
	await openRoute(page, appUrl, '/dashboard/campaigns?status=all');
	const main = page.locator('main');
	await needs(
		main.getByRole('link', { name: SENT_CAMPAIGN }),
		`The seeded campaign "${SENT_CAMPAIGN}"`
	);
	await needs(
		main.getByRole('link', { name: DRAFT_CAMPAIGN }),
		`The seeded campaign "${DRAFT_CAMPAIGN}"`
	);
}

async function openContactList(page: Page, appUrl: string): Promise<void> {
	await openRoute(page, appUrl, '/dashboard/audience/contacts');
	await needs(
		page.locator('main').getByText(SEEDED_CONTACT.email, { exact: true }),
		`The seeded contact ${SEEDED_CONTACT.email}`
	);
}

/** The shared Team inbox, found through the mailbox rail, in the given inbox view. */
async function openSharedInbox(
	page: Page,
	appUrl: string,
	view: 'Priority' | 'All mail'
): Promise<void> {
	await openRoute(page, appUrl, '/dashboard/postbox/inbox');
	const rail = page.locator(`a[title="${SHARED_INBOX}"]`);
	await needs(rail, `The shared "${SHARED_INBOX}" inbox in the mailbox rail`, POSTBOX_HINT);
	const href = await rail.first().getAttribute('href');
	if (!href?.includes('mailbox=')) {
		throw new CaptureFailure(`The "${SHARED_INBOX}" rail entry has no mailbox link (${href}).`);
	}
	// A fresh load of the inbox's own route, not a switch from the default
	// mailbox: the switch re-renders the open view while it is still loading.
	await openRoute(page, appUrl, href);
	// The view is a per-user setting the app saves; choosing it every time keeps
	// the capture independent of whatever the last run or a person left behind.
	const tab = page.getByRole('tablist', { name: 'Inbox view' }).getByRole('tab', { name: view });
	await needs(tab, `The "${view}" inbox view switch`);
	if ((await tab.first().getAttribute('aria-selected')) !== 'true') await tab.first().click();
}

export const SURFACES: readonly Surface[] = [
	{
		name: 'dashboard',
		description: 'The home dashboard (/dashboard).',
		async open(page, appUrl) {
			await openRoute(page, appUrl, '/dashboard');
			await needs(
				page.locator('main').getByRole('heading', { level: 1 }),
				'The dashboard greeting'
			);
		},
	},
	{
		// Before postbox-today: opening the message marks it read, and the
		// Priority view's counts include it.
		name: 'postbox',
		description: `The shared ${SHARED_INBOX} inbox (All mail) with "${SHARED_MESSAGE.subject}" open in the reader.`,
		async open(page, appUrl) {
			await openSharedInbox(page, appUrl, 'All mail');
			const row = page.locator('li', { hasText: SHARED_MESSAGE.subject });
			await needs(row, `The seeded message "${SHARED_MESSAGE.subject}"`);
			await row.first().getByText(SHARED_MESSAGE.subject).first().click();
			await arrives(page, /\/dashboard\/postbox\/inbox\/[^/?]+/, 'The message');
			await needs(page.getByText(SHARED_MESSAGE.bodyLine), 'The message body');
			// Opening marks the message read. Wait until the list shows that, so
			// every capture of the pair shows the same (read) state.
			try {
				await row
					.first()
					.locator('button[aria-label="Mark unread"]')
					.waitFor({ state: 'attached', timeout: READY_TIMEOUT_MS });
			} catch {
				throw new CaptureFailure('The opened message never showed as read in the list.');
			}
		},
	},
	{
		name: 'postbox-today',
		description: `The shared ${SHARED_INBOX} inbox in the Priority view.`,
		async open(page, appUrl) {
			await openSharedInbox(page, appUrl, 'Priority');
			const main = page.locator('main');
			await needs(main.getByText("here's where things stand"), 'The Priority view greeting');
			await needs(main.getByRole('heading', { name: /^Needs you/ }), 'The "Needs you" section');
			await needs(main.getByText('Ben Ortiz', { exact: true }), 'The seeded sender Ben Ortiz');
		},
	},
	{
		name: 'contacts',
		description: 'The contact list (/dashboard/audience/contacts).',
		open: openContactList,
	},
	{
		name: 'contact',
		description: `The contact page of the seeded ${SEEDED_CONTACT.name}.`,
		async open(page, appUrl) {
			await openContactList(page, appUrl);
			await page.locator('main').getByText(SEEDED_CONTACT.email, { exact: true }).first().click();
			await arrives(page, /\/dashboard\/audience\/contacts\/[^/?]+$/, 'The contact page');
			await needs(
				page.getByRole('heading', { name: SEEDED_CONTACT.name }),
				`The heading "${SEEDED_CONTACT.name}"`
			);
		},
	},
	{
		name: 'campaigns',
		description: 'The campaign list, All tab (/dashboard/campaigns?status=all).',
		open: openCampaignList,
	},
	{
		name: 'campaign-report',
		description: `The report of the sent campaign "${SENT_CAMPAIGN}".`,
		async open(page, appUrl) {
			await openCampaignList(page, appUrl);
			await page.locator('main').getByRole('link', { name: SENT_CAMPAIGN }).first().click();
			await arrives(page, /\/dashboard\/campaigns\/[^/]+\/report$/, 'The campaign report');
			await needs(
				page.getByRole('heading', { name: SENT_CAMPAIGN }),
				`The heading "${SENT_CAMPAIGN}"`
			);
			await needs(
				page.locator('main').getByText('Delivered', { exact: true }),
				'The delivery funnel'
			);
		},
	},
	{
		name: 'campaign-edit',
		description: `The editor of the draft campaign "${DRAFT_CAMPAIGN}".`,
		async open(page, appUrl) {
			await openCampaignList(page, appUrl);
			await page.locator('main').getByRole('link', { name: DRAFT_CAMPAIGN }).first().click();
			await arrives(page, /\/dashboard\/campaigns\/[^/]+\/edit$/, 'The campaign editor');
			await needs(
				page.getByRole('heading', { name: 'Edit campaign' }),
				'The heading "Edit campaign"'
			);
			await needs(
				page.locator('main').getByText(DRAFT_CAMPAIGN),
				`The campaign name "${DRAFT_CAMPAIGN}"`
			);
			// The recipient picker shows a "no topics yet" note, not a skeleton,
			// until the topics load; wait for the draft's seeded topic instead.
			await needs(
				page.locator('main select', { hasText: DRAFT_TOPIC }),
				`The recipient topic "${DRAFT_TOPIC}"`
			);
		},
	},
];

export const SURFACE_NAMES: readonly string[] = SURFACES.map((surface) => surface.name);
