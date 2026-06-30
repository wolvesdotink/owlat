import { registerClientSimulator } from './registry';

// Yahoo rewrites class names, strips position:absolute.
registerClientSimulator('yahooMail', (html) =>
	html
		.replace(/position:\s*absolute[^;"]*/gi, '')
		.replace(/<input[^>]*>/gi, '<!-- [yahoo: input stripped] -->'),
);
