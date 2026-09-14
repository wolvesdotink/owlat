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

	test('will not advance while the instance has no campaign sender', async ({ page }) => {
		// Assert the PAGE got somewhere first. `canSubmit` (SetupStep.vue) is
		// false while loading, false while the sender picker is not ready, and
		// false without an audience — so "Next is disabled" is equally true of a
		// wizard that never rendered, and asserting it alone is a test that
		// passes on a dead page.
		await expect(page.getByText('No campaign senders have been set up yet.')).toBeVisible({
			timeout: 15_000,
		});

		// With the picker resolved to its empty state, the disabled Next is the
		// real guard: a blank instance has no verified sending identity, so the
		// wizard refuses to advance. Note it is NOT the campaign name doing this —
		// `canSubmit` never reads it.
		await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();
	});
});
