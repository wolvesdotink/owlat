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

	test('submitting the empty setup step shows a validation error', async ({ page }) => {
		await wizard.submitBasicsStep();

		await expect(page.getByText('Campaign name is required')).toBeVisible({ timeout: 5_000 });
	});
});
