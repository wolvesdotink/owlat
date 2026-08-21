import { describe, expect, it } from 'vitest';
import { createI18n } from 'vue-i18n';
import { DELIVERABILITY_CHECKLIST, DELIVERABILITY_SEVERITIES } from '@owlat/shared';
import { FEATURE_FLAGS, FEATURE_PACKS } from '@owlat/shared/featureFlags';
import { OPERATING_MODES, OPERATING_MODE_KEYS } from '@owlat/shared/operatingModes';
import { computeSnoozePresets } from '@owlat/shared/snoozePresets';
import de from '~~/i18n/locales/de.json';
import en from '~~/i18n/locales/en.json';
import {
	featureFlagDescriptionKey,
	featureFlagLabelKey,
	featurePackDescriptionKey,
	featurePackLabelKey,
} from '~/composables/useFeatureCopy';
import {
	checklistGroupDescriptionKey,
	checklistGroupLabelKey,
	checklistItemImpactKey,
	checklistItemTitleKey,
} from '~/composables/useDeliverabilityChecklistCopy';
import {
	dashboardCardDescriptionKey,
	dashboardCardLabelKey,
} from '~/composables/useDashboardCardCopy';
import { RENDERABLE_CARD_TYPES } from '~/composables/widgets';

/**
 * THE SHARED REGISTRIES THE WEB RENDERS COPY FROM.
 *
 * `packages/shared` is read by the setup CLI and by the Convex backend as well
 * as by this app, so these modules solve the same problem differently and this
 * suite pins every half:
 *
 *  - `featureFlags.ts` KEEPS its English (the CLI prints it, and plugin-host
 *    mints definitions at runtime), and the web mirrors it under
 *    `sharedPkg.featureFlags.*`. Two copies of one sentence drift silently — an
 *    operator would read the old wording in German and the new one in English —
 *    so every core flag and pack is compared word for word against the catalog.
 *  - `operatingModes.ts` carries KEYS, because only the web reads it. There the
 *    failure is the opposite one: a preset whose key has no message renders the
 *    key path at the operator, so every key must resolve to something else.
 *  - `deliverabilityChecklist.ts` KEEPS its English too (the copyable diagnostic
 *    report prints a check's title, and a regression alert is stored and mailed
 *    with it), and the web mirrors it under `sharedPkg.deliverabilityChecklist.*`
 *    — including the group headings the Center read model builds per severity in
 *    `apps/api/convex/delivery/checklist.ts`.
 *  - the dashboard card catalog KEEPS its English as well (it is a Convex read
 *    model, and a bundled-plugin card has no catalog entry at all), mirrored
 *    under `sharedPkg.adaptiveDashboard.*`.
 */

type Catalog = { [key: string]: string | Catalog };

/**
 * No fallback: a message the target locale is missing must read as the key path
 * here rather than quietly borrowing the English one.
 */
const i18n = createI18n({
	legacy: false,
	locale: 'en',
	fallbackLocale: false,
	messages: { en: en as Catalog, de: de as Catalog },
});

/** Rendered rather than raw, so `{'@'}assistant` is compared as `@assistant`. */
function rendered(locale: 'en' | 'de', key: string): string {
	return i18n.global.t(key, {}, { locale });
}

describe('sharedPkg.featureFlags — the catalog mirrors the shared registry', () => {
	it.each(Object.values(FEATURE_FLAGS))('$key matches its English catalog entry', (definition) => {
		expect(rendered('en', featureFlagLabelKey(definition.key))).toBe(definition.label);
		expect(rendered('en', featureFlagDescriptionKey(definition.key))).toBe(definition.description);
	});

	it.each(Object.values(FEATURE_PACKS))('pack $key matches its English catalog entry', (pack) => {
		expect(rendered('en', featurePackLabelKey(pack.key))).toBe(pack.label);
		expect(rendered('en', featurePackDescriptionKey(pack.key))).toBe(pack.description);
	});

	it.each(Object.values(FEATURE_FLAGS))(
		'$key is translated, not echoed, in German',
		(definition) => {
			for (const key of [
				featureFlagLabelKey(definition.key),
				featureFlagDescriptionKey(definition.key),
			]) {
				expect(rendered('de', key)).not.toBe(key);
			}
		}
	);
});

