import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultWorkViewKey, readDefaultWorkView, writeDefaultWorkView } from '../app/lib/work-default-view';
import { parseWorkLayout, readWorkLayout, workLayoutKey, writeWorkLayout } from '../app/lib/work-layout';

test('layout accepts Compact explicitly and otherwise defaults to Standard', () => {
  assert.equal(parseWorkLayout('compact'), 'compact');
  for (const value of ['standard', null, undefined, '', 'all', 'streams', 'COMPACT', '"compact"', {}, true]) {
    assert.equal(parseWorkLayout(value), 'standard');
  }
});

test('layout persists per account without changing the existing start-page preference', () => {
  const values = new Map<string, string>();
  const storage = () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } });
  const alice = workLayoutKey('alice');
  const bob = workLayoutKey('bob');
  assert.equal(alice, 'goalie:work-layout:alice');
  assert.notEqual(alice, bob);
  assert.notEqual(alice, defaultWorkViewKey('alice'));
  writeDefaultWorkView(defaultWorkViewKey('alice'), 'streams', storage);
  writeWorkLayout(alice, 'compact', storage);
  assert.equal(readWorkLayout(alice, storage), 'compact');
  assert.equal(readWorkLayout(bob, storage), 'standard');
  writeWorkLayout(bob, 'compact', storage);
  writeWorkLayout(alice, 'standard', storage);
  assert.equal(readWorkLayout(alice, storage), 'standard');
  assert.equal(readWorkLayout(bob, storage), 'compact');
  assert.equal(readDefaultWorkView(defaultWorkViewKey('alice'), storage), 'streams');
});

test('blocked access, failed reads and invalid values safely fall back to Standard', () => {
  const unavailable = () => { throw new Error('Storage blocked'); };
  assert.equal(readWorkLayout('key', unavailable), 'standard');
  assert.equal(readWorkLayout('key', () => ({ getItem: unavailable })), 'standard');
  assert.equal(readWorkLayout('key', () => ({ getItem: () => 'invalid' })), 'standard');
});

test('blocked access and quota failures do not throw on layout changes', () => {
  const unavailable = () => { throw new Error('Storage blocked'); };
  assert.doesNotThrow(() => writeWorkLayout('key', 'compact', unavailable));
  assert.doesNotThrow(() => writeWorkLayout('key', 'standard', () => ({ setItem: unavailable })));
});
