'use strict';

// Parser tests for public/markdown.js. The parser produces plain data, so it
// is testable under node with no DOM — which is the reason it produces plain
// data. Turning tokens into elements is index.html's job.

const test = require('node:test');
const assert = require('node:assert/strict');

const md = require('../public/markdown.js');

const types = (blocks) => blocks.map((b) => b.type);
const text = (inline) => inline.map(function flat(n) {
  if (n.type === 'text' || n.type === 'code') return n.value;
  return n.children.map(flat).join('');
}).join('');

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

test('headings carry their level and their text', () => {
  const blocks = md.parse('# One\n\n### Three');
  assert.deepEqual(types(blocks), ['heading', 'heading']);
  assert.equal(blocks[0].level, 1);
  assert.equal(text(blocks[0].inline), 'One');
  assert.equal(blocks[1].level, 3);
  assert.equal(text(blocks[1].inline), 'Three');
});

test('seven hashes is not a heading', () => {
  assert.deepEqual(types(md.parse('####### too many')), ['paragraph']);
});

test('consecutive lines join into one paragraph; a blank line starts another', () => {
  const blocks = md.parse('one\ntwo\n\nthree');
  assert.deepEqual(types(blocks), ['paragraph', 'paragraph']);
  assert.equal(text(blocks[0].inline), 'one two');
  assert.equal(text(blocks[1].inline), 'three');
});

test('a paragraph ends when a block element starts, without a blank line', () => {
  const blocks = md.parse('some prose\n- a bullet');
  assert.deepEqual(types(blocks), ['paragraph', 'list']);
});

test('fenced code keeps its contents verbatim, markdown included', () => {
  const blocks = md.parse('```js\nconst x = **not bold**;\n  indented\n```');
  assert.deepEqual(types(blocks), ['code']);
  assert.equal(blocks[0].lang, 'js');
  assert.equal(blocks[0].value, 'const x = **not bold**;\n  indented');
});

test('an unclosed fence runs to the end of the document rather than throwing', () => {
  const blocks = md.parse('```\nstill code\nmore code');
  assert.deepEqual(types(blocks), ['code']);
  assert.equal(blocks[0].value, 'still code\nmore code');
});

test('horizontal rules are recognised in their three spellings', () => {
  assert.deepEqual(types(md.parse('---\n\n***\n\n___')), ['hr', 'hr', 'hr']);
});

test('blockquotes are parsed as nested blocks', () => {
  const blocks = md.parse('> # Quoted heading\n> and prose');
  assert.deepEqual(types(blocks), ['quote']);
  assert.deepEqual(types(blocks[0].blocks), ['heading', 'paragraph']);
});

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

test('bullet and ordered lists are distinguished', () => {
  const bullets = md.parse('- one\n- two');
  assert.equal(bullets[0].type, 'list');
  assert.equal(bullets[0].ordered, false);
  assert.equal(bullets[0].items.length, 2);

  const ordered = md.parse('1. one\n2. two');
  assert.equal(ordered[0].ordered, true);
  assert.equal(ordered[0].items.length, 2);
});

test('an indented list nests inside the item above it', () => {
  const [list] = md.parse('- outer\n  - inner one\n  - inner two\n- second outer');
  assert.equal(list.items.length, 2);
  assert.equal(text(list.items[0].inline), 'outer');
  assert.equal(list.items[0].children.length, 1);
  assert.equal(list.items[0].children[0].items.length, 2);
  assert.equal(list.items[1].children.length, 0);
});

test('switching marker kind starts a new list', () => {
  const blocks = md.parse('- bullet\n1. ordered');
  assert.deepEqual(types(blocks), ['list', 'list']);
  assert.equal(blocks[0].ordered, false);
  assert.equal(blocks[1].ordered, true);
});

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

test('a header row plus a divider makes a table', () => {
  const [table] = md.parse('| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |');
  assert.equal(table.type, 'table');
  assert.equal(text(table.header[0]), 'A');
  assert.equal(table.rows.length, 2);
  assert.equal(text(table.rows[1][1]), '4');
});

test('pipes without a divider row stay a paragraph', () => {
  assert.deepEqual(types(md.parse('a | b | c')), ['paragraph']);
});

test('table cells are parsed for inline markup', () => {
  const [table] = md.parse('| Name | Note |\n|---|---|\n| `code` | **bold** |');
  assert.equal(table.rows[0][0][0].type, 'code');
  assert.equal(table.rows[0][1][0].type, 'strong');
});

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

test('bold, italic, strikethrough and code are each recognised', () => {
  assert.equal(md.parseInline('**b**')[0].type, 'strong');
  assert.equal(md.parseInline('__b__')[0].type, 'strong');
  assert.equal(md.parseInline('*i*')[0].type, 'em');
  assert.equal(md.parseInline('_i_')[0].type, 'em');
  assert.equal(md.parseInline('~~s~~')[0].type, 'strike');
  assert.equal(md.parseInline('`c`')[0].type, 'code');
});

test('a code span suppresses the markup inside it', () => {
  const nodes = md.parseInline('`**not bold**`');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].type, 'code');
  assert.equal(nodes[0].value, '**not bold**');
});

test('bold wins over italic so that **x** is not read as *(*x*)*', () => {
  const nodes = md.parseInline('**bold**');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].type, 'strong');
  assert.equal(text(nodes), 'bold');
});

test('links carry their target and their label', () => {
  const [link] = md.parseInline('[the design doc](docs/design.md)');
  assert.equal(link.type, 'link');
  assert.equal(link.href, 'docs/design.md');
  assert.equal(text([link]), 'the design doc');
});

