import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBoolean } from '../src/validation.js';

test('Boolean-API-Werte werden strikt normalisiert', () => {
  for (const value of [true, 1, '1', 'true']) assert.equal(parseBoolean(value), true);
  for (const value of [false, 0, '0', 'false']) assert.equal(parseBoolean(value), false);
  for (const value of ['', 'yes', null, undefined, 2]) assert.equal(parseBoolean(value), null);
});
