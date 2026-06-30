<template>
	<nav class="space-y-6" aria-label="Documentation navigation">
		<div v-for="group in visibleGroups" :key="group.label">
			<h3
				class="text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-2 px-2"
			>
				{{ group.label }}
			</h3>
			<ul class="space-y-0.5">
				<li v-for="item in group.items" :key="item.to">
					<NuxtLink
						:to="item.to"
						class="sidebar-link group block px-3 py-1.5 text-sm rounded-lg"
						:class="
							isActive(item.to)
								? 'active text-brand'
								: 'text-text-secondary hover:text-text-primary'
						"
					>
						<span class="sidebar-link-text">{{ item.label }}</span>
					</NuxtLink>
				</li>
			</ul>
		</div>
	</nav>
</template>

<script setup lang="ts">
interface SidebarItem {
	label: string
	to: string
}

interface SidebarGroup {
	label: string
	section: string
	items: SidebarItem[]
}

const route = useRoute()

const sidebarConfig: SidebarGroup[] = [
	// Guide
	{
		label: 'Getting Started',
		section: 'guide',
		items: [
			{ label: 'Guide Overview', to: '/guide' },
			{ label: 'Welcome to Owlat', to: '/guide/getting-started' },
			{ label: 'Quick Start', to: '/guide/quick-start' },
			{ label: 'Operating Modes', to: '/guide/operating-modes' },
		],
	},
	{
		label: 'Building Emails',
		section: 'guide',
		items: [
			{ label: 'Email Editor', to: '/guide/email-editor' },
			{ label: 'Email Templates', to: '/guide/email-templates' },
			{ label: 'Saved Blocks', to: '/guide/saved-blocks' },
			{ label: 'Media Library', to: '/guide/media-library' },
			{ label: 'Email Theme', to: '/guide/email-theme' },
			{ label: 'Translations', to: '/guide/translations' },
			{ label: 'Share Links', to: '/guide/share-links' },
		],
	},
	{
		label: 'Your Audience',
		section: 'guide',
		items: [
			{ label: 'Contacts', to: '/guide/contacts' },
			{ label: 'Contact Properties', to: '/guide/contact-properties' },
			{
				label: 'Identities & Relationships',
				to: '/guide/audience-data',
			},
			{
				label: 'Importing & Exporting',
				to: '/guide/importing-contacts',
			},
			{ label: 'Topics', to: '/guide/topics' },
			{ label: 'Segments', to: '/guide/segments' },
			{ label: 'Forms', to: '/guide/forms' },
		],
	},
	{
		label: 'Campaigns',
		section: 'guide',
		items: [
			{ label: 'Campaigns & Reporting', to: '/guide/campaigns' },
			{ label: 'A/B Testing', to: '/guide/ab-testing' },
			{ label: 'Create a Campaign', to: '/guide/create-campaign' },
			{
				label: 'Send & Monitor a Campaign',
				to: '/guide/send-campaign',
			},
		],
	},
	{
		label: 'Transactional & Automations',
		section: 'guide',
		items: [
			{ label: 'Transactional Emails', to: '/guide/transactional' },
			{
				label: 'Transactional Setup',
				to: '/guide/transactional-setup',
			},
			{ label: 'Automations', to: '/guide/automations' },
		],
	},
	{
		label: 'Personal Email (Postbox)',
		section: 'guide',
		items: [
			{ label: 'Postbox', to: '/guide/postbox' },
			{ label: 'Migrate from Google', to: '/guide/migrate-from-google' },
			{ label: 'Connect External Mailbox', to: '/guide/postbox#connect-an-external-mailbox' },
		],
	},
	{
		label: 'Team Inbox',
		section: 'guide',
		items: [
			{ label: 'Team Inbox', to: '/guide/team-inbox' },
			{ label: 'AI Agent & Autonomy', to: '/guide/ai-agent' },
			{ label: 'AI Dashboards', to: '/guide/ai-agent#visualization-agent-adaptive-dashboards' },
			{ label: 'Code Tasks', to: '/guide/code-tasks' },
		],
	},
	{
		label: 'Knowledge & Collaboration',
		section: 'guide',
		items: [
			{ label: 'Knowledge Graph', to: '/guide/knowledge-graph' },
			{ label: 'Files', to: '/guide/files' },
			{ label: 'AI Assistant', to: '/guide/ai-assistant' },
			{ label: 'Team Chat', to: '/guide/chat' },
			{ label: 'Communication Channels', to: '/guide/channels' },
			{ label: 'Desktop App', to: '/guide/desktop-app' },
		],
	},
	{
		label: 'Operations',
		section: 'guide',
		items: [
			{ label: 'Deliverability', to: '/guide/deliverability' },
			{ label: 'Security & Scanning', to: '/guide/security-scanning' },
			{
				label: 'API Keys & Webhooks',
				to: '/guide/api-keys-webhooks',
			},
			{ label: 'Team & Permissions', to: '/guide/team-permissions' },
			{ label: 'Audit Logs', to: '/guide/audit-logs' },
			{ label: 'Feature Flags', to: '/guide/feature-flags' },
			{ label: 'Account & Data', to: '/guide/account' },
			{ label: 'System & Updates', to: '/guide/system-updates' },
		],
	},
	// API
	{
		label: 'Overview',
		section: 'api',
		items: [
			{ label: 'API Overview', to: '/api' },
			{ label: 'Authentication', to: '/api/authentication' },
			{ label: 'TypeScript SDK', to: '/api/sdk' },
			{ label: 'Java SDK', to: '/api/sdk-java' },
		],
	},
	{
		label: 'Core Endpoints',
		section: 'api',
		items: [
			{ label: 'Contacts API', to: '/api/contacts' },
			{ label: 'Topics API', to: '/api/topics' },
			{ label: 'Events API', to: '/api/events' },
			{ label: 'Transactional API', to: '/api/transactional' },
			{ label: 'Forms API', to: '/api/forms' },
		],
	},
	{
		label: 'Delivery & Public Endpoints',
		section: 'api',
		items: [
			{ label: 'Webhooks', to: '/api/webhooks' },
			{ label: 'Webhook Payloads', to: '/api/webhook-payloads' },
			{ label: 'Inbound Channels', to: '/api/inbound-channels' },
			{ label: 'Public Endpoints', to: '/api/public-endpoints' },
		],
	},
	// Developer
	{
		label: 'Architecture',
		section: 'developer',
		items: [
			{ label: 'Overview', to: '/developer' },
			{ label: 'Architecture', to: '/developer/architecture' },
			{ label: 'Scopes', to: '/developer/scopes' },
			{ label: 'Convex Backend', to: '/developer/convex' },
			{ label: 'Authentication', to: '/developer/authentication' },
			{ label: 'Component Library', to: '/developer/components' },
			{
				label: 'Environment Variables',
				to: '/developer/environment-variables',
			},
			{ label: 'Feature Flags', to: '/developer/feature-flags' },
		],
	},
	{
		label: 'Email & Delivery',
		section: 'developer',
		items: [
			{ label: 'Email System', to: '/developer/email-system' },
			{ label: 'Email Renderer', to: '/developer/email-renderer' },
			{ label: 'How Email Works', to: '/developer/how-email-works' },
			{ label: 'Email Security', to: '/developer/email-security' },
			{ label: 'MTA System', to: '/developer/mta-system' },
			{ label: 'Providers', to: '/developer/providers' },
			{
				label: 'Deliverability Infrastructure',
				to: '/developer/deliverability-infrastructure',
			},
		],
	},
	{
		label: 'Subsystem Internals',
		section: 'developer',
		items: [
			{ label: 'Campaign Internals', to: '/developer/campaign-internals' },
			{ label: 'Audience Internals', to: '/developer/audience-internals' },
			{
				label: 'Automation Internals',
				to: '/developer/automation-internals',
			},
			{
				label: 'Postbox Architecture',
				to: '/developer/postbox-architecture',
			},
		],
	},
	{
		label: 'Self-Hosting',
		section: 'developer',
		items: [
			{ label: 'Self-Hosting', to: '/developer/self-hosting' },
			{ label: 'Desktop Installer', to: '/developer/self-hosting-desktop' },
			{ label: 'Configuration', to: '/developer/self-hosting-config' },
			{ label: 'DNS & Email Setup', to: '/developer/self-hosting-dns-email' },
			{
				label: 'Production Deployment',
				to: '/developer/self-hosting-production',
			},
			{
				label: 'Maintenance & Updates',
				to: '/developer/self-hosting-maintenance',
			},
			{ label: 'Setup CLI & Installer', to: '/developer/setup-cli' },
			{ label: 'Platform Operations', to: '/developer/platform-operations' },
		],
	},
	{
		label: 'Decisions',
		section: 'developer',
		items: [
			{ label: 'Overview', to: '/developer/decisions' },
			{
				label: 'ADR-001: Custom Email Renderer',
				to: '/developer/decisions/001-custom-email-renderer',
			},
			{
				label: 'ADR-002: Convex Backend',
				to: '/developer/decisions/002-convex-backend',
			},
			{
				label: 'ADR-003: Notion-like Builder',
				to: '/developer/decisions/003-notion-like-builder',
			},
			{
				label: 'ADR-004: Monorepo & Bun',
				to: '/developer/decisions/004-monorepo-bun-workspaces',
			},
			{
				label: 'ADR-005: Custom MTA',
				to: '/developer/decisions/005-custom-mta',
			},
			{
				label: 'ADR-006: Self-Hosted Convex',
				to: '/developer/decisions/006-self-hosted-convex',
			},
			{
				label: 'ADR-007: Pluggable LLM',
				to: '/developer/decisions/007-pluggable-llm',
			},
			{
				label: 'ADR-008: Process Architecture',
				to: '/developer/decisions/008-process-architecture',
			},
			{
				label: 'ADR-009: Model Routing',
				to: '/developer/decisions/009-model-routing',
			},
			{
				label: 'ADR-010: Listing Engine',
				to: '/developer/decisions/010-listing-engine',
			},
		],
	},
	// Examples
	{
		label: 'Examples',
		section: 'examples',
		items: [
			{ label: 'Overview', to: '/examples' },
			{ label: 'Welcome Email', to: '/examples/welcome-email' },
			{ label: 'Billing Email', to: '/examples/billing-email' },
			{ label: 'Event Automation', to: '/examples/event-automation' },
			{ label: 'Contact Sync', to: '/examples/contact-sync' },
			{ label: 'Webhook Handler', to: '/examples/webhook-handler' },
			{ label: 'Multilingual Email', to: '/examples/multilingual-email' },
		],
	},
	// Vision
	{
		label: 'Vision',
		section: 'vision',
		items: [
			{ label: 'The Future of Owlat', to: '/vision' },
			{ label: 'Roadmap', to: '/vision/roadmap' },
			{ label: 'Self-Hosting Architecture', to: '/vision/self-hosting' },
			{ label: 'Agent Pipeline', to: '/vision/agent-pipeline' },
			{ label: 'Knowledge Graph', to: '/vision/knowledge-graph' },
			{ label: 'Multi-Channel & CRM', to: '/vision/multi-channel' },
			{ label: 'Semantic File System', to: '/vision/file-system' },
			{
				label: 'Desktop App & Advanced Agents',
				to: '/vision/desktop-app',
			},
		],
	},
]

