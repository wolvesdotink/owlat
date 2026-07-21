// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import {
	type AuditLogEntry,
	useAuditLogPresentation,
} from '../../../composables/useAuditLogPresentation';
import AuditLogList from '../AuditLogList.vue';

vi.stubGlobal('useAuditLogPresentation', useAuditLogPresentation);

describe('AuditLogList hosted plugin details', () => {
	it('renders plugin attribution and allowlisted operations for every outcome', () => {
		const wrapper = mountList([
			auditEntry('completed', { pluginId: 'policy-pack', operation: 'storage.get' }),
			auditEntry('failed', { pluginId: 'draft-helper', operation: 'llm.generate' }),
			auditEntry('denied', { resourceId: 'legacy-plugin', operation: 'storage.set' }),
		]);

		expect(wrapper.findAll('[data-testid="hosted-plugin-audit-details"]')).toHaveLength(3);
		expect(wrapper.text()).toContain('policy-pack · Storage read');
		expect(wrapper.text()).toContain('draft-helper · LLM generation');
		expect(wrapper.text()).toContain('legacy-plugin · Storage write');
	});

	it('does not render arbitrary metadata from malformed or legacy rows', () => {
		const wrapper = mountList([
			auditEntry('failed', {
				pluginId: 'policy-pack',
				operation: 'storage.get<script>',
				name: 'secret-name-must-not-render',
			}),
			auditEntry('denied', {
				pluginId: '<invalid-plugin>',
				name: 'another-secret-must-not-render',
			}),
		]);

		expect(wrapper.text()).toContain('policy-pack');
		expect(wrapper.text()).toContain('Hosted plugin action');
		expect(wrapper.text()).not.toContain('secret-name-must-not-render');
		expect(wrapper.text()).not.toContain('another-secret-must-not-render');
	});
});

function mountList(logs: AuditLogEntry[]) {
	return mount(AuditLogList, {
		props: { logs, hasMore: false },
		global: { stubs: { Icon: true } },
	});
}

function auditEntry(
	outcome: 'completed' | 'failed' | 'denied',
	values: { pluginId?: string; resourceId?: string; operation?: string; name?: string }
): AuditLogEntry {
	return {
		_id: `audit-${outcome}-${values.pluginId ?? values.resourceId ?? 'unknown'}` as AuditLogEntry['_id'],
		_creationTime: 1,
		userId: 'user-1',
		action: `plugin.action_${outcome}`,
		resource: 'plugin',
		resourceId: values.resourceId,
		pluginId: values.pluginId,
		details: {
			...(values.operation === undefined ? {} : { operation: values.operation }),
			...(values.name === undefined ? {} : { name: values.name }),
		},
		createdAt: 1,
		userProfile: {
			_id: 'profile-1' as NonNullable<AuditLogEntry['userProfile']>['_id'],
			email: 'a@example.com',
		},
	};
}
