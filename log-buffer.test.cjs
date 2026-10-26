// 줄 단위 로그 버퍼의 보관 한도와 증분 조회를 검증한다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LogBuffer } = require('./log-buffer.cjs');

test('splits chunks into lines, keeps the partial tail and returns full text', () => {
  const log = new LogBuffer();
  log.push('first\nsec'); log.push('ond\nthi');
  assert.equal(log.text(), 'first\nsecond\nthi');
  assert.deepEqual(log.lines.map(line => line.text), ['first', 'second']);
  assert.ok(log.lines.every(line => typeof line.time === 'number'));
});

test('since returns only new lines and the current partial line', () => {
  const log = new LogBuffer();
  log.push('a\nb\npar');
  const first = log.since(null);
  assert.deepEqual([first.reset, first.lines, first.partial], [true, ['a', 'b'], 'par']);
  log.push('tial\nc\n');
  const next = log.since(first.cursor);
  assert.deepEqual([next.reset, next.lines, next.partial], [false, ['partial', 'c'], '']);
  assert.deepEqual(log.since(next.cursor).lines, []);
});

test('drops the oldest lines beyond the limit and resets readers that fell behind', () => {
  const log = new LogBuffer(3);
  log.push('1\n');
  const cursor = log.since(null).cursor;
  log.push('2\n3\n4\n5\n');
  assert.equal(log.text(), '3\n4\n5\n');
  const view = log.since(cursor);
  assert.equal(view.reset, true);
  assert.deepEqual(view.lines, ['3', '4', '5']);
});

test('clear starts a new epoch so readers reload', () => {
  const log = new LogBuffer();
  log.push('old\n');
  const cursor = log.since(null).cursor;
  log.clear(); log.push('new\n');
  const view = log.since(cursor);
  assert.equal(view.reset, true);
  assert.deepEqual(view.lines, ['new']);
});

test('map transforms every returned line such as redaction', () => {
  const log = new LogBuffer();
  log.push('token=abc\npart abc');
  const view = log.since(null, text => text.replace('abc', '[숨김]'));
  assert.deepEqual([view.lines, view.partial], [['token=[숨김]'], 'part [숨김]']);
  assert.equal(log.text(text => text.replace('abc', 'x')), 'token=x\npart x');
});

test('entries include line times and the partial tail', () => {
  const log = new LogBuffer();
  log.push('done\nhalf');
  const entries = log.entries(text => text.toUpperCase());
  assert.deepEqual(entries.map(entry => entry.text), ['DONE', 'HALF']);
  assert.ok(entries.every(entry => typeof entry.time === 'number'));
});
