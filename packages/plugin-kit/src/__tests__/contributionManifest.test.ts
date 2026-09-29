import { describe, expect, it } from 'vitest';
import {
	CONTRIBUTION_CAPABILITY_REQUIREMENTS,
	type ContributionBucket,
} from '../contributionRequirements';
import { validatePluginManifest, type PluginManifestIssue } from '../manifest';
import { RESERVED_LOCAL_IDS } from '../namespacedKind';
import { RESERVED_FIELD_KEYS } from '../settingsSchema';

/**
 * One minimal valid entry per contribution bucket. `hasLabel` marks the buckets
 * whose entries carry a `label`, which must be trimmed in every one of them.
 */
const ENTRIES: Record<
	ContributionBucket,
	{ readonly entry: Record<string, unknown>; readonly hasLabel: boolean }
> = {
	sendTransports: {
		entry: {
			id: 'postmark',
			label: 'Postmark',
			module: { exportPath: './transports/postmark' },
			retryDelays: [1_000],
		},
		hasLabel: true,
	},
	agentSteps: {
		entry: {
			id: 'spam-score',
			after: 'security_scan',
			module: { exportPath: './agent/spam-score' },
			lifecycleEdges: [],
		},
		hasLabel: false,
	},
	draftStrategies: {
		entry: {
			id: 'legal',
			label: 'Legal clauses',
			module: { exportPath: './draft/legal' },
			timeoutMs: 5_000,
		},
		hasLabel: true,
	},
	sendGates: {
		entry: {
			id: 'approval-policy',
			label: 'Approval policy',
			module: { exportPath: './gates/approval' },
			timeoutMs: 5_000,
		},
		hasLabel: true,
	},
	automationTriggers: {
		entry: automationEntry(),
		hasLabel: true,
	},
	automationSteps: {
		entry: automationEntry(),
		hasLabel: true,
	},
	automationConditions: {
		entry: automationEntry(),
		hasLabel: true,
	},
	webhookEvents: {
		entry: { id: 'deal-won', description: 'A deal was won', subscribable: true },
		hasLabel: false,
	},
	importProviders: {
		entry: {
			id: 'hubspot',
			label: 'HubSpot',
			module: { exportPath: './providers/hubspot' },
			signature: {
				header: 'x-hubspot-signature',
				algorithm: 'hmac-sha256',
				encoding: 'hex',
				secretEnvVar: 'PLUGIN_HUBSPOT_WEBHOOK_SECRET',
			},
		},
		hasLabel: true,
	},
	crons: {
		entry: {
			id: 'refresh-scores',
			label: 'Refresh seed scores',
			module: { exportPath: './crons/refresh' },
			schedule: { intervalMinutes: 360 },
			timeoutMs: 30_000,
		},
		hasLabel: true,
	},
	navItems: {
		entry: {
			id: 'pipeline',
			section: 'audience',
			name: 'Pipeline',
			href: '/dashboard/audience/pipeline',
			icon: 'lucide:kanban',
		},
		hasLabel: false,
	},
	settingsPanels: {
		entry: {
			id: 'pipeline',
			name: 'Pipeline',
			href: '/dashboard/settings/pipeline',
			icon: 'lucide:kanban',
		},
		hasLabel: false,
	},
};

function automationEntry(): Record<string, unknown> {
	return {
		id: 'nudge',
		label: 'Nudge',
		description: 'Post a nudge to the channel',
		icon: 'bell',
		module: { exportPath: './automation/nudge' },
	};
}

const BUCKETS = CONTRIBUTION_CAPABILITY_REQUIREMENTS.map(({ bucket, capability }) => ({
	bucket,
	capability,
}));

function manifest(
	bucket: ContributionBucket,
	capability: string,
	entries: readonly Record<string, unknown>[]
) {
	return {
		id: 'contribution-pack',
		version: '1.0.0',
		capabilities: [capability],
		flag: { default: false },
		contributes: { [bucket]: entries },
	};
}

function issuesFor(value: unknown): readonly PluginManifestIssue[] {
	const result = validatePluginManifest(value);
	return result.ok ? [] : result.issues;
}

describe('shared contribution field rules', () => {
	it('has a fixture for every contribution bucket', () => {
		expect(Object.keys(ENTRIES).sort()).toEqual(BUCKETS.map(({ bucket }) => bucket).sort());
	});

	it.each(BUCKETS)('accepts the minimal $bucket entry', ({ bucket, capability }) => {
		expect(issuesFor(manifest(bucket, capability, [ENTRIES[bucket].entry]))).toEqual([]);
	});

	it.each(BUCKETS.flatMap((row) => [...RESERVED_LOCAL_IDS].map((id) => ({ ...row, id }))))(
		'rejects the reserved id $id in $bucket',
		({ bucket, capability, id }) => {
			const issues = issuesFor(manifest(bucket, capability, [{ ...ENTRIES[bucket].entry, id }]));
			expect(issues).toContainEqual(
				expect.objectContaining({
					code: 'invalid_format',
					path: `$.contributes.${bucket}[0].id`,
				})
			);
		}
	);

	it.each(BUCKETS)('rejects a duplicate id in $bucket', ({ bucket, capability }) => {
		const { entry } = ENTRIES[bucket];
		const issues = issuesFor(manifest(bucket, capability, [entry, { ...entry }]));
		expect(issues).toContainEqual(
			expect.objectContaining({
				code: 'duplicate',
				path: `$.contributes.${bucket}[1].id`,
				message: expect.stringMatching(new RegExp(`^duplicates .+ ${String(entry['id'])}$`)),
			})
		);
	});

	it.each(BUCKETS.filter(({ bucket }) => ENTRIES[bucket].hasLabel))(
		'rejects an untrimmed label in $bucket',
		({ bucket, capability }) => {
			const issues = issuesFor(
				manifest(bucket, capability, [{ ...ENTRIES[bucket].entry, label: ' x ' }])
			);
			expect(issues).toContainEqual(
				expect.objectContaining({
					code: 'invalid_format',
					path: `$.contributes.${bucket}[0].label`,
				})
			);
		}
	);

	it('names draft strategies in the duplicate message', () => {
		const { entry } = ENTRIES.draftStrategies;
		const issues = issuesFor(manifest('draftStrategies', 'draft:strategy', [entry, { ...entry }]));
		expect(issues).toContainEqual(
			expect.objectContaining({ code: 'duplicate', message: 'duplicates draft strategy legal' })
		);
	});

	it('holds settings field keys to the same reserved words as local ids', () => {
		expect(RESERVED_FIELD_KEYS).toBe(RESERVED_LOCAL_IDS);
		expect([...RESERVED_LOCAL_IDS].sort()).toEqual(['__proto__', 'constructor', 'prototype']);
	});

	it('checks the top-level component with the module export-path rule', () => {
		const base = manifest('crons', 'scheduler:cron', [ENTRIES.crons.entry]);
		expect(issuesFor({ ...base, component: { exportPath: '../escape' } })).toContainEqual(
			expect.objectContaining({ code: 'invalid_format', path: '$.component.exportPath' })
		);
		expect(issuesFor({ ...base, component: { exportPath: './ui', extra: 1 } })).toContainEqual(
			expect.objectContaining({ code: 'unknown_field', path: '$.component.extra' })
		);
	});
});
