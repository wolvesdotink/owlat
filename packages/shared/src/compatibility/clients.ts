/**
 * Email client metadata — the only static per-client data left in shared after
 * per-block Feature compatibility and Property compatibility moved into Block
 * modules. The renderer's Compatibility walker consumes this through
 * `@owlat/shared`; the registry below also seeds the email-client extension
 * registry so plugin-registered clients show up alongside the built-ins.
 */

import type { ClientSupport, EmailClientInfo } from './types';
import { emailClientRegistry } from './registry';

/**
 * Built-in email client metadata. Keys match the `ClientSupport` union so
 * support-record literals can iterate clients without falling out of sync.
 */
export const emailClients: Record<keyof ClientSupport, EmailClientInfo> = {
	gmail: { name: 'Gmail (Web)', renderEngine: 'blink', marketSharePercent: 27.6 },
	gmailApp: { name: 'Gmail (Mobile App)', renderEngine: 'blink', marketSharePercent: 9.8 },
	outlookDesktop: { name: 'Outlook Desktop (Classic)', renderEngine: 'word', marketSharePercent: 7.2 },
	outlook365: { name: 'Outlook 365 (Web)', renderEngine: 'word', marketSharePercent: 3.1 },
	outlookNew: { name: 'Outlook (New)', renderEngine: 'blink', marketSharePercent: 2.5 },
	outlookMac: { name: 'Outlook (Mac)', renderEngine: 'webkit', marketSharePercent: 1.8 },
	appleMail: { name: 'Apple Mail', renderEngine: 'webkit', marketSharePercent: 14.3 },
	iosMail: { name: 'iOS Mail', renderEngine: 'webkit', marketSharePercent: 16.2 },
	yahooMail: { name: 'Yahoo Mail', renderEngine: 'proprietary', marketSharePercent: 5.1 },
	samsungMail: { name: 'Samsung Mail', renderEngine: 'webkit', marketSharePercent: 2.4 },
	thunderbird: { name: 'Thunderbird', renderEngine: 'gecko', marketSharePercent: 1.2 },
	protonMail: { name: 'ProtonMail', renderEngine: 'proprietary', marketSharePercent: 0.8 },
};

/**
 * Reusable "supported in every client" baseline. Block modules spread this
 * when most clients support a feature and only a few diverge —
 * `{ ...fullSupport, outlookDesktop: 'none' }`.
 */
export const fullSupport: ClientSupport = {
	gmail: 'full',
	gmailApp: 'full',
	outlookDesktop: 'full',
	outlook365: 'full',
	outlookNew: 'full',
	outlookMac: 'full',
	appleMail: 'full',
	iosMail: 'full',
	yahooMail: 'full',
	samsungMail: 'full',
	thunderbird: 'full',
	protonMail: 'full',
};

// Seed the extension registry with the built-ins so getAllEmailClients()
// returns built-ins + plugin-registered clients uniformly.
for (const [key, info] of Object.entries(emailClients)) {
	emailClientRegistry.register(key, info);
}
