'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { splitMarkdownPaths } = require('../public/linkify');

test('returns a single text part when there is no markdown path', () => {
  assert.deepEqual(splitMarkdownPaths('nothing to see here'), [
    { type: 'text', value: 'nothing to see here' },
  ]);
});

test('splits a repo-relative path out of surrounding prose', () => {
  assert.deepEqual(splitMarkdownPaths('The 41 are listed in out/review_F.md, with a summary.'), [
    { type: 'text', value: 'The 41 are listed in ' },
    { type: 'path', value: 'out/review_F.md' },
    { type: 'text', value: ', with a summary.' },
  ]);
});

test('leaves a trailing sentence period outside the path', () => {
  assert.deepEqual(splitMarkdownPaths('See out/review_D_tail.md.'), [
    { type: 'text', value: 'See ' },
    { type: 'path', value: 'out/review_D_tail.md' },
    { type: 'text', value: '.' },
  ]);
});

test('handles a deep path with underscores and hyphens', () => {
  const p = 'Assets/_Project/Docs/workstreams/vertical-slice/notes/deterministic-vs-agent-boundary.md';
  assert.deepEqual(splitMarkdownPaths(`The tier list is ${p}.`), [
    { type: 'text', value: 'The tier list is ' },
    { type: 'path', value: p },
    { type: 'text', value: '.' },
  ]);
});

test('handles backslash separators', () => {
  assert.deepEqual(splitMarkdownPaths('open docs\\notes\\plan.md now'), [
    { type: 'text', value: 'open ' },
    { type: 'path', value: 'docs\\notes\\plan.md' },
    { type: 'text', value: ' now' },
  ]);
});

test('finds several paths in one string', () => {
  const parts = splitMarkdownPaths('compare a/one.md against b/two.md today');
  assert.deepEqual(parts.filter((p) => p.type === 'path').map((p) => p.value), [
    'a/one.md', 'b/two.md',
  ]);
});

test('ignores a bare filename with no directory', () => {
  // Bare names are ambiguous and the protocol now forbids them, so they must
  // not render as links that would only fail on click.
  assert.deepEqual(splitMarkdownPaths('see STATE.md for detail'), [
    { type: 'text', value: 'see STATE.md for detail' },
  ]);
});

test('does not match a .mdx extension', () => {
  assert.deepEqual(splitMarkdownPaths('docs/page.mdx is not markdown'), [
    { type: 'text', value: 'docs/page.mdx is not markdown' },
  ]);
});

test('matches an uppercase extension', () => {
  const parts = splitMarkdownPaths('open docs/SHOUT.MD');
  assert.deepEqual(parts.filter((p) => p.type === 'path').map((p) => p.value), ['docs/SHOUT.MD']);
});

test('tolerates a non-string input', () => {
  assert.deepEqual(splitMarkdownPaths(null), [{ type: 'text', value: '' }]);
});

test('a path may carry a #section pointing at a heading inside it', () => {
  const parts = splitMarkdownPaths('see docs/design.md#the-recommendation for why');
  const paths = parts.filter((p) => p.type === 'path').map((p) => p.value);
  assert.deepEqual(paths, ['docs/design.md#the-recommendation']);
});

test('a bare path still matches, and trailing punctuation stays out of it', () => {
  const one = splitMarkdownPaths('see docs/design.md.');
  assert.equal(one.filter((p) => p.type === 'path')[0].value, 'docs/design.md');
  const two = splitMarkdownPaths('see docs/design.md#goals.');
  assert.equal(two.filter((p) => p.type === 'path')[0].value, 'docs/design.md#goals');
});

test('a section reference survives backslash paths too', () => {
  const parts = splitMarkdownPaths('docs\\design.md#goals');
  assert.equal(parts.filter((p) => p.type === 'path')[0].value, 'docs\\design.md#goals');
});
