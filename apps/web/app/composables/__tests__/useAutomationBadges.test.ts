import { describe, it, expect } from 'vitest';
import {
	useAutomationBadges,
	type AutomationStatus,
	type AutomationTriggerType,
} from '../useAutomationBadges';
import { createTestI18n } from '~/__tests__/i18n';

/**
 * The automations overview and the automation detail page both render the
 * status pill and trigger descriptor from this shared composable. These
 * tests guard that every status/trigger value resolves to a complete badge
 * so the two screens can never render a blank pill.
 *
 * Badge copy travels as a message KEY (the maps are module scope and cannot
 * call `useI18n`), so the label assertions translate it the way the pages do.
 */
const { t } = createTestI18n().global;
describe('useAutomationBadges', () => {
	const ALL_STATUSES: AutomationStatus[] = ['draft', 'active', 'paused'];
	const ALL_TRIGGERS: AutomationTriggerType[] = [
		'contact_created',
		'contact_updated',
		'event_received',
		'topic_subscribed',
	];

	it('returns a complete status badge for every status', () => {
		const { getStatusBadge } = useAutomationBadges();
		for (const status of ALL_STATUSES) {
			const badge = getStatusBadge(status);
			expect(badge.color).toBeTruthy();
			expect(badge.icon).toBeTruthy();
			expect(badge.label).toBeTruthy();
		}
	});

	it('returns a complete trigger descriptor for every trigger', () => {
		const { getTriggerDisplay } = useAutomationBadges();
		for (const trigger of ALL_TRIGGERS) {
			const badge = getTriggerDisplay(trigger);
			expect(badge.label).toBeTruthy();
			expect(badge.icon).toBeTruthy();
			expect(badge.color).toBeTruthy();
			expect(badge.bgColor).toBeTruthy();
		}
	});

	it('maps statuses to their expected labels', () => {
		const { getStatusBadge } = useAutomationBadges();
		expect(t(getStatusBadge('draft').label)).toBe('Draft');
		expect(t(getStatusBadge('active').label)).toBe('Active');
		expect(t(getStatusBadge('paused').label)).toBe('Paused');
	});

	it('maps triggers to their expected labels', () => {
		const { getTriggerDisplay } = useAutomationBadges();
		expect(t(getTriggerDisplay('contact_created').label)).toBe('Contact Created');
		expect(t(getTriggerDisplay('contact_updated').label)).toBe('Contact Updated');
		expect(t(getTriggerDisplay('event_received').label)).toBe('Event Received');
		expect(t(getTriggerDisplay('topic_subscribed').label)).toBe('Subscribed to Topic');
	});

	it('every badge label is a key the catalog carries', () => {
		const { getStatusBadge, getTriggerDisplay } = useAutomationBadges();
		const labels = [
			...ALL_STATUSES.map((status) => getStatusBadge(status).label),
			...ALL_TRIGGERS.map((trigger) => getTriggerDisplay(trigger).label),
		];
		for (const label of labels) {
			expect(label, `${label} is not a message key`).toMatch(/^shared\.useAutomationBadges\./);
			expect(t(label), `${label} is missing from the catalog`).not.toBe(label);
		}
	});
});
