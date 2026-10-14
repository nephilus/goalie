import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultWorkViewKey, parseDefaultWorkView, readDefaultWorkView, writeDefaultWorkView } from '../app/lib/work-default-view';

test('default work view accepts only supported values and safely defaults to All work', () => {
  assert.equal(parseDefaultWorkView('streams'), 'streams');
  for (const value of ['all', null, undefined, '', 'work', 'mine', 'STREAMS', '"streams"', {}, true]) {
    assert.equal(parseDefaultWorkView(value), 'all');
  }
});

test('default view persists separately for each account in this browser', () => {
  const values = new Map<string, string>();
  const storage = () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } });
  const alice = defaultWorkViewKey('alice');
  const bob = defaultWorkViewKey('bob');
  assert.notEqual(alice, bob);
  writeDefaultWorkView(alice, 'streams', storage);
  assert.equal(readDefaultWorkView(alice, storage), 'streams');
  assert.equal(readDefaultWorkView(bob, storage), 'all');
  writeDefaultWorkView(bob, 'all', storage);
  assert.equal(readDefaultWorkView(alice, storage), 'streams');
  writeDefaultWorkView(alice, 'all', storage);
  assert.equal(readDefaultWorkView(alice, storage), 'all');
});

test('blocked storage access and failed reads fall back to All work', () => {
  const unavailable = () => { throw new Error('Storage blocked'); };
  assert.equal(readDefaultWorkView('key', unavailable), 'all');
  assert.equal(readDefaultWorkView('key', () => ({ getItem: unavailable })), 'all');
  assert.equal(readDefaultWorkView('key', () => ({ getItem: () => 'invalid' })), 'all');
});

test('blocked storage access and quota failures do not throw on preference changes', () => {
  const unavailable = () => { throw new Error('Storage blocked'); };
  assert.doesNotThrow(() => writeDefaultWorkView('key', 'streams', unavailable));
  assert.doesNotThrow(() => writeDefaultWorkView('key', 'all', () => ({ setItem: unavailable })));
});