describe('sharedPkg.operatingModes — every preset key resolves', () => {
	it.each(OPERATING_MODE_KEYS)('%s carries keys, and both locales render them', (modeKey) => {
		const preset = OPERATING_MODES[modeKey];
		for (const key of [preset.label, preset.audience, preset.description]) {
			expect(key).toBe(`sharedPkg.operatingModes.${modeKey}.${key.split('.').pop()}`);
			for (const locale of ['en', 'de'] as const) {
				expect(rendered(locale, key)).not.toBe(key);
			}
		}
	});
});

/**
 * `snoozePresets.ts` carries KEYS as well — the Convex side computes wake times
 * from it and never renders its copy, so the snooze dialog is the only speaker.
 * A preset whose label key has no message shows `sharedPkg.snoozePresets.…` to
 * someone choosing when a thread comes back.
 */
describe('sharedPkg.snoozePresets — every preset key resolves', () => {
	// Wed 2026-01-07 10:00 UTC: mid-workday, so every preset is present (and
	// "until I'm back" is a later weekday rather than today).
	const presets = computeSnoozePresets({ now: Date.UTC(2026, 0, 7, 10), tzOffsetMinutes: 0 });

	it('produces every preset', () => {
		expect(presets.map((preset) => preset.key)).toEqual([
			'later_today',
			'this_evening',
			'tomorrow_am',
			'this_weekend',
			'next_week',
			'until_im_back',
		]);
	});

	it.each(presets)('$key carries keys, and both locales render them', (preset) => {
		expect(preset.label).toBe(`sharedPkg.snoozePresets.label.${preset.key}`);
		expect(preset.sub.key).toMatch(/^sharedPkg\.snoozePresets\.sub\./);
		for (const locale of ['en', 'de'] as const) {
			expect(rendered(locale, preset.label)).not.toBe(preset.label);
			expect(i18n.global.t(preset.sub.key, preset.sub.params ?? {}, { locale })).not.toContain(
				'sharedPkg.'
			);
		}
	});

	it('reads as the English the dialog has always shown', () => {
		const label = (key: string) => rendered('en', `sharedPkg.snoozePresets.label.${key}`);
		expect(label('later_today')).toBe('Later today');
		expect(label('this_evening')).toBe('This evening');
		expect(label('tomorrow_am')).toBe('Tomorrow');
		expect(label('this_weekend')).toBe('This weekend');
		expect(label('next_week')).toBe('Next week');
		expect(label('until_im_back')).toBe("Until I'm back");
	});
});

/**
 * The group headings are not in `packages/shared`: the Center read model mints
 * one per severity. They are pinned here as literals for the same reason the
 * registry sentences are compared word for word — a heading reworded on the
 * server and not in the catalog reads as English on a German page.
 */
const GROUP_HEADINGS = {
	blocking: { label: 'Blocking delivery', description: 'These checks can stop or reject mail.' },
	reputation: {
		label: 'Hurting reputation',
		description: 'These checks affect how receivers treat future mail.',
	},
	recommended: {
		label: 'Recommended',
		description: 'Useful hardening after the blocking path is verified.',
	},
} as const;