test('markup nests', () => {
  const nodes = md.parseInline('**bold with `code` inside**');
  assert.equal(nodes[0].type, 'strong');
  assert.ok(nodes[0].children.some((n) => n.type === 'code'));
});

test('surrounding text is preserved around markup', () => {
  const nodes = md.parseInline('before **middle** after');
  assert.equal(text(nodes), 'before middle after');
  assert.equal(nodes[0].value, 'before ');
  assert.equal(nodes[nodes.length - 1].value, ' after');
});

test('unmatched delimiters stay literal instead of eating the rest of the line', () => {
  assert.equal(text(md.parseInline('2 * 3 * 4 is not emphasis')), '2 * 3 * 4 is not emphasis');
  assert.equal(md.parseInline('a lone ` backtick')[0].type, 'text');
});

// ---------------------------------------------------------------------------
// Safety and robustness
// ---------------------------------------------------------------------------

test('raw HTML is carried as literal text, never as markup', () => {
  // The parser emits no HTML, so the renderer receives this as a string to put
  // in a text node. This is the property the whole XSS story rests on.
  const [para] = md.parse('<script>alert(1)</script>');
  assert.equal(para.type, 'paragraph');
  assert.equal(text(para.inline), '<script>alert(1)</script>');
  assert.ok(para.inline.every((n) => n.type === 'text'));
});

test('empty, blank and non-string inputs produce an empty document', () => {
  assert.deepEqual(md.parse(''), []);
  assert.deepEqual(md.parse('\n\n   \n'), []);
  assert.deepEqual(md.parse(null), []);
  assert.deepEqual(md.parse(undefined), []);
  assert.deepEqual(md.parseInline(null), []);
});

test('carriage returns are normalised, so Windows files parse the same', () => {
  assert.deepEqual(types(md.parse('# One\r\n\r\ntext\r\n')), types(md.parse('# One\n\ntext\n')));
});

test('a realistic document parses into the expected block sequence', () => {
  const doc = [
    '# Design',
    '',
    'Some **prose** with a [link](docs/other.md).',
    '',
    '## Options',
    '',
    '| Option | Cost |',
    '|---|---|',
    '| A | low |',
    '',
    '- first',
    '  - nested',
    '- second',
    '',
    '> A note.',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    '---',
  ].join('\n');
  assert.deepEqual(
    types(md.parse(doc)),
    ['heading', 'paragraph', 'heading', 'table', 'list', 'quote', 'code', 'hr'],
  );
});

test('a wrapped bullet keeps going instead of breaking into a paragraph', () => {
  const blocks = md.parse('- a bullet that runs on\n  onto the next line\n- second');
  assert.deepEqual(types(blocks), ['list']);
  assert.equal(blocks[0].items.length, 2);
  assert.equal(text(blocks[0].items[0].inline), 'a bullet that runs on onto the next line');
});

test('a blank line ends a wrapped bullet', () => {
  const blocks = md.parse('- a bullet\n\nseparate paragraph');
  assert.deepEqual(types(blocks), ['list', 'paragraph']);
  assert.equal(text(blocks[0].items[0].inline), 'a bullet');
});

test('a heading right after a bullet is not swallowed into it', () => {
  const blocks = md.parse('- a bullet\n# Heading');
  assert.deepEqual(types(blocks), ['list', 'heading']);
});

test('a wrapped bullet still nests correctly', () => {
  const [list] = md.parse('- outer wrapping\n  onto a second line\n  - inner\n- next');
  assert.equal(list.items.length, 2);
  assert.equal(text(list.items[0].inline), 'outer wrapping onto a second line');
  assert.equal(list.items[0].children.length, 1);
});

// ---------------------------------------------------------------------------
// Heading slugs — what section links point at
// ---------------------------------------------------------------------------

test('slugify follows the rule an agent writing a link would assume', () => {
  assert.equal(md.slugify('The recommendation, up front'), 'the-recommendation-up-front');
  assert.equal(md.slugify('Front matter — the complete field list'), 'front-matter-the-complete-field-list');
  assert.equal(md.slugify('  Spaced  out  '), 'spaced-out');
  assert.equal(md.slugify('Kinds — two, not three'), 'kinds-two-not-three');
  assert.equal(md.slugify('snake_case_heading'), 'snake-case-heading');
});

test('a heading with no usable characters still gets an id', () => {
  assert.equal(md.slugify('!!!'), 'section');
  assert.equal(md.slugify(''), 'section');
});

test('every heading carries a slug, taken from its rendered text', () => {
  const blocks = md.parse('# Plain\n\n## With `code` and **bold**');
  assert.equal(blocks[0].slug, 'plain');
  assert.equal(blocks[1].slug, 'with-code-and-bold');
});

test('repeated headings get distinct slugs in document order', () => {
  const blocks = md.parse('## Goals\n\n## Goals\n\n## Goals');
  assert.deepEqual(blocks.map((b) => b.slug), ['goals', 'goals-1', 'goals-2']);
});

test('a heading inside a blockquote cannot collide with one outside it', () => {
  const blocks = md.parse('## Goals\n\n> ## Goals');
  assert.equal(blocks[0].slug, 'goals');
  assert.equal(blocks[1].blocks[0].slug, 'goals-1');
});

test('slugs are stable across parses of the same document', () => {
  const doc = '# One\n\n## Two\n\n## Two';
  assert.deepEqual(
    md.parse(doc).map((b) => b.slug),
    md.parse(doc).map((b) => b.slug),
  );
});
