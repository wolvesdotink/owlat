/**
 * Email client definitions and metadata
 */

export type EmailClientFamily =
	| 'gmail'
	| 'outlook'
	| 'apple-mail'
	| 'yahoo'
	| 'thunderbird'
	| 'samsung-email'
	| 'protonmail'
	| 'hey'
	| 'fastmail'
	| 'aol';

export type EmailPlatform =
	| 'desktop-webmail'
	| 'desktop-app'
	| 'ios'
	| 'android'
	| 'windows'
	| 'macos';

export interface EmailClient {
	id: string;
	family: EmailClientFamily;
	platform: EmailPlatform;
	name: string;
	icon: string;
	marketShare?: number;
	renderingEngine?: string;
	quirks?: string[];
}

export interface EmailClientGroup {
	family: EmailClientFamily;
	name: string;
	icon: string;
	clients: EmailClient[];
}

export interface DevicePreset {
	id: string;
	name: string;
	icon: string;
	width: number;
	height: number;
	type: 'desktop' | 'tablet' | 'mobile';
	scale?: number;
}

export interface PreviewSettings {
	client: EmailClient | null;
	device: DevicePreset;
	darkMode: boolean;
	showImages: boolean;
	zoom: number;
}
