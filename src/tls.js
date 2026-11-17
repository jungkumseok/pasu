import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { config } from './config.js';
import { ensureDir } from './fsutil.js';

/** Load the configured certificate, or generate (once) a self-signed one in data/tls. */
export function loadTls() {
  let certFile = config.tlsCert;
  let keyFile = config.tlsKey;
  let selfSigned = false;

  if (!certFile || !keyFile) {
    if (certFile || keyFile) throw new Error('Set both PASU_TLS_CERT and PASU_TLS_KEY, or neither');
    ensureDir(config.tlsDir);
    certFile = path.join(config.tlsDir, 'cert.pem');
    keyFile = path.join(config.tlsDir, 'key.pem');
    selfSigned = true;
    if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) generateSelfSigned(certFile, keyFile);
  }

  const cert = fs.readFileSync(certFile);
  const key = fs.readFileSync(keyFile);
  const fingerprint = new crypto.X509Certificate(cert).fingerprint256;
  return { cert, key, selfSigned, fingerprint };
}

function generateSelfSigned(certFile, keyFile) {
  const host = os.hostname();
  console.log(`[tls] generating self-signed certificate for ${host}`);
  execFileSync('openssl', [
    'req', '-x509', '-nodes',
    '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-keyout', keyFile, '-out', certFile,
    '-days', '3650',
    '-subj', `/CN=${host}`,
    '-addext', `subjectAltName=DNS:${host},DNS:localhost,IP:127.0.0.1`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  fs.chmodSync(keyFile, 0o600);
}
