import { registerClientSimulator } from './registry';

// Outlook Desktop (Word engine): strip border-radius, max-width, CSS animations,
// background-size, media queries on non-VML elements.
registerClientSimulator('outlookDesktop', (html) =>
	html
		.replace(/border-radius:\s*[^;"]+/gi, '')
		.replace(/max-width:\s*[^;"]+/gi, '')
		.replace(/@media[^{]*\{[^}]*(\{[^}]*\})*[^}]*\}/gi, '')
		.replace(/animation[^;"]*/gi, '')
		.replace(/background-size:\s*[^;"]+/gi, '')
		.replace(/<input[^>]*>/gi, '<!-- [outlook: input stripped] -->')
		.replace(/<form[^>]*>[\s\S]*?<\/form>/gi, '<!-- [outlook: form stripped] -->'),
);
