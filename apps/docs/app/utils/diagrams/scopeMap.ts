/**
 * Data for the `::scope-map` diagram on the scopes page: every app and package
 * in the monorepo and the connections between them.
 */

export interface ScopeItem {
	name: string;
	path: string;
	tech: string;
	desc: string;
	icon: string;
}

export const apps: ScopeItem[] = [
	{
		name: 'web',
		path: 'apps/web',
		tech: 'Nuxt 4 + Vue 3',
		desc: 'Main dashboard — email builder, campaigns, audience, automations, settings',
		icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1',
	},
	{
		name: 'api',
		path: 'apps/api',
		tech: 'Convex',
		desc: 'Serverless backend — database, auth, real-time subscriptions, cron jobs',
		icon: 'M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01',
	},
	{
		name: 'mta',
		path: 'apps/mta',
		tech: 'Hono + GroupMQ',
		desc: 'Mail Transfer Agent — direct SMTP delivery, IP warming, bounce processing',
		icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
	},
	{
		name: 'imap',
		path: 'apps/imap',
		tech: 'Node + IMAP',
		desc: 'IMAP server (port 993) — maps IMAP4rev1 onto Convex per-user mailboxes',
		icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
	},
	{
		name: 'mail-sync',
		path: 'apps/mail-sync',
		tech: 'Node worker',
		desc: 'Syncs external IMAP/SMTP accounts — inbound via IMAP IDLE, relays outbound',
		icon: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
	},
	{
		name: 'code-worker',
		path: 'apps/code-worker',
		tech: 'Node worker',
		desc: 'Polls Convex for queued code tasks and runs them (GitHub task runner)',
		icon: 'M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4',
	},
	{
		name: 'desktop',
		path: 'apps/desktop',
		tech: 'Tauri 2 + Rust',
		desc: 'Desktop shell — bundles the web SPA, connects to one or more deployments',
		icon: 'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
	},
	{
		name: 'setup-cli',
		path: 'apps/setup-cli',
		tech: 'TypeScript · Bun',
		desc: 'Self-host setup CLI — the owlat quickstart installer for a full instance',
		icon: 'M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
	},
	{
		name: 'updater',
		path: 'apps/updater',
		tech: 'Node',
		desc: 'Self-host update worker — applies Docker Compose updates over HTTP',
		icon: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
	},
	{
		name: 'docs',
		path: 'apps/docs',
		tech: 'Nuxt + Content',
		desc: 'Developer documentation — guides, API reference, architecture docs',
		icon: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253',
	},
	{
		name: 'marketing',
		path: 'apps/marketing',
		tech: 'Nuxt',
		desc: 'Public website — landing pages, pricing, changelog',
		icon: 'M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z',
	},
];

export const packages: ScopeItem[] = [
	{
		name: 'shared',
		path: 'packages/shared',
		tech: 'TypeScript',
		desc: 'Shared types — block definitions, editor types, compatibility data',
		icon: 'M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z',
	},
	{
		name: 'email-renderer',
		path: 'packages/email-renderer',
		tech: 'TypeScript',
		desc: 'Email HTML engine — table layouts, VML, CSS inlining, dark mode, AMP',
		icon: 'M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4',
	},
	{
		name: 'email-builder',
		path: 'packages/email-builder',
		tech: 'Vue 3',
		desc: 'Notion-like editor — drag-and-drop canvas, block settings, slash commands, cross-client preview',
		icon: 'M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z',
	},
	{
		name: 'email-scanner',
		path: 'packages/email-scanner',
		tech: 'TypeScript',
		desc: 'Email security — spam/phishing detection, file validation, ClamAV, URL reputation',
		icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
	},
	{
		name: 'ui',
		path: 'packages/ui',
		tech: 'Nuxt Layer',
		desc: 'Component library — toast notifications, error boundaries, shared composables',
		icon: 'M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm0 8a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zm12 0a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z',
	},
	{
		name: 'sdk-js',
		path: 'packages/sdk-js',
		tech: 'TypeScript · npm',
		desc: 'JavaScript SDK — contacts, transactional sends, events, topics',
		icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
	},
	{
		name: 'sdk-java',
		path: 'packages/sdk-java',
		tech: 'Java · Maven',
		desc: 'Java SDK — same API surface, JVM-native client',
		icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
	},
];

export interface Connection {
	from: string;
	to: string;
	label: string;
	dashed?: boolean;
}

export const connections: Connection[] = [
	{ from: 'web', to: 'api', label: 'Real-time queries & mutations' },
	{ from: 'api', to: 'mta', label: 'Email delivery' },
	{ from: 'web', to: 'email-builder', label: 'Editor UI', dashed: true },
	{ from: 'web', to: 'ui', label: 'Components', dashed: true },
	{ from: 'api', to: 'email-renderer', label: 'HTML generation', dashed: true },
	{ from: 'api', to: 'email-scanner', label: 'Security scanning', dashed: true },
	{ from: 'web', to: 'email-renderer', label: 'Live preview', dashed: true },
	{ from: 'api', to: 'shared', label: 'Types', dashed: true },
];
