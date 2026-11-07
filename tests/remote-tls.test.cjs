'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const https = require('node:https');
const {once} = require('node:events');
const {test} = require('node:test');
const {createRemoteCertificate, reissueRemoteCertificate, createRemoteTLSLease} = require('../electron/remote-tls.cjs');

test('remote certificates reject wildcard and multicast addresses before key generation', async () => {
  for (const address of ['0.0.0.0', '255.255.255.255', '224.0.0.1', 'localhost', '127.00.0.1', '::']) {
    await assert.rejects(createRemoteCertificate({address}), {code: 'INVALID_REMOTE_ADDRESS'});
  }
});

test('remote leaf identity verifies its exact IP, purpose, key and finite expiry', async () => {
  const generated = await createRemoteCertificate({address: '127.0.0.1'});
  try {
    const certificate = new crypto.X509Certificate(generated.certificatePEM);
    assert.equal(certificate.ca, false);
    assert.equal(certificate.checkIP('127.0.0.1'), '127.0.0.1');
    assert.equal(certificate.checkIP('127.0.0.2'), undefined);
    assert.equal(certificate.verify(certificate.publicKey), true);
    assert.ok(certificate.keyUsage.includes('1.3.6.1.5.5.7.3.1'));
    assert.ok(Date.parse(certificate.validTo) - Date.now() <= 90 * 86400000);
    assert.match(generated.identity.keyFingerprint, /^[a-f0-9]{64}$/);
    const lease = createRemoteTLSLease({address: '127.0.0.1', ...generated});
    assert.deepEqual(lease.identity, generated.identity);
    await lease.release();
    assert.throws(() => lease.createServer(() => {}), {code: 'TLS_LEASE_UNAVAILABLE'});
    assert.throws(() => createRemoteTLSLease({address: '127.0.0.2', ...generated}), {code: 'INVALID_REMOTE_CERTIFICATE'});
    const other = await createRemoteCertificate({address: '127.0.0.1'});
    try {
      assert.throws(() => createRemoteTLSLease({address: '127.0.0.1', certificatePEM: generated.certificatePEM,
        privateKeyDER: other.privateKeyDER}), {code: 'INVALID_REMOTE_CERTIFICATE'});
    } finally { other.privateKeyDER.fill(0); }
  } finally { generated.privateKeyDER.fill(0); }
});

test('one original HTTPS lease serves an explicitly trusted client and drains before release', async () => {
  const generated = await createRemoteCertificate({address: '127.0.0.1'});
  const lease = createRemoteTLSLease({address: '127.0.0.1', ...generated});
  generated.privateKeyDER.fill(0);
  let rawSocket, secureSocket, requestSocket;
  const server = lease.createServer((request, response) => {
    requestSocket = request.socket;
    response.end('remote-read-ready');
  });
  server.on('connection', socket => { rawSocket = socket; });
  server.on('secureConnection', socket => { secureSocket = socket; });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    assert.throws(() => lease.createServer(() => {}), {code: 'TLS_LEASE_UNAVAILABLE'});
    assert.throws(() => lease.release(), {code: 'TLS_DRAIN_PENDING'});
    const result = await new Promise((resolve, reject) => {
      const request = https.get({hostname: '127.0.0.1', port: server.address().port,
        ca: generated.certificatePEM, agent: false}, response => {
        const chunks = [], authorized = response.socket.authorized;
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({authorized, body: Buffer.concat(chunks).toString()}));
        response.on('error', reject);
      });
      request.on('error', reject);
    });
    assert.deepEqual(result, {authorized: true, body: 'remote-read-ready'});
    assert.ok(rawSocket && secureSocket);
    assert.notEqual(rawSocket, secureSocket);
    assert.equal(requestSocket, secureSocket);
    assert.equal(requestSocket.encrypted, true);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await lease.release();
  }
  await lease.release();
});

test('reissuing a leaf for a changed IP preserves the original protected device key', async () => {
  const original = await createRemoteCertificate({address: '127.0.0.1'});
  const before = Buffer.from(original.privateKeyDER);
  try {
    const renewed = await reissueRemoteCertificate({address: '127.0.0.2', privateKeyDER: original.privateKeyDER});
    assert.deepEqual(original.privateKeyDER, before);
    assert.equal(renewed.identity.keyFingerprint, original.identity.keyFingerprint);
    assert.notEqual(renewed.identity.certificateFingerprint, original.identity.certificateFingerprint);
    assert.equal(Object.hasOwn(renewed, 'privateKeyDER'), false);
    const lease = createRemoteTLSLease({address: '127.0.0.2', certificatePEM: renewed.certificatePEM,
      privateKeyDER: original.privateKeyDER});
    await lease.release();
    assert.throws(() => createRemoteTLSLease({address: '127.0.0.1', certificatePEM: renewed.certificatePEM,
      privateKeyDER: original.privateKeyDER}), {code: 'INVALID_REMOTE_CERTIFICATE'});
    await assert.rejects(reissueRemoteCertificate({address: '127.0.0.1', privateKeyDER: Buffer.alloc(32)}),
      {code: 'INVALID_REMOTE_CERTIFICATE'});
  } finally { original.privateKeyDER.fill(0); before.fill(0); }
});
