/**
 * Fetches latest Can I Email data and saves as a local JSON snapshot.
 * Run: bun run update-caniemail
 */
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_URL = 'https://www.caniemail.com/api/data.json';
const OUTPUT_PATH = resolve(__dirname, '../src/generated/caniemail-data.json');

const response = await fetch(API_URL);
if (!response.ok) {
	throw new Error(`Failed to fetch Can I Email data: ${response.status} ${response.statusText}`);
}

const data = await response.json();
const featureCount = data.data?.length ?? 0;

await Bun.write(OUTPUT_PATH, JSON.stringify(data, null, '\t'));

console.log(`Updated Can I Email data: ${featureCount} features saved to src/generated/caniemail-data.json`);
console.log(`API version: ${data.api_version}, Last updated: ${data.last_update_date}`);
