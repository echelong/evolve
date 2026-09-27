import { mkdirSync, writeFileSync, openSync, writeSync, fsyncSync, closeSync, readFileSync, readdirSync, lstatSync, fstatSync, renameSync, constants } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { canonical, digest, EVIDENCE, redact } from './definition.mjs';

// Session capacity is a hard bound, never unlimited. Finalization writes exactly
// two records (summary, manifest), each capped at 8 KiB, so the reserve always
// fits both: a session that reaches its append bound can still finalize.
export const MIB = 1024 * 1024;
export const SESSION_CAPACITY_MIB = Object.freeze({ default: 512, min: 64, max: 2048 });
export const DEFAULT_MAX_SESSION_BYTES = SESSION_CAPACITY_MIB.default * MIB;
export const FINALIZATION_RECORD_MAX_BYTES = 8 * 1024;
export const SESSION_FINALIZATION_RESERVE_BYTES = 16 * 1024;
export const fileHash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
export const manifestFingerprint = files => digest(files);
const RAW_FILES = Object.freeze({ jupiter: 'raw/jupiter.ndjson', gmgn: 'raw/gmgn.ndjson', dexscreener: 'raw/dexscreener.ndjson', 'launch-observer': 'raw/launch-events.ndjson' });
function rejectSymlinks(absolute) {
  let ancestor = path.parse(absolute).root;
  for (const part of absolute.slice(ancestor.length).split(path.sep)) {
    ancestor = path.join(ancestor, part);
    try { if (lstatSync(ancestor).isSymbolicLink()) throw new Error('STORAGE_SYMLINK_FORBIDDEN'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
export function createStorage({ root = '.evolve/market-intelligence', sessionId = `${Date.now()}-${randomUUID()}`, startedAt = Date.now(), maxRawBytes = 262144, maxSessionBytes = DEFAULT_MAX_SESSION_BYTES, secrets = [] } = {}) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId)) throw new Error('Invalid session identity');
  // A NaN/Infinity/nonpositive cap would silently disable the bound; reject it before any write.
  if (!Number.isSafeInteger(maxSessionBytes) || maxSessionBytes <= SESSION_FINALIZATION_RESERVE_BYTES) throw new Error('SESSION_STORAGE_BOUND_INVALID');
  const usableSessionBytes = maxSessionBytes - SESSION_FINALIZATION_RESERVE_BYTES;
  // Reject symlink ancestors so a session cannot redirect writes to existing evidence.
  const absolute = path.resolve(root);
  rejectSymlinks(path.join(absolute, 'sessions'));
  mkdirSync(path.join(absolute, 'sessions'), { recursive: true });
  const dir = path.join(absolute, 'sessions', sessionId);
  rejectSymlinks(dir);
  mkdirSync(dir); // Exclusive session creation; prior sessions are never reopened for writing.
  mkdirSync(path.join(dir, 'raw'));
  const files = [...Object.values(RAW_FILES), 'normalized.ndjson', 'disagreement.ndjson', 'errors.ndjson'];
  const allowedFiles = new Set([...files, 'session.json', 'summary.json', 'manifest.json', 'summary.json.tmp', 'manifest.json.tmp']);
  const fileIdentities = new Map();
  function destination(file) {
    if (!allowedFiles.has(file) || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new Error('STORAGE_PATH_FORBIDDEN');
    const target = path.resolve(dir, file);
    if (!target.startsWith(dir + path.sep)) throw new Error('STORAGE_PATH_FORBIDDEN');
    rejectSymlinks(target); return target;
  }
  function openFile(file, flags, create = false) {
    const target = destination(file), fd = openSync(target, flags | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const stat = fstatSync(fd), expected = fileIdentities.get(file);
      if (!stat.isFile() || !create && (!expected || stat.dev !== expected.dev || stat.ino !== expected.ino)) throw new Error('STORAGE_FILE_IDENTITY_MISMATCH');
      rejectSymlinks(target);
      const current = lstatSync(target);
      if (current.dev !== stat.dev || current.ino !== stat.ino) throw new Error('STORAGE_FILE_IDENTITY_MISMATCH');
      if (create) fileIdentities.set(file, { dev: stat.dev, ino: stat.ino });
      return fd;
    } catch (e) { closeSync(fd); throw e; }
  }
  function exclusive(file, body) {
    const fd = openFile(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, true);
    try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  }
  let closed = false, bytes = 0, records = 0, firstAt = null, lastAt = null, sessionBoundReached = false;
  const counts = {}, providerCounts = {}, errorCounts = {}, mints = new Set();
  const session = { schemaVersion: 1, recordType: 'session', ...EVIDENCE, sessionId, startedAt, maxRawBytes, maxSessionBytes };
  const sessionBody = canonical(session) + '\n';
  exclusive('session.json', sessionBody); bytes += Buffer.byteLength(sessionBody);
  for (const file of files) exclusive(file, '');
  const rawFile = provider => { if (!Object.hasOwn(RAW_FILES, provider)) throw new Error('STORAGE_PROVIDER_FORBIDDEN'); return RAW_FILES[provider]; };
  function encode(record) { return canonical(redact(record, secrets)) + '\n'; }
  function append(file, body) {
    const fd = openFile(file, constants.O_WRONLY | constants.O_APPEND);
    try { const buffer = Buffer.from(body); let offset = 0; while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset); fsyncSync(fd); } finally { closeSync(fd); }
    bytes += Buffer.byteLength(body); counts[file] = (counts[file] || 0) + 1;
  }
  function reserve(bodies) {
    if (closed) throw new Error('Session finalized');
    if (bytes + bodies.reduce((sum, b) => sum + Buffer.byteLength(b), 0) > usableSessionBytes) { sessionBoundReached = true; throw new Error('SESSION_STORAGE_BOUND'); }
  }
  function track(record) {
    records++; if (record.mint) mints.add(record.mint);
    const timestamp = record.providerObservedAt ?? record.observedAt;
    if (Number.isFinite(timestamp)) { firstAt = firstAt === null ? timestamp : Math.min(firstAt, timestamp); lastAt = lastAt === null ? timestamp : Math.max(lastAt, timestamp); }
  }
  return Object.freeze({ dir,
    writeRawResponse(result, provider) {
      const file = rawFile(provider);
      const payload = redact(result.payload, secrets);
      const raw = { schemaVersion: 1, recordType: 'raw_response', ...EVIDENCE, timestamp: result.receivedAt,
        observedAt: result.receivedAt, capturedAt: result.receivedAt, provider, providerVersion: null,
        sourceEndpoint: result.endpoint, requestIdentity: result.requestIdentity, chain: 'solana', mint: result.requestIdentity,
        rawResponseDigest: digest(payload), normalizedPayloadDigest: null, staleness: null,
        dataAvailability: { normalized: false }, limitations: ['No normalized records from this response'], payload };
      const body = encode(raw); if (Buffer.byteLength(body) > maxRawBytes) throw new Error('RAW_STORAGE_BOUND');
      reserve([body]); append(file, body);
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
        uniqueMintCount: mints.size, metrics: redact(metrics, secrets), health: redact(health, secrets), bytesBeforeFinalization: bytes,
        // Additive capacity telemetry; top-level bytesBeforeFinalization is kept for existing readers.
        storage: { bytesBeforeFinalization: bytes, maxSessionBytes, finalizationReserveBytes: SESSION_FINALIZATION_RESERVE_BYTES, usableSessionBytes,
          utilizationRatio: Math.round(bytes / usableSessionBytes * 1e6) / 1e6, sessionBoundReached } };
      function atomic(file, value) {
        const body = canonical(redact(value, secrets)) + '\n'; if (Buffer.byteLength(body) > FINALIZATION_RECORD_MAX_BYTES) throw new Error('FINALIZATION_STORAGE_BOUND');
        exclusive(`${file}.tmp`, body);
        const target = destination(file);
        try { lstatSync(target); throw new Error('STORAGE_FINALIZATION_OVERWRITE'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        renameSync(destination(`${file}.tmp`), target);
        fileIdentities.set(file, fileIdentities.get(`${file}.tmp`));
      }
      atomic('summary.json', summary);
      const hashes = Object.fromEntries([...files, 'session.json', 'summary.json'].sort().map(file => {
        const fd = openFile(file, constants.O_RDONLY);
        try { return [file, createHash('sha256').update(readFileSync(fd)).digest('hex')]; } finally { closeSync(fd); }
      }));
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
