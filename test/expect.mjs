/**
 * The few matchers these tests use, on node:assert, so the tests need
 * nothing but Node itself.
 */
import assert from 'node:assert/strict';

const show = (value) => (typeof value === 'string' ? JSON.stringify(value) : String(value));

/** An error whose message holds `text`, or matches it when it is a pattern. */
const holding = (text) => (error) => {
  const said = String(error?.message ?? error);
  assert.ok(text instanceof RegExp ? text.test(said) : said.includes(text), `expected an error holding ${show(text)}, got ${show(said)}`);
  return true;
};

export function expect(actual, message) {
  return {
    toBe: (expected) => assert.equal(actual, expected, message),
    toEqual: (expected) => assert.deepEqual(actual, expected, message),
    toContain: (item) => assert.ok(actual.includes(item), message ?? `expected ${show(actual)} to contain ${show(item)}`),
    toMatch: (pattern) => assert.match(actual, pattern, message),
    toBeLessThan: (n) => assert.ok(actual < n, message ?? `expected ${actual} < ${n}`),
    toBeGreaterThanOrEqual: (n) => assert.ok(actual >= n, message ?? `expected ${actual} >= ${n}`),
    toHaveLength: (n) => assert.equal(actual.length, n, message),
    toBeUndefined: () => assert.equal(actual, undefined, message),
    toBeDefined: () => assert.notEqual(actual, undefined, message),
    toThrow: (text) => assert.throws(actual, holding(text), message),
    not: {
      toContain: (item) => assert.ok(!actual.includes(item), message ?? `expected ${show(actual)} not to contain ${show(item)}`),
    },
    rejects: {
      toThrow: (text) => assert.rejects(actual, holding(text), message),
    },
  };
}
