/**
 * The AI routing and embedding audit actions read as words in both catalogs:
 * every verb has its own key (no humanised English fallback), the resources
 * have labels, and German renders German (Sol r5 F8).
 */
import { describe, expect, it } from 'vitest';
import { createI18n } from 'vue-i18n';
import { AUDIT_ACTION_LITERALS } from '@owlat/api/auditActions';
import de from '../../../i18n/locales/de.json';
import en from '../../../i18n/locales/en.json';
import { getActionLabel, getResourceLabel } from '../useAuditLogPresentation';

const ROUTING_ACTIONS = AUDIT_ACTION_LITERALS.filter((action) =>
	/^(embedding_|ai_routing_policy\.)/.test(action)
);

function translator(locale: 'en' | 'de') {
	return createI18n({ legacy: false, locale, messages: { en, de } as never }).global.t;
}

describe('embedding and routing audit actions', () => {
	it('covers every embedding and routing action', () => {
		expect(ROUTING_ACTIONS.length).toBeGreaterThanOrEqual(10);
		for (const action of ROUTING_ACTIONS) {
			expect(getActionLabel(action), action).toMatch(/^shared\.useAuditLogPresentation\.actions\./);
		}
	});

	it('renders German verbs and resources in German', () => {
		const t = translator('de');
		expect(t(getActionLabel('embedding_cohort.attested'))).toBe('Bestätigt');
		expect(t(getActionLabel('embedding_reembed.started'))).toBe('Gestartet');
		expect(t(getActionLabel('embedding_reembed.resumed'))).toBe('Fortgesetzt');
		expect(t(getActionLabel('embedding_space.staged'))).toBe('Bereitgestellt');
		expect(t(getActionLabel('embedding_space.rolled_back'))).toBe('Zurückgesetzt');
		expect(t(getActionLabel('embedding_space.rebuild_cancelled'))).toBe('Neuaufbau abgebrochen');
		expect(t(getResourceLabel('embedding_space'))).toBe('Embedding-Raum');
		expect(t(getResourceLabel('ai_routing_policy'))).toBe('KI-Routing-Richtlinie');
	});

	it('every one of them reads differently in German than in English', () => {
		const tde = translator('de');
		const ten = translator('en');
		for (const action of ROUTING_ACTIONS) {
			const key = getActionLabel(action);
			expect(tde(key), action).not.toBe(ten(key));
		}
	});
});
