/**
 * The path → flag table every link surface and the feature middleware read.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import { ROUTE_FEATURE_RULES, blockedFeature, routeFeatureRule } from '../routeFeatureGates';

const PAGES = join(dirname(fileURLToPath(import.meta.url)), '../../pages');

const only =
	(...on: FeatureFlagKey[]) =>
	(flag: FeatureFlagKey) =>
		on.includes(flag);

describe('routeFeatureRule', () => {
	it('gates each section by its flag', () => {
		expect(routeFeatureRule('/dashboard/campaigns/new')?.required).toBe('campaigns');
		expect(routeFeatureRule('/dashboard/automations/123/edit')?.required).toBe('automations');
		expect(routeFeatureRule('/dashboard/visualizations')?.required).toBe('ai.visualizations');
		expect(routeFeatureRule('/dashboard/knowledge/abc')?.required).toBe('ai.knowledge');
		expect(routeFeatureRule('/dashboard/chat/room-1')?.required).toBe('chat');
		expect(routeFeatureRule('/dashboard/assistant')?.required).toBe('ai.assistant');
		expect(routeFeatureRule('/dashboard/postbox/inbox')?.anyOf).toEqual([
			'postbox',
			'mail.external',
		]);
	});

	it('gates the transactional list and its editor tree under /dashboard/send', () => {
		for (const path of [
			'/dashboard/send/transactional',
			'/dashboard/send/transactional/x/edit',
			'/dashboard/send/transactional/x/sends/y',
		]) {
			expect(routeFeatureRule(path)?.required, path).toBe('transactional');
		}
	});

	it('lets a deeper rule replace its section rule', () => {
		expect(routeFeatureRule('/dashboard/knowledge/graph')?.required).toBe('ai.knowledge.analytics');
		expect(routeFeatureRule('/dashboard/inbox/code-tasks')?.required).toBe('inbox.codeTasks');
		expect(blockedFeature('/dashboard/marketing/deleted', only())).toBeNull();
	});

	it('leaves always-on built-ins ungated', () => {
		for (const path of [
			'/dashboard',
			'/dashboard/send',
			'/dashboard/send/emails/abc/edit',
			'/dashboard/files/abc',
			'/dashboard/answer',
			'/dashboard/audience/contacts',
			'/dashboard/admin/team/api',
		]) {
			expect(routeFeatureRule(path), path).toBeUndefined();
		}
	});

	it('matches whole path segments only', () => {
		expect(routeFeatureRule('/dashboard/campaignsX')).toBeUndefined();
		expect(routeFeatureRule('/dashboard/inboxes')).toBeUndefined();
	});

	it('reads a link by its path, without query or fragment', () => {
		expect(blockedFeature('/dashboard/postbox?x=1', only())).toBe('postbox');
		expect(blockedFeature('/dashboard/preferences/external-account#sending', only())).toBe(
			'postbox'
		);
	});
});

describe('blockedFeature', () => {
	it('names the first switched-off flag of an OR group with every flag off', () => {
		expect(blockedFeature('/dashboard/postbox', only())).toBe('postbox');
		expect(blockedFeature('/dashboard/postbox', only('mail.external'))).toBeNull();
	});

	it('names the switched-off flag of a required gate', () => {
		expect(blockedFeature('/dashboard/chat', only())).toBe('chat');
		expect(blockedFeature('/dashboard/chat', only('chat'))).toBeNull();
	});
});

/** Every `.vue` file under `dir`, recursively. */
function vueFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return vueFiles(path);
		return name.endsWith('.vue') ? [path] : [];
	});
}

describe('the table is the only place a feature gate lives', () => {
	it('has no page declaring its own feature gate in its meta', () => {
		const declaring = vueFiles(PAGES).filter((file) =>
			/\b(requiresFeature|requiresAnyFeature|publicFeature)\s*:/.test(readFileSync(file, 'utf8'))
		);
		expect(declaring).toEqual([]);
	});

	it('names only paths that have a page', () => {
		for (const { prefix } of ROUTE_FEATURE_RULES) {
			const relative = prefix.slice(1);
			const exists = [`${relative}.vue`, relative].some((candidate) =>
				existsSync(join(PAGES, candidate))
			);
			expect(exists, prefix).toBe(true);
		}
	});
});
