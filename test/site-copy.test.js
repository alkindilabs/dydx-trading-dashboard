'use strict';

// The page's own statements about what the site is: who it is not
// affiliated with, what it is not (advice), and the placeholder it shows
// before data loads. Search engines and link previews read the meta tags
// alone, so each description must carry the full non-affiliation list.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const NOT_AFFILIATED_WITH = [
  'dYdX Trading Inc.',
  'dYdX Operations Services Ltd.',
  'dYdX Foundation',
  'dydx.trade',
];

function metaContent(attribute, name) {
  const match = html.match(new RegExp(`<meta ${attribute}="${name}" content="([^"]*)"`));
  assert.ok(match, `index.html declares ${attribute}="${name}"`);
  return match[1];
}

test('every description meta tag names every entity the site is not affiliated with', () => {
  const descriptions = {
    description: metaContent('name', 'description'),
    'og:description': metaContent('property', 'og:description'),
    'twitter:description': metaContent('name', 'twitter:description'),
  };
  for (const [tag, content] of Object.entries(descriptions)) {
    for (const entity of NOT_AFFILIATED_WITH) {
      assert.ok(content.includes(entity), `${tag} names ${entity}: ${content}`);
    }
  }
});

test('the disclaimer rules out tax advice, and the Tax tab says it covers Portugal only and is not tax advice', () => {
  const disclaimer = html.match(/<dt>Disclaimer<\/dt>\s*<dd>([\s\S]*?)<\/dd>/);
  assert.ok(disclaimer, 'the colophon has a Disclaimer');
  assert.match(disclaimer[1], /\btax\b/);

  const taxTab = html.slice(html.indexOf('<div class="tab-content" id="tax">'), html.indexOf('<!-- Colophon -->'));
  assert.match(taxTab, /<div class="table-title">[^<]*Portugal[^<]*<\/div>/);
  assert.match(taxTab, /Portugal only/);
  assert.match(taxTab, /not tax advice/);
});

test('no metric shows a hyphen as its placeholder before data loads', () => {
  assert.deepEqual(html.match(/<([a-z][a-z0-9]*)\b[^>]*>-<\/\1>/g), null);
});

test('the privacy note says the address travels in the page URL, reaching the host and browser history, which Forget does not clear', () => {
  const privacy = html.match(/<dt>Privacy<\/dt>\s*<dd>([\s\S]*?)<\/dd>/);
  assert.ok(privacy, 'the colophon has a Privacy note');
  const note = privacy[1];
  assert.match(note, /page URL/);
  assert.match(note, /Cloudflare/);
  assert.match(note, /browser history/);
  assert.match(note, /not (your )?(browser )?history/);
});
