import { registerClientSimulator } from './registry';

// Gmail strips <style> block entirely, removes position:absolute/relative,
// strips class attributes, and removes <form>/<input> elements.
registerClientSimulator('gmail', (html) =>
	html
		.replace(/<style>[\s\S]*?<\/style>/gi, '')
		.replace(/position:\s*absolute[^;"]*/gi, '')
		.replace(/position:\s*relative[^;"]*/gi, '')
		.replace(/ class="[^"]*"/gi, '')
		.replace(/<input[^>]*>/gi, '<!-- [gmail: input stripped] -->')
		.replace(/<form[^>]*>[\s\S]*?<\/form>/gi, '<!-- [gmail: form stripped] -->'),
);
