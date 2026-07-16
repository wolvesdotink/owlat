import { describe, it, expect } from 'vitest';
import { AUDIT_ACTION_LITERALS, HOSTED_PLUGIN_OPERATION_LITERALS } from '@owlat/api/auditActions';
import {
	buildActionTypeGroups,
	getActionLabel,
	getActionIcon,
	getActionColorClass,
	getResourceIcon,
	getResourceLabel,
	getHostedPluginDetailText,
	formatTimestamp,
	getUserInitials,
	type AuditLogEntry,
} from '../useAuditLogPresentation';

describe('useAuditLogPresentation action catalog parity', () => {
	const groups = buildActionTypeGroups();
	const grouped = groups.flatMap((g) => g.actions);

	it('every backend AUDIT_ACTION_LITERALS entry is present in exactly one filter group', () => {
		// This is the drift guard: when a new action is added to the backend SSOT
		// it MUST surface in the filter dropdown. A prefix the page does not yet
		// group fails here (the action would silently never appear), forcing the
		// author to add it to ACTION_GROUP_SPECS.
		const counts = new Map<string, number>();
		for (const action of grouped) {
			counts.set(action, (counts.get(action) ?? 0) + 1);
		}

		const missing = AUDIT_ACTION_LITERALS.filter((a) => !counts.has(a));
		const duplicated = [...counts.entries()].filter(([, n]) => n > 1).map(([a]) => a);

		expect(missing, `actions missing from the filter catalog: ${missing.join(', ')}`).toEqual([]);
		expect(duplicated, `actions in more than one group: ${duplicated.join(', ')}`).toEqual([]);
	});

	it('the filter catalog contains no actions outside the backend SSOT', () => {
		const known = new Set<string>(AUDIT_ACTION_LITERALS);
		const extras = grouped.filter((a) => !known.has(a));
		expect(extras, `actions not in AUDIT_ACTION_LITERALS: ${extras.join(', ')}`).toEqual([]);
	});

	it('the catalog covers all backend literals (count parity)', () => {
		expect(grouped.length).toBe(AUDIT_ACTION_LITERALS.length);
	});

	it('every grouped action resolves to a non-empty label / icon / colour', () => {
		for (const action of grouped) {
			expect(getActionLabel(action), `label for ${action}`).toBeTruthy();
			expect(getActionIcon(action), `icon for ${action}`).toMatch(/^lucide:/);
			expect(getActionColorClass(action), `colour for ${action}`).toBeTruthy();
		}
	});

	it('produces no empty optgroups', () => {
		for (const group of groups) {
			expect(group.actions.length, `group "${group.label}" is empty`).toBeGreaterThan(0);
		}
	});
});

describe('useAuditLogPresentation presentation helpers', () => {
	it('labels known verbs and humanises unknown ones', () => {
		expect(getActionLabel('campaign.created')).toBe('Created');
		expect(getActionLabel('team_member.role_changed')).toBe('Role Changed');
		// dkim_rotated is the action that had drifted out of the local catalog;
		// it now both appears in the dropdown and gets a humanised label.
		expect(getActionLabel('sending_domain.dkim_rotated')).toBe('Dkim rotated');
		// dotless action falls back to the whole literal, humanised.
		expect(getActionLabel('abuse_status_changed')).toBe('Abuse status changed');
	});

	it('falls back to a default icon/colour for unknown verbs', () => {
		expect(getActionIcon('campaign.created')).toBe('lucide:plus');
		expect(getActionIcon('campaign.some_new_verb')).toBe('lucide:clipboard-list');
		expect(getActionColorClass('campaign.created')).toContain('text-success');
		expect(getActionColorClass('campaign.some_new_verb')).toBe('text-text-secondary bg-bg-surface');
	});

	it('maps resources to icons and labels, falling back to the raw key', () => {
		expect(getResourceIcon('campaign')).toBe('lucide:send');
		expect(getResourceIcon('unknown_resource')).toBe('lucide:clipboard-list');
		expect(getResourceLabel('api_key')).toBe('API Key');
		expect(getResourceLabel('unknown_resource')).toBe('unknown_resource');
	});

	it('formats relative timestamps with the audit page wording', () => {
		const now = Date.now();
		expect(formatTimestamp(now)).toBe('Just now');
		expect(formatTimestamp(now - 60 * 1000)).toBe('1 minute ago');
		expect(formatTimestamp(now - 2 * 60 * 1000)).toBe('2 minutes ago');
		expect(formatTimestamp(now - 60 * 60 * 1000)).toBe('1 hour ago');
	});

	it('derives initials from name then email', () => {
		expect(getUserInitials('Ada Lovelace', 'ada@example.com')).toBe('AL');
		expect(getUserInitials('Cher', undefined)).toBe('CH');
		expect(getUserInitials(undefined, 'zoe@example.com')).toBe('ZO');
		expect(getUserInitials(undefined, undefined)).toBe('??');
	});

	it.each([
		['plugin.action_completed', 'policy-pack', 'agent.step', 'policy-pack · Agent pipeline step'],
		['plugin.action_completed', 'draft-helper', 'draft.strategy', 'draft-helper · Draft strategy'],
		['plugin.action_completed', 'policy-pack', 'storage.get', 'policy-pack · Storage read'],
		['plugin.action_failed', 'draft-helper', 'llm.generate', 'draft-helper · LLM generation'],
		['plugin.action_denied', 'policy-pack', 'storage.set', 'policy-pack · Storage write'],
	])('presents safe hosted plugin details for %s', (action, pluginId, operation, expected) => {
		expect(
			getHostedPluginDetailText(auditEntry({ action, pluginId, details: { operation } }))
		).toBe(expected);
	});

	it('falls back to legacy resource attribution and ignores arbitrary or malformed details', () => {
		expect(
			getHostedPluginDetailText(
				auditEntry({
					action: 'plugin.action_completed',
					resourceId: 'legacy-plugin',
					details: { operation: 'storage.list', secret: 'must-not-render' },
				})
			)
		).toBe('legacy-plugin · Storage list');
		expect(
			getHostedPluginDetailText(
				auditEntry({
					action: 'plugin.action_failed',
					pluginId: 'policy-pack',
					details: { operation: 'storage.get<script>', name: 'must-not-render' },
				})
			)
		).toBe('policy-pack');
		expect(
			getHostedPluginDetailText(
				auditEntry({
					action: 'plugin.action_denied',
					pluginId: '<img-onerror>',
					details: { name: 'must-not-render' },
				})
			)
		).toBe('Hosted plugin action');
	});

	it('provides a presentation label for every backend hosted operation literal', () => {
		for (const operation of HOSTED_PLUGIN_OPERATION_LITERALS) {
			const text = getHostedPluginDetailText(
				auditEntry({
					action: 'plugin.action_completed',
					pluginId: 'policy-pack',
					details: { operation },
				})
			);
			expect(text, operation).toMatch(/^policy-pack · /);
		}
	});
});

function auditEntry(overrides: Partial<AuditLogEntry>): AuditLogEntry {
	return {
		_id: 'audit-id' as AuditLogEntry['_id'],
		_creationTime: 1,
		userId: 'user-1',
		action: 'campaign.created',
		resource: 'plugin',
		createdAt: 1,
		userProfile: null,
		...overrides,
	};
}
