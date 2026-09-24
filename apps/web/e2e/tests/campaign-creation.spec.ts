import { test, expect } from '@playwright/test';
import { CampaignWizardPage } from '../page-objects/CampaignWizardPage';
import { STORAGE_STATE } from '../storage-state';

/**
 * The wizard is Setup → Content → Review (`pages/dashboard/campaigns/new.vue`).
 *
 * Two tests were deleted here rather than repaired. They drove an AUDIENCE step
 * that no longer exists, through `#fromName` / `#fromEmail` fields that the
 * sender picker replaced — and completing the Setup step now needs a verified
 * sending identity, which a blank instance cannot have and the suite has no way
 * to seed (the "force verify" shortcut is `import.meta.dev`-only and absent from
 * the production build the suite drives). A test that cannot reach its second
 * step is not a test of a wizard. Reinstating them needs a seedable sender
 * first; the per-field validation is covered by `useCampaignForm`'s unit tests.
 */
test.describe('Campaign Creation Wizard', () => {
	let wizard: CampaignWizardPage;

	/**
	 * Warm the functions this page reads before the test loads it.
	 *
	 * This is the first spec to open the wizard, a minute after the workflow
	 * pushed a fresh build of the functions to a 2-vCPU test deployment. The
	 * page opens about ten query subscriptions at once, each paying a cold start
	 * on that box, and they queue past Convex's 1 s query limit: the trace shows
	 * `Function execution timed out (maximum duration: 1s)` on topics, templates
	 * and the sender list. A query that errored stays errored until the page
	 * reloads, so the picker showed "Could not load campaign senders" and the
	 * test failed. That happened on the first attempt of nearly every run, and
	 * sometimes on the retry as well.
	 *
	 * Loading the page here (reloading while the sender list fails) warms
	 * those functions, so the test itself sees an ordinary page load.
	 * Nothing here asserts anything: if the warm-up never gets a clean load,
	 * the test below still runs and fails on the same thing.
	 */
	test.beforeAll(async ({ browser }, testInfo) => {
		// Four loads of up to 20 s each; the default 45 s would cut it short.
		testInfo.setTimeout(120_000);
		const context = await browser.newContext({
			storageState: STORAGE_STATE,
			baseURL: testInfo.project.use.baseURL,
		});
		const page = await context.newPage();
		const loadFailed = page.getByText('Could not load campaign senders.');
		const settled = page
			.locator('#senderPicker')
			.or(page.getByText('No campaign senders yet.'))
			.or(loadFailed);
		try {
			for (let attempt = 0; attempt < 4; attempt++) {
				await page.goto('/dashboard/campaigns/new');
				const failed = await settled
					.first()
					.waitFor({ timeout: 20_000 })
					.then(() => loadFailed.isVisible())
					.catch(() => true);
				if (!failed) break;
			}
		} finally {
			await context.close();
		}
	});

	test.beforeEach(async ({ page }) => {
		wizard = new CampaignWizardPage(page);
		await wizard.goto();
	});

	test('will not advance while the instance has no campaign sender', async ({ page }) => {
		// Assert the PAGE got somewhere first. `canSubmit` (SetupStep.vue) is
		// false while loading, false while the sender picker is not ready, and
		// false without a name or recipients — so "Next is disabled" is equally
		// true of a wizard that never rendered, and asserting it alone is a test
		// that passes on a dead page. The suite signs in as the workspace owner,
		// who gets the inline add-a-sender form rather than "ask your admin".
		await expect(
			page.getByText('No campaign senders yet. Add the address this campaign should come from.')
		).toBeVisible({ timeout: 15_000 });

		// With the picker resolved to its empty state, the disabled Next is the
		// real guard, and it says what it is waiting for.
		await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();
		await expect(page.getByTestId('setup-missing')).toContainText('a sender');
	});
});
