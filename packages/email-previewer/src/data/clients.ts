import type {
	EmailClient,
	EmailClientFamily,
	EmailClientGroup,
	EmailPlatform,
	DevicePreset,
} from '../types';

/**
 * Email client definitions with their platform variants
 * Market share data is approximate and for reference only
 */
export const emailClients: EmailClient[] = [
	// Gmail
	{
		id: 'gmail-webmail',
		family: 'gmail',
		platform: 'desktop-webmail',
		name: 'Gmail (Web)',
		icon: 'mail',
		marketShare: 27.8,
		renderingEngine: 'Google',
		quirks: ['Strips class/id', 'Requires inline styles', 'No CSS animations'],
	},
	{
		id: 'gmail-ios',
		family: 'gmail',
		platform: 'ios',
		name: 'Gmail (iOS)',
		icon: 'smartphone',
		marketShare: 5.2,
		renderingEngine: 'WebKit',
	},
	{
		id: 'gmail-android',
		family: 'gmail',
		platform: 'android',
		name: 'Gmail (Android)',
		icon: 'smartphone',
		marketShare: 4.8,
		renderingEngine: 'Android WebView',
	},

	// Apple Mail
	{
		id: 'apple-mail-macos',
		family: 'apple-mail',
		platform: 'macos',
		name: 'Apple Mail (macOS)',
		icon: 'monitor',
		marketShare: 9.4,
		renderingEngine: 'WebKit',
	},
	{
		id: 'apple-mail-ios',
		family: 'apple-mail',
		platform: 'ios',
		name: 'Apple Mail (iOS)',
		icon: 'smartphone',
		marketShare: 38.9,
		renderingEngine: 'WebKit',
	},

	// Outlook
	{
		id: 'outlook-windows',
		family: 'outlook',
		platform: 'windows',
		name: 'Outlook (Windows)',
		icon: 'monitor',
		marketShare: 3.8,
		renderingEngine: 'Microsoft Word',
		quirks: ['Uses Word rendering', 'Limited CSS support', 'No flexbox/grid'],
	},
	{
		id: 'outlook-macos',
		family: 'outlook',
		platform: 'macos',
		name: 'Outlook (macOS)',
		icon: 'monitor',
		marketShare: 1.2,
		renderingEngine: 'WebKit',
	},
	{
		id: 'outlook-webmail',
		family: 'outlook',
		platform: 'desktop-webmail',
		name: 'Outlook.com',
		icon: 'globe',
		marketShare: 3.1,
		renderingEngine: 'Microsoft',
	},
	{
		id: 'outlook-ios',
		family: 'outlook',
		platform: 'ios',
		name: 'Outlook (iOS)',
		icon: 'smartphone',
		marketShare: 0.8,
		renderingEngine: 'WebKit',
	},
	{
		id: 'outlook-android',
		family: 'outlook',
		platform: 'android',
		name: 'Outlook (Android)',
		icon: 'smartphone',
		marketShare: 0.6,
		renderingEngine: 'Android WebView',
	},

	// Yahoo
	{
		id: 'yahoo-webmail',
		family: 'yahoo',
		platform: 'desktop-webmail',
		name: 'Yahoo Mail (Web)',
		icon: 'globe',
		marketShare: 2.4,
		renderingEngine: 'Yahoo',
	},
	{
		id: 'yahoo-ios',
		family: 'yahoo',
		platform: 'ios',
		name: 'Yahoo Mail (iOS)',
		icon: 'smartphone',
		marketShare: 0.4,
		renderingEngine: 'WebKit',
	},
	{
		id: 'yahoo-android',
		family: 'yahoo',
		platform: 'android',
		name: 'Yahoo Mail (Android)',
		icon: 'smartphone',
		marketShare: 0.3,
		renderingEngine: 'Android WebView',
	},

	// Samsung
	{
		id: 'samsung-email-android',
		family: 'samsung-email',
		platform: 'android',
		name: 'Samsung Email',
		icon: 'smartphone',
		marketShare: 1.8,
		renderingEngine: 'Android WebView',
	},

	// ProtonMail
	{
		id: 'protonmail-webmail',
		family: 'protonmail',
		platform: 'desktop-webmail',
		name: 'ProtonMail (Web)',
		icon: 'shield',
		marketShare: 0.2,
		renderingEngine: 'ProtonMail',
		quirks: ['Remote content blocked by default'],
	},

	// Thunderbird
	{
		id: 'thunderbird-desktop',
		family: 'thunderbird',
		platform: 'desktop-app',
		name: 'Thunderbird',
		icon: 'monitor',
		marketShare: 0.3,
		renderingEngine: 'Gecko',
	},

	// HEY
	{
		id: 'hey-webmail',
		family: 'hey',
		platform: 'desktop-webmail',
		name: 'HEY',
		icon: 'mail',
		marketShare: 0.1,
		renderingEngine: 'HEY',
	},

	// Fastmail
	{
		id: 'fastmail-webmail',
		family: 'fastmail',
		platform: 'desktop-webmail',
		name: 'Fastmail',
		icon: 'mail',
		marketShare: 0.1,
		renderingEngine: 'Fastmail',
	},
];

