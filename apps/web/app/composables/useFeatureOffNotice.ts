import { featureFlagLabelKey, useFeatureCopy } from '~/composables/useFeatureCopy';
import { adminEntryById } from '~/lib/adminSettingsRegistry';

/** How long the notice stays: a sentence to read, and for an admin a link to take. */
const NOTICE_MS = 8000;

/**
 * The Workbench's explanation for a bounce. The feature middleware sends a link
 * to a switched-off page (an old bookmark, a link in a mail) to
 * `/dashboard?disabled=<flag>`; this names the feature once and then drops the
 * parameter, so a reload does not say it again. Someone who may change
 * features (the Features page asks for the admin role) also gets the way there.
 *
 * Only a flag the catalog can name is announced: the parameter comes from a
 * URL anyone can write, so free text in it is never shown.
 */
export function useFeatureOffNotice(): void {
	const route = useRoute();
	const router = useRouter();
	const { t, te } = useI18n();
	const { flagKeyLabel } = useFeatureCopy();
	const { isAdmin, isRoleLoading } = usePermissions();
	const { showToast } = useToast();

	watch(
		[() => route.query['disabled'], isRoleLoading],
		([flag, roleLoading]) => {
			// Waits for the role, so an admin is never handed the member's sentence.
			if (flag === undefined || roleLoading) return;
			const { disabled: _announced, ...query } = route.query;
			void router.replace({ query });
			if (typeof flag !== 'string' || !te(featureFlagLabelKey(flag))) return;

			const featuresPath = adminEntryById('features')?.path;
			showToast(t('dashboard.today.featureOff', { feature: flagKeyLabel(flag) }), 'info', {
				durationMs: NOTICE_MS,
				...(isAdmin.value && featuresPath
					? {
							action: {
								label: t('dashboard.today.openFeatures'),
								onAction: () => void router.push(featuresPath),
							},
						}
					: {}),
			});
		},
		{ immediate: true }
	);
}
