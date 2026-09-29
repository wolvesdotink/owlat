/**
 * The editors and the renderer must agree on the theme an organization gets
 * when it has not configured one, so the composable falls back to the shared
 * `DEFAULT_EMAIL_THEME` rather than its own literals.
 */
import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { DEFAULT_EMAIL_THEME } from '@owlat/shared/emailDefaults';
import { useEmailTheme } from '../useEmailTheme';

const settings = ref<{ emailTheme: Record<string, unknown> } | undefined>(undefined);
vi.stubGlobal('useOrganizationQuery', () => ({ data: settings }));

function withSettings(emailTheme: Record<string, unknown> | undefined) {
	settings.value = emailTheme === undefined ? undefined : { emailTheme };
	return useEmailTheme().emailTheme.value;
}

describe('useEmailTheme', () => {
	it('falls back to the shared defaults when nothing is configured', () => {
		expect(withSettings(undefined)).toEqual({
			primaryColor: DEFAULT_EMAIL_THEME.primaryColor,
			fontFamily: DEFAULT_EMAIL_THEME.fontFamily,
			backgroundColor: DEFAULT_EMAIL_THEME.backgroundColor,
		});
	});

	it('keeps configured values and carries a configured base width', () => {
		expect(
			withSettings({
				primaryColor: '#123456',
				fontFamily: 'Georgia, serif',
				backgroundColor: '',
				baseWidth: 640,
			})
		).toEqual({
			primaryColor: '#123456',
			fontFamily: 'Georgia, serif',
			backgroundColor: DEFAULT_EMAIL_THEME.backgroundColor,
			baseWidth: 640,
		});
	});
});
