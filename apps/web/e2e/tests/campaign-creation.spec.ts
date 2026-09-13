import { test, expect } from '@playwright/test';
import { CampaignWizardPage } from '../page-objects/CampaignWizardPage';

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

	test.beforeEach(async ({ page }) => {
		wizard = new CampaignWizardPage(page);
		await wizard.goto();
	});

	test('will not advance out of an incomplete setup step', async ({ page }) => {
		// Not "submit and read the error": Next is DISABLED until the step is
		// valid, so there is nothing to submit — the previous version of this
		// clicked a disabled button and waited out its timeout. The guard itself
		// is the behaviour worth pinning, and it stays disabled even once the name
		// is filled, because a campaign also needs a sending identity that a blank
		// instance has no way to provide.
		const next = page.getByRole('button', { name: 'Next' });
		await expect(next).toBeDisabled();

		await page.locator('#campaignName').fill(`E2E Campaign ${Date.now()}`);

		await expect(next).toBeDisabled();
	});
});
