/**
 * Hand the two-factor backup codes to the user as a file.
 *
 * Its own composable because two places produce codes — first enrolment and
 * later rotation — and both owe the user the same document. Splitting the
 * BUILDING of that document (pure, in `utils/accountTwoFactor.ts`) from the
 * catalog lookups and the anchor click (here) is what keeps the builder
 * testable without a DOM and this file free of copy.
 *
 * The codes are shown exactly once: the server keeps only hashes, so this
 * download is the copy that exists.
 */

import { backupCodesFilename, buildBackupCodesFile } from '~/utils/accountTwoFactor';

export function useBackupCodesDownload() {
	const { t, locale } = useI18n();
	const { user } = useAuth();

	function downloadBackupCodes(codes: readonly string[]) {
		const issuedAt = new Date();
		const contents = buildBackupCodesFile({
			codes,
			heading: t('dashboard.preferences.security.twoFactor.file.heading'),
			accountLine: t('dashboard.preferences.security.twoFactor.file.account', {
				email: user.value?.email ?? '',
			}),
			issuedLine: t('dashboard.preferences.security.twoFactor.file.issued', {
				date: new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }).format(issuedAt),
			}),
			notes: [
				t('dashboard.preferences.security.twoFactor.file.noteOnce'),
				t('dashboard.preferences.security.twoFactor.file.noteReplace'),
				t('dashboard.preferences.security.twoFactor.file.noteStore'),
			],
		});

		const url = URL.createObjectURL(new Blob([contents], { type: 'text/plain;charset=utf-8' }));
		const link = document.createElement('a');
		link.href = url;
		link.setAttribute('download', backupCodesFilename(issuedAt));
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
		URL.revokeObjectURL(url);
	}

	return { downloadBackupCodes };
}
