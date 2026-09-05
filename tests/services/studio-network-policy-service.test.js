import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertStudioRequestNetwork,
  assertStudioWriteOrigin,
  isAllowedStudioHost,
  isPrivateLanAddress,
  studioLanUrls
} from '../../src/services/studio-network-policy-service.js';

test('accepts loopback and private LAN addresses but rejects public addresses', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:192.168.1.20', '10.0.0.5', '172.31.4.2', 'fd00::1']) {
    assert.equal(isPrivateLanAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '172.32.0.1', 'example.com']) assert.equal(isPrivateLanAddress(address), false, address);
});

test('host and exact origin checks resist public hosts and cross-origin writes', () => {
  assert.equal(isAllowedStudioHost('192.168.1.20:4177', 4177), true);
  assert.equal(isAllowedStudioHost('macbook.local:4177', 4177), true);
  assert.equal(isAllowedStudioHost('example.com:4177', 4177), false);
  const request = { socket: { remoteAddress: '::ffff:192.168.1.21' }, headers: { host: '192.168.1.20:4177', origin: 'http://192.168.1.20:4177' } };
  assert.equal(assertStudioRequestNetwork(request, { port: 4177 }), '192.168.1.21');
  assert.doesNotThrow(() => assertStudioWriteOrigin(request, { port: 4177, https: false }));
  assert.throws(() => assertStudioWriteOrigin({ ...request, headers: { ...request.headers, origin: 'http://evil.local:4177' } }, { port: 4177, https: false }), /cross-origin/);
});

test('LAN URL discovery includes only private non-internal IPv4 interfaces', () => {
  const urls = studioLanUrls(4177, { interfaces: {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    en0: [{ address: '192.168.31.8', family: 'IPv4', internal: false }],
    utun: [{ address: '100.64.0.1', family: 'IPv4', internal: false }]
  } });
  assert.deepEqual(urls, ['http://192.168.31.8:4177']);
});
