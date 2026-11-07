'use strict';

const crypto = require('node:crypto');
const https = require('node:https');
const net = require('node:net');
require('reflect-metadata');
const x509 = require('@peculiar/x509');

const MAX_CERTIFICATE_BYTES = 16384;
const MAX_KEY_BYTES = 16384;
const SERVER_AUTH = '1.3.6.1.5.5.7.3.1';
const ALGORITHM = Object.freeze({name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256'});
function fail(code) {
  throw Object.assign(new Error('The remote TLS identity is unavailable.'), {code});
}
function addressValue(address) {
  if (typeof address !== 'string' || net.isIP(address) !== 4 ||
      address === '0.0.0.0' || address === '255.255.255.255' ||
      Number(address.split('.')[0]) >= 224) fail('INVALID_REMOTE_ADDRESS');
  return address;
}
function publicIdentity(certificate, address) {
  return Object.freeze({
    address,
    keyFingerprint: crypto.createHash('sha256')
      .update(certificate.publicKey.export({type: 'spki', format: 'der'})).digest('hex'),
    certificateFingerprint: crypto.createHash('sha256').update(certificate.raw).digest('hex'),
    validUntil: new Date(certificate.validTo).toISOString(),
    certificatePEM: certificate.toString()
  });
}

async function issueCertificate(address, keys) {
  const serial = crypto.randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 1;
  const now = Math.floor(Date.now() / 1000) * 1000;
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial.toString('hex'),
    name: 'CN=ReviewOps Remote Management',
    notBefore: new Date(now - 300000),
    notAfter: new Date(now + 90 * 86400000),
    signingAlgorithm: ALGORITHM,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([SERVER_AUTH], false),
      new x509.SubjectAlternativeNameExtension([{type: 'ip', value: address}], false)
    ]
  }, crypto.webcrypto);
  const certificatePEM = certificate.toString('pem');
  const parsed = new crypto.X509Certificate(certificatePEM);
  if (parsed.ca || parsed.checkIP(address) !== address || !parsed.verify(parsed.publicKey)) {
    fail('INVALID_REMOTE_CERTIFICATE');
  }
  return {certificatePEM, identity: publicIdentity(parsed, address)};
}

// Main-process only. A browser operator must explicitly trust the public leaf
// certificate before pairing. These functions change no operating-system trust.
async function createRemoteCertificate({address}) {
  addressValue(address);
  const keys = await crypto.webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const certificate = await issueCertificate(address, keys);
  const privateKeyDER = Buffer.from(await crypto.webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  return {...certificate, privateKeyDER};
}

// A changed address or expired leaf does not replace the protected device key.
async function reissueRemoteCertificate({address, privateKeyDER}) {
  addressValue(address);
  if (!Buffer.isBuffer(privateKeyDER) || privateKeyDER.length < 1 || privateKeyDER.length > MAX_KEY_BYTES) {
    fail('INVALID_REMOTE_CERTIFICATE');
  }
  const snapshot = Buffer.from(privateKeyDER);
  try {
    const key = crypto.createPrivateKey({key: snapshot, type: 'pkcs8', format: 'der'});
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      fail('INVALID_REMOTE_CERTIFICATE');
    }
    const publicDER = crypto.createPublicKey(key).export({type: 'spki', format: 'der'});
    const privateKey = await crypto.webcrypto.subtle.importKey('pkcs8', snapshot, ALGORITHM, false, ['sign']);
    const publicKey = await crypto.webcrypto.subtle.importKey('spki', publicDER, ALGORITHM, true, ['verify']);
    return await issueCertificate(address, {privateKey, publicKey});
  } catch {
    fail('INVALID_REMOTE_CERTIFICATE');
  } finally {
    snapshot.fill(0);
  }
}

// A lease owns one HTTPS server and private key copy. Its caller owns the
// original listener drain; release also awaits the original socket closes.
function createRemoteTLSLease({address, certificatePEM, privateKeyDER}) {
  addressValue(address);
  if (typeof certificatePEM !== 'string' || Buffer.byteLength(certificatePEM) > MAX_CERTIFICATE_BYTES ||
      !Buffer.isBuffer(privateKeyDER) || privateKeyDER.length < 1 || privateKeyDER.length > MAX_KEY_BYTES) {
    fail('INVALID_REMOTE_CERTIFICATE');
  }
  let certificate, key;
  try {
    certificate = new crypto.X509Certificate(certificatePEM);
    key = crypto.createPrivateKey({key: privateKeyDER, type: 'pkcs8', format: 'der'});
    const now = Date.now();
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1' ||
        certificate.ca || certificate.checkIP(address) !== address ||
        !certificate.verify(certificate.publicKey) || !certificate.checkPrivateKey(key) ||
        !certificate.keyUsage?.includes(SERVER_AUTH) ||
        Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) {
      fail('INVALID_REMOTE_CERTIFICATE');
    }
  } catch {
    fail('INVALID_REMOTE_CERTIFICATE');
  }
  const identity = publicIdentity(certificate, address);
  let server = null, released = false, attempted = false, releasePromise = null;
  const sockets = new Set();
  return Object.freeze({
    identity,
    createServer(requestHandler) {
      if (released || attempted || typeof requestHandler !== 'function') fail('TLS_LEASE_UNAVAILABLE');
      attempted = true;
      const pem = Buffer.from(key.export({type: 'pkcs8', format: 'pem'}));
      try {
        server = https.createServer({
          key: pem, cert: certificatePEM, minVersion: 'TLSv1.2',
          requestCert: false, maxHeaderSize: 8192, handshakeTimeout: 10000
        }, requestHandler);
      } finally {
        pem.fill(0);
        key = null;
      }
      server.maxConnections = 16;
      server.maxHeadersCount = 32;
      server.headersTimeout = 15000;
      server.requestTimeout = 15000;
      server.keepAliveTimeout = 5000;
      server.on('connection', socket => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });
      return server;
    },
    release() {
      if (released) return releasePromise;
      if (server?.listening) fail('TLS_DRAIN_PENDING');
      released = true;
      key = null;
      // A server close callback may precede the original socket close events.
      // Await those same sockets; never infer their closure from one event-loop turn.
      releasePromise = Promise.all([...sockets].map(socket =>
        new Promise(resolve => socket.once('close', resolve)))).then(() => { server = null; });
      return releasePromise;
    }
  });
}

module.exports = {createRemoteCertificate, reissueRemoteCertificate, createRemoteTLSLease};