/**
 * Group clients by family for UI display
 */
export const emailClientGroups: EmailClientGroup[] = [
	{
		family: 'apple-mail',
		name: 'Apple Mail',
		icon: 'apple',
		clients: emailClients.filter((c) => c.family === 'apple-mail'),
	},
	{
		family: 'gmail',
		name: 'Gmail',
		icon: 'mail',
		clients: emailClients.filter((c) => c.family === 'gmail'),
	},
	{
		family: 'outlook',
		name: 'Outlook',
		icon: 'mail-open',
		clients: emailClients.filter((c) => c.family === 'outlook'),
	},
	{
		family: 'yahoo',
		name: 'Yahoo Mail',
		icon: 'mail',
		clients: emailClients.filter((c) => c.family === 'yahoo'),
	},
	{
		family: 'samsung-email',
		name: 'Samsung Email',
		icon: 'smartphone',
		clients: emailClients.filter((c) => c.family === 'samsung-email'),
	},
	{
		family: 'protonmail',
		name: 'ProtonMail',
		icon: 'shield',
		clients: emailClients.filter((c) => c.family === 'protonmail'),
	},
	{
		family: 'thunderbird',
		name: 'Thunderbird',
		icon: 'mail',
		clients: emailClients.filter((c) => c.family === 'thunderbird'),
	},
];

/**
 * Device presets for responsive preview
 */
export const devicePresets: DevicePreset[] = [
	{
		id: 'desktop-large',
		name: 'Desktop (1440px)',
		icon: 'monitor',
		width: 1440,
		height: 900,
		type: 'desktop',
	},
	{
		id: 'desktop',
		name: 'Desktop (1200px)',
		icon: 'monitor',
		width: 1200,
		height: 800,
		type: 'desktop',
	},
	{
		id: 'desktop-small',
		name: 'Desktop (1024px)',
		icon: 'monitor',
		width: 1024,
		height: 768,
		type: 'desktop',
	},
	{
		id: 'tablet-landscape',
		name: 'Tablet Landscape',
		icon: 'tablet',
		width: 1024,
		height: 768,
		type: 'tablet',
	},
	{
		id: 'tablet-portrait',
		name: 'Tablet Portrait',
		icon: 'tablet',
		width: 768,
		height: 1024,
		type: 'tablet',
	},
	{
		id: 'iphone-pro-max',
		name: 'iPhone Pro Max',
		icon: 'smartphone',
		width: 430,
		height: 932,
		type: 'mobile',
	},
	{
		id: 'iphone-pro',
		name: 'iPhone Pro',
		icon: 'smartphone',
		width: 393,
		height: 852,
		type: 'mobile',
	},
	{
		id: 'iphone-se',
		name: 'iPhone SE',
		icon: 'smartphone',
		width: 375,
		height: 667,
		type: 'mobile',
	},
	{
		id: 'android-large',
		name: 'Android Large',
		icon: 'smartphone',
		width: 412,
		height: 915,
		type: 'mobile',
	},
	{
		id: 'android-medium',
		name: 'Android Medium',
		icon: 'smartphone',
		width: 360,
		height: 800,
		type: 'mobile',
	},
];

/**
 * Popular clients for quick selection
 */
export const popularClients = [
	'apple-mail-ios',
	'gmail-webmail',
	'outlook-windows',
	'outlook-webmail',
	'yahoo-webmail',
];

/**
 * Get client by ID
 */
export function getClientById(id: string): EmailClient | undefined {
	return emailClients.find((c) => c.id === id);
}

/**
 * Get device preset by ID
 */
export function getDeviceById(id: string): DevicePreset | undefined {
	return devicePresets.find((d) => d.id === id);
}

/**
 * Map our client families to caniemail family keys.
 * Multiple candidates allow graceful fallback if caniemail naming differs by feature.
 */
export const canIEmailFamilyMap: Record<EmailClientFamily, string[]> = {
	gmail: ['gmail'],
	outlook: ['outlook'],
	'apple-mail': ['apple-mail'],
	yahoo: ['yahoo'],
	thunderbird: ['thunderbird'],
	'samsung-email': ['samsung-email'],
	protonmail: ['protonmail'],
	hey: ['hey'],
	fastmail: ['fastmail'],
	aol: ['aol'],
};

/**
 * Map our platforms and client IDs to caniemail platform keys.
 * Client-specific entries are checked first, then platform-level defaults.
 */
export const canIEmailPlatformMap: Record<string, string[]> = {
	// Platform defaults
	'desktop-webmail': ['desktop-webmail'],
	'desktop-app': ['desktop-app', 'windows', 'macos'],
	ios: ['ios'],
	android: ['android'],
	windows: ['windows', 'windows-mail'],
	macos: ['macos'],

	// Client-specific overrides
	'outlook-webmail': ['outlook-com', 'desktop-webmail'],
	'outlook-windows': ['windows', 'windows-mail'],
	'thunderbird-desktop': ['desktop-app', 'windows', 'macos'],
};

export function getCanIEmailPlatformCandidates(clientId: string, platform: EmailPlatform): string[] {
	return canIEmailPlatformMap[clientId] ?? canIEmailPlatformMap[platform] ?? [platform];
}
