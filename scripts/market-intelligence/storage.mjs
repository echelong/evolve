import { mkdirSync, writeFileSync, openSync, writeSync, fsyncSync, closeSync, readFileSync, readdirSync, lstatSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { canonical, digest, EVIDENCE, redact } from './definition.mjs';

export const fileHash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
export const manifestFingerprint = files => digest(files);
export function createStorage({ root = '.evolve/market-intelligence', sessionId = `${Date.now()}-${randomUUID()}`, startedAt = Date.now(), maxRawBytes = 262144, maxSessionBytes = 67108864, secrets = [] } = {}) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId)) throw new Error('Invalid session identity');
  // Reject symlink ancestors so a session cannot redirect writes to existing evidence.
  const absolute = path.resolve(root);
  let ancestor = path.parse(absolute).root;
  for (const part of absolute.slice(ancestor.length).split(path.sep)) {
    ancestor = path.join(ancestor, part);
    try { if (lstatSync(ancestor).isSymbolicLink()) throw new Error('Storage symlink forbidden'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  mkdirSync(path.join(absolute, 'sessions'), { recursive: true });
  const dir = path.join(absolute, 'sessions', sessionId);
  mkdirSync(dir); // Exclusive session creation; prior sessions are never reopened for writing.
  mkdirSync(path.join(dir, 'raw'));
  let closed = false, bytes = 0, records = 0, firstAt = null, lastAt = null;
  const counts = {}, providerCounts = {}, errorCounts = {}, mints = new Set();
  const session = { schemaVersion: 1, recordType: 'session', ...EVIDENCE, sessionId, startedAt, maxRawBytes, maxSessionBytes };
  const sessionBody = canonical(session) + '\n';
  writeFileSync(path.join(dir, 'session.json'), sessionBody, { flag: 'wx', mode: 0o600 }); bytes += Buffer.byteLength(sessionBody);
  const files = ['raw/jupiter.ndjson', 'raw/gmgn.ndjson', 'raw/dexscreener.ndjson', 'raw/launch-events.ndjson', 'normalized.ndjson', 'disagreement.ndjson', 'errors.ndjson'];
  for (const file of files) writeFileSync(path.join(dir, file), '', { flag: 'wx', mode: 0o600 });
  const rawFile = p => p === 'launch-observer' ? 'raw/launch-events.ndjson' : `raw/${p}.ndjson`;
  function encode(record) { return canonical(redact(record, secrets)) + '\n'; }
  function append(file, body) {
    const fd = openSync(path.join(dir, file), 'a', 0o600);
    try { const buffer = Buffer.from(body); let offset = 0; while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset); fsyncSync(fd); } finally { closeSync(fd); }
    bytes += Buffer.byteLength(body); counts[file] = (counts[file] || 0) + 1;
  }
  function reserve(bodies) {
    if (closed) throw new Error('Session finalized');
    if (bytes + bodies.reduce((sum, b) => sum + Buffer.byteLength(b), 0) > maxSessionBytes - 16384) throw new Error('SESSION_STORAGE_BOUND');
  }
  function track(record) {
    records++; if (record.mint) mints.add(record.mint);
    const timestamp = record.providerObservedAt ?? record.observedAt;
    if (Number.isFinite(timestamp)) { firstAt = firstAt === null ? timestamp : Math.min(firstAt, timestamp); lastAt = lastAt === null ? timestamp : Math.max(lastAt, timestamp); }
  }
  return Object.freeze({ dir,
    writeRawResponse(result, provider) {
      const payload = redact(result.payload, secrets);
      const raw = { schemaVersion: 1, recordType: 'raw_response', ...EVIDENCE, timestamp: result.receivedAt,
        observedAt: result.receivedAt, capturedAt: result.receivedAt, provider, providerVersion: null,
        sourceEndpoint: result.endpoint, requestIdentity: result.requestIdentity, chain: 'solana', mint: result.requestIdentity,
        rawResponseDigest: digest(payload), normalizedPayloadDigest: null, staleness: null,
        dataAvailability: { normalized: false }, limitations: ['No normalized records from this response'], payload };
      const body = encode(raw); if (Buffer.byteLength(body) > maxRawBytes) throw new Error('RAW_STORAGE_BOUND');
      reserve([body]); append(rawFile(provider), body);
    },
    writeObservation(record, payload, requestIdentity = record.mint) {
      if (!['jupiter', 'gmgn', 'dexscreener', 'launch-observer'].includes(record.provider)) throw new Error('Unknown provider');
      const safePayload = redact(payload, secrets), safeRecord = redact(record, secrets);
      if (digest(safePayload) !== record.rawResponseDigest || digest(safeRecord.normalized) !== record.normalizedPayloadDigest) throw new Error('PERSISTENCE_DIGEST_MISMATCH');
      const raw = { schemaVersion: 1, recordType: 'raw_response', ...EVIDENCE, timestamp: record.receivedAt, observedAt: record.observedAt, capturedAt: record.capturedAt,
        provider: record.provider, providerVersion: record.providerVersion, sourceEndpoint: record.sourceEndpoint, chain: record.chain, mint: record.mint,
        requestIdentity, rawResponseDigest: record.rawResponseDigest, normalizedPayloadDigest: record.normalizedPayloadDigest,
        staleness: record.staleness, dataAvailability: record.dataAvailability, limitations: record.limitations, payload: safePayload };
      const rawBody = encode(raw), body = encode(record);
      if (Buffer.byteLength(rawBody) > maxRawBytes) throw new Error('RAW_STORAGE_BOUND');
      reserve([rawBody, body]); append(rawFile(record.provider), rawBody); append('normalized.ndjson', body);
      providerCounts[record.provider] = (providerCounts[record.provider] || 0) + 1; track(record);
    },
    writeSnapshot(snapshot) {
      const { disagreement, ...record } = snapshot;
      const body = encode(record), cross = encode(disagreement); reserve([body, cross]);
      append('normalized.ndjson', body); append('disagreement.ndjson', cross); track(record);
    },
    error(provider, code, at) {
      const record = { schemaVersion: 1, recordType: 'provider_error', ...EVIDENCE, provider, observedAt: at, code: /^[A-Z_0-9]+$/.test(code) ? code : 'OBSERVATION_FAILED' };
      const body = encode(record); reserve([body]); append('errors.ndjson', body); errorCounts[provider] = (errorCounts[provider] || 0) + 1;
    },
    finalize({ endedAt = Date.now(), reason = 'complete', health = {}, metrics = {} } = {}) {
      if (closed) throw new Error('Session finalized');
      closed = true;
      const summary = { schemaVersion: 1, recordType: 'summary', ...EVIDENCE, sessionId, startedAt, endedAt, reason,
        status: reason === 'capture failed' ? 'incomplete' : 'complete', recordCount: records, fileRecordCounts: counts, providerCounts, errorCounts, firstObservedAt: firstAt, lastObservedAt: lastAt,
        uniqueMintCount: mints.size, metrics: redact(metrics, secrets), health: redact(health, secrets), bytesBeforeFinalization: bytes };
      function atomic(file, value) {
        const temp = path.join(dir, `${file}.tmp`), fd = openSync(temp, 'wx', 0o600);
        try { const body = canonical(redact(value, secrets)) + '\n'; if (Buffer.byteLength(body) > 8192) throw new Error('FINALIZATION_STORAGE_BOUND'); writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(temp, path.join(dir, file));
      }
      atomic('summary.json', summary);
      const hashes = Object.fromEntries([...files, 'session.json', 'summary.json'].sort().map(f => [f, fileHash(path.join(dir, f))]));
      const manifest = { ...summary, recordType: 'manifest', files: hashes, fingerprint: manifestFingerprint(hashes) };
      atomic('manifest.json', manifest); return manifest;
    },
  });
}
export function readSummary(root = '.evolve/market-intelligence') {
  const sessions = path.join(root, 'sessions');
  return readdirSync(sessions).sort().flatMap(id => {
    try { return [JSON.parse(readFileSync(path.join(sessions, id, 'summary.json'), 'utf8'))]; } catch { return []; }
  });
}
