import assert from 'node:assert/strict';
import { compareAppVersions } from '../src/updates.js';

assert.equal(compareAppVersions('1.2.0', '1.1.0'), 1);
assert.equal(compareAppVersions('v1.2.0', '1.2.0'), 0);
assert.equal(compareAppVersions('1.2.0', '1.2.1'), -1);
assert.equal(compareAppVersions('1.10.0', '1.9.9'), 1);
assert.equal(compareAppVersions('development', '1.0.0'), null);

console.log('Update version comparison passed.');
