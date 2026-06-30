/**
 * Provider credential validators.
 *
 * The implementations live in `@owlat/shared/setupValidators` so the CLI wizard
 * and the web setup endpoint share one source of truth. Re-exported here so the
 * existing `lib/validators` import path (and its tests) keep working.
 */
export {
	type ValidationResult,
	type SetupProvider,
	validateOpenAIKey,
	validateOpenRouterKey,
	validateResendKey,
	validatePostHogHost,
	validateGoogleSafeBrowsingKey,
	validateProvider,
} from '@owlat/shared/setupValidators';