const currentSection = computed(() => {
	const segments = route.path.split('/')
	return segments[1] || ''
})

const visibleGroups = computed(() =>
	sidebarConfig.filter(
		(group) => group.section === currentSection.value,
	),
)

function isActive(path: string): boolean {
	return route.path === path
}
</script>

<style scoped>
.sidebar-link {
	position: relative;
	transition: all 0.25s var(--ease-out-expo);
}

/* Animated pill background for active state */
.sidebar-link::before {
	content: '';
	position: absolute;
	inset: 0;
	border-radius: 8px;
	background: var(--color-brand-soft);
	opacity: 0;
	transform: scale(0.92);
	transition: opacity 0.3s var(--ease-out-expo), transform 0.3s var(--ease-out-expo);
	z-index: -1;
}

.sidebar-link.active::before {
	opacity: 1;
	transform: scale(1);
}

/* Active left border accent */
.sidebar-link.active::after {
	content: '';
	position: absolute;
	left: 0;
	top: 4px;
	bottom: 4px;
	width: 2px;
	border-radius: 1px;
	background: var(--color-brand);
	animation: indicator-in 0.3s var(--ease-out-expo) both;
}

@keyframes indicator-in {
	from {
		transform: scaleY(0);
		opacity: 0;
	}
	to {
		transform: scaleY(1);
		opacity: 1;
	}
}

/* Hover state for non-active */
.sidebar-link:not(.active):hover::before {
	opacity: 0.5;
	transform: scale(1);
	background: var(--color-bg-surface);
}

.sidebar-link-text {
	position: relative;
	z-index: 1;
}
</style>