describe('sharedPkg.deliverabilityChecklist — the catalog mirrors the checklist taxonomy', () => {
	it.each(DELIVERABILITY_CHECKLIST)('$id matches its English catalog entry', (definition) => {
		expect(rendered('en', checklistItemTitleKey(definition.id))).toBe(definition.title);
		expect(rendered('en', checklistItemImpactKey(definition.id))).toBe(definition.impact);
	});

	it.each(DELIVERABILITY_CHECKLIST)('$id is translated, not echoed, in German', (definition) => {
		for (const key of [
			checklistItemTitleKey(definition.id),
			checklistItemImpactKey(definition.id),
		]) {
			expect(rendered('de', key)).not.toBe(key);
		}
	});

	it.each(DELIVERABILITY_SEVERITIES)('the %s group heading is mirrored and translated', (key) => {
		expect(rendered('en', checklistGroupLabelKey(key))).toBe(GROUP_HEADINGS[key].label);
		expect(rendered('en', checklistGroupDescriptionKey(key))).toBe(GROUP_HEADINGS[key].description);
		for (const groupKey of [checklistGroupLabelKey(key), checklistGroupDescriptionKey(key)]) {
			expect(rendered('de', groupKey)).not.toBe(groupKey);
		}
	});
});

/**
 * The dashboard card names are not in `packages/shared` either: `DEFAULT_CARDS`
 * in `apps/api/convex/analytics/adaptiveDashboard.ts` is the catalog, served to
 * the editor by `getAvailableCards`. The words are pinned here as literals for
 * the same reason the registry sentences are compared word for word — a card
 * renamed on the server and not in the catalog reads as English on a German
 * page — and the type list is pinned against the widget registry, because a
 * renderable card with no catalog entry falls back to that English forever.
 */
const DASHBOARD_CARDS: Record<string, { label: string; description: string }> = {
	verification_queue: { label: 'Review Queue', description: 'Pending agent drafts needing review' },
	campaign_performance: {
		label: 'Campaign Performance',
		description: 'Recent campaign metrics',
	},
	channel_health: {
		label: 'Channel Health',
		description: 'Status of all communication channels',
	},
	agent_health: { label: 'Agent Health', description: 'AI agent pipeline metrics' },
	recent_contacts: { label: 'Recent Contacts', description: 'Newly added or active contacts' },
	recent_activity: {
		label: 'Recent Activity',
		description: 'Org-wide audit log and contact activity feed',
	},
	queue_depth: { label: 'Queue Depth', description: 'Inbound message processing queue' },
	delivery_rates: { label: 'Delivery Rates', description: 'Email delivery success rates' },
	pinned_visualizations: { label: 'Visualizations', description: 'Pinned data visualizations' },
	knowledge_graph: { label: 'Knowledge', description: 'Recent knowledge entries' },
	upcoming_campaigns: { label: 'Upcoming Campaigns', description: 'Scheduled campaigns' },
	cost_by_step: { label: 'LLM Cost by Step', description: 'Token cost per agent-pipeline step' },
	accuracy_trend: { label: 'Accuracy Trend', description: 'Auto-approve vs. rejection over time' },
};

describe('sharedPkg.adaptiveDashboard — the catalog mirrors the backend card catalog', () => {
	it('names every card type that has a renderer, and no other', () => {
		expect({
			unnamed: [...RENDERABLE_CARD_TYPES].filter((type) => !(type in DASHBOARD_CARDS)),
			unrenderable: Object.keys(DASHBOARD_CARDS).filter((type) => !RENDERABLE_CARD_TYPES.has(type)),
		}).toEqual({ unnamed: [], unrenderable: [] });
	});

	it.each(Object.entries(DASHBOARD_CARDS))('%s matches its English catalog entry', (type, copy) => {
		expect(rendered('en', dashboardCardLabelKey(type))).toBe(copy.label);
		expect(rendered('en', dashboardCardDescriptionKey(type))).toBe(copy.description);
	});

	it.each(Object.keys(DASHBOARD_CARDS))('%s is translated, not echoed, in German', (type) => {
		for (const key of [dashboardCardLabelKey(type), dashboardCardDescriptionKey(type)]) {
			expect(rendered('de', key)).not.toBe(key);
		}
	});
});
