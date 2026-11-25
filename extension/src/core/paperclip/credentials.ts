/** Paperclip owns linked keys. Resolved values belong only to the current feature call. */
import type { SettingsRecord } from '../schema.js';
import type { ThreadStackDB } from '../db.js';
import { normalizeServerUrl, secretTransportAllowed, SECRET_TRANSPORT_REFUSED } from './client.js';
import { isValidAwsRegion } from '../aws.js';

export const MODEL_CREDENTIAL_KEYS = [
  'anthropicApiKey', 'awsPlatformApiKey', 'voyageApiKey', 'openaiApiKey', 'mongodbApiKey',
  'cohereApiKey', 'workerBearerToken', 'aws.bedrockApiKey', 'aws.accessKeyId',
  'aws.secretAccessKey', 'aws.sessionToken',
] as const;
export type ModelCredentialKey = typeof MODEL_CREDENTIAL_KEYS[number];
export interface PaperclipCredentialSettings {
  companyId: string;
  linkedKeys: string[];
  allowSecretTransfer: boolean;
  /** Local revocations survive an unavailable server and metadata refresh. */
  blockedKeys?: string[];
}
export const DEFAULT_PAPERCLIP_CREDENTIALS: PaperclipCredentialSettings = { companyId: '', linkedKeys: [], allowSecretTransfer: false };

export function normalizePaperclipCredentials(raw: unknown): PaperclipCredentialSettings {
  const r = raw && typeof raw === 'object' ? raw as Partial<PaperclipCredentialSettings> : {};
  const companyId = typeof r.companyId === 'string' ? r.companyId.trim().slice(0, 200) : '';
  const blockedKeys = companyId && Array.isArray(r.blockedKeys) ? [...new Set(r.blockedKeys.filter((key): key is string => typeof key === 'string' && MODEL_CREDENTIAL_KEYS.includes(key as ModelCredentialKey)))] : [];
  return { companyId, allowSecretTransfer: r.allowSecretTransfer === true,
    blockedKeys,
    linkedKeys: companyId && Array.isArray(r.linkedKeys) ? [...new Set(r.linkedKeys.filter((k): k is string => typeof k === 'string' && MODEL_CREDENTIAL_KEYS.includes(k as ModelCredentialKey) && !blockedKeys.includes(k)))] : [] };
}

export function getModelCredential(settings: SettingsRecord, key: ModelCredentialKey): string {
  if (key.startsWith('aws.')) return settings.aws[key.slice(4) as 'bedrockApiKey' | 'accessKeyId' | 'secretAccessKey' | 'sessionToken'];
  return settings[key as Exclude<ModelCredentialKey, `aws.${string}`>];
}
function setModelCredential(settings: SettingsRecord, key: ModelCredentialKey, value: string): void {
  if (key.startsWith('aws.')) settings.aws[key.slice(4) as 'bedrockApiKey' | 'accessKeyId' | 'secretAccessKey' | 'sessionToken'] = value;
  else settings[key as Exclude<ModelCredentialKey, `aws.${string}`>] = value;
}

/** Readiness is metadata-aware; linking never puts a sentinel or secret in saved settings. */
export function credentialPresent(settings: SettingsRecord, key: ModelCredentialKey): boolean {
  const config = normalizePaperclipCredentials(settings.paperclipCredentials);
  if (config.linkedKeys.includes(key)) return config.allowSecretTransfer && Boolean(config.companyId);
  return Boolean(getModelCredential(settings, key).trim());
}
export function awsModelCredentialKeys(settings: SettingsRecord): ModelCredentialKey[] {
  return settings.aws.auth === 'api_key' ? ['aws.bedrockApiKey'] : ['aws.accessKeyId', 'aws.secretAccessKey', 'aws.sessionToken'];
}
export function awsModelCredentialsReady(settings: SettingsRecord): boolean {
  return isValidAwsRegion(settings.aws.region) && (settings.aws.auth === 'api_key'
    ? credentialPresent(settings, 'aws.bedrockApiKey')
    : credentialPresent(settings, 'aws.accessKeyId') && credentialPresent(settings, 'aws.secretAccessKey'));
}
export function embeddingCredentialKeys(settings: SettingsRecord, provider = settings.embeddingProvider): ModelCredentialKey[] {
  switch (provider) {
    case 'voyage': return ['voyageApiKey'];
    case 'mongodb': return ['mongodbApiKey'];
    case 'cohere': return ['cohereApiKey'];
    case 'openai': return ['openaiApiKey'];
    case 'bedrock': return awsModelCredentialKeys(settings);
    default: return [];
  }
}
export function rerankCredentialKeys(settings: SettingsRecord): ModelCredentialKey[] {
  return settings.rerankProvider === 'none' ? [] : embeddingCredentialKeys(settings, settings.rerankProvider);
}
export function aiCredentialKeys(settings: SettingsRecord): ModelCredentialKey[] {
  if (settings.aiBackend === 'bedrock') return awsModelCredentialKeys(settings);
  if (settings.aiBackend === 'aws_platform') return settings.aws.auth === 'api_key' ? ['awsPlatformApiKey'] : awsModelCredentialKeys(settings);
  return ['anthropicApiKey'];
}

/**
 * Why a linked key is unavailable. `unavailable` is the contract notice (Paperclip down or unreachable);
 * `missing` means the secret is gone, so the key counts as absent; `disabled` means transfer is off.
 */
export type CredentialFailure = 'unavailable' | 'missing' | 'disabled' | 'not_paired';
export class PaperclipCredentialError extends Error {
  constructor(readonly feature: string, readonly reason: CredentialFailure = 'unavailable') {
    super(reason === 'missing' ? `The linked Paperclip secret is missing, so ${feature} has no key.`
      : reason === 'disabled' ? `Model keys from Paperclip are turned off, so ${feature} is paused.`
        : reason === 'not_paired' ? `ThreadStack is not paired with Paperclip, so ${feature} is paused.`
        : `Paperclip is not running, so ${feature} is paused.`);
    this.name = 'PaperclipCredentialError';
  }
}
/** Errors carry a bridge code (`not_found`, `denied`…) where one is known; anything else is "not reachable". */
export function credentialFailureOf(err: unknown): CredentialFailure {
  const code = err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : '';
  if (code === 'not_found' || code === 'secret_missing') return 'missing';
  if (code === 'denied' || code === 'disabled') return 'disabled';
  if (code === 'not_paired') return 'not_paired';
  return 'unavailable';
}
function codedError(code: string, message: string): Error { return Object.assign(new Error(message), { code }); }
export type ModelCredentialResolver = (companyId: string, key: ModelCredentialKey, settings: SettingsRecord) => Promise<string>;
let resolver: ModelCredentialResolver | null = null;
/** The worker injects its private bridge; manager feature calls use its validated runtime route. */
export function configureModelCredentialResolver(next: ModelCredentialResolver | null): void { resolver = next; }

/**
 * Paperclip allows 30 secret reads per minute and bulk indexing embeds one thread per call, so the
 * worker reuses a resolved value for at most 30 s. Memory only, never persisted. Callers consult it
 * only after re-checking consent, company and link in the current database record, so switching
 * anything off takes effect at once. Rotation shows within 30 s (contract: 60 s). Readbacks for
 * linking and moving bypass it.
 *
 * Dropped at once when: a read fails (nothing is stored), any company's bridge poll/connect fails,
 * pairing is lost, or any credential/pairing command runs. Bounded staleness that remains (REQ-14
 * AC-4/AC-6, accepted): while the bridge stays healthy, a secret deleted or consent turned off on the
 * Paperclip side alone can still be used for at most MODEL_CREDENTIAL_CACHE_MS (30 s).
 */
export const MODEL_CREDENTIAL_CACHE_MS = 30_000;
export function createSecretReadCache(read: (companyId: string, key: ModelCredentialKey) => Promise<string>, now: () => number = Date.now) {
  const values = new Map<string, { value: string; at: number }>();
  // A read already in flight when clear() runs must not repopulate the cache afterwards (F-5).
  let generation = 0;
  return {
    async read(companyId: string, key: ModelCredentialKey): Promise<string> {
      const id = `${companyId}\0${key}`; const hit = values.get(id); const age = hit ? now() - hit.at : -1;
      if (hit && age >= 0 && age < MODEL_CREDENTIAL_CACHE_MS) return hit.value;
      values.delete(id);
      const started = generation;
      const value = await read(companyId, key);
      if (started === generation && typeof value === 'string' && value.trim()) values.set(id, { value, at: now() });
      return value;
    },
    clear(): void { generation++; values.clear(); },
  };
}
async function runtimeResolve(companyId: string, keyName: ModelCredentialKey): Promise<string> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) throw new Error('bridge_unavailable');
  const response = await chrome.runtime.sendMessage({ type: 'PAPERCLIP_INTEGRATION', action: 'credentials.resolve', payload: { companyId, keyName } });
  if (!response?.ok) throw codedError(typeof response?.code === 'string' ? response.code : 'internal', 'Paperclip model-key read failed.');
  if (typeof response.data?.value !== 'string' || !response.data.value.trim()) throw codedError('secret_missing', 'secret_missing');
  return response.data.value;
}

/** The resolver (worker) owns any short cache; this layer never keeps a value beyond the returned copy. */
export async function resolveModelSettings(settings: SettingsRecord, feature: string, keys: readonly ModelCredentialKey[]): Promise<SettingsRecord> {
  const config = normalizePaperclipCredentials(settings.paperclipCredentials);
  const wanted = [...new Set(keys)].filter((key) => config.linkedKeys.includes(key));
  if (!wanted.length) return settings;
  if (!config.companyId || !config.allowSecretTransfer) throw new PaperclipCredentialError(feature, 'disabled');
  const next = { ...settings, aws: { ...settings.aws } };
  try {
    for (const key of wanted) {
      const value = await (resolver ?? runtimeResolve)(config.companyId, key, settings);
      if (typeof value !== 'string' || !value.trim()) throw codedError('secret_missing', 'secret_missing');
      setModelCredential(next, key, value);
    }
  } catch (err) { throw new PaperclipCredentialError(feature, credentialFailureOf(err)); }
  return next;
}

export interface CredentialSecret { id: string; name: string; }
export interface CredentialBackend {
  listSecrets(): Promise<CredentialSecret[]>;
  saveSecret(key: ModelCredentialKey, value: string): Promise<string>;
  link(key: ModelCredentialKey, secretId: string | null): Promise<void>;
  setConsent(enabled: boolean): Promise<void>;
  clearLinks(): Promise<void>;
  metadata(): Promise<PaperclipCredentialSettings & { missingKeys?: string[] }>;
  resolve(key: ModelCredentialKey): Promise<string>;
}

/** Board writes use existing governed APIs; only the private paired bridge can resolve values. */
export function createCredentialBackend(settings: SettingsRecord, companyId: string,
  resolveSecret: (companyId: string, key: ModelCredentialKey) => Promise<string>, fetchImpl: typeof fetch = fetch): CredentialBackend {
  const origin = normalizeServerUrl(settings.paperclip.serverUrl);
  if (!origin || !companyId.trim()) throw new Error('Choose a Paperclip company first.');
  const request = async (path: string, body?: unknown): Promise<any> => {
    const response = await fetchImpl(`${origin}/api${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'omit', redirect: 'error',
      headers: { 'content-type': 'application/json', ...(settings.paperclip.apiKey ? { authorization: `Bearer ${settings.paperclip.apiKey}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Paperclip model-key request failed (${response.status}).`);
    return response.json();
  };
  const configPath = `/plugins/browser-sessions/config?companyId=${encodeURIComponent(companyId)}`;
  const update = async (apply: (current: Record<string, any>) => Record<string, any>) => {
    const row = await request(configPath);
    const current = row?.configJson && typeof row.configJson === 'object' ? row.configJson : {};
    await request('/plugins/browser-sessions/config', { companyId, configJson: apply(current) });
  };
  const listSecrets = async (): Promise<CredentialSecret[]> => {
    const rows = await request(`/companies/${encodeURIComponent(companyId)}/secrets`);
    if (!Array.isArray(rows)) throw new Error('Paperclip returned an invalid secret catalog.');
    return rows.filter((r) => r && typeof r.id === 'string' && typeof r.name === 'string' && r.status !== 'deleted').map((r) => ({ id: r.id, name: r.name }));
  };
  return {
    listSecrets,
    async saveSecret(key, value) {
      if (!secretTransportAllowed(origin)) throw new Error(SECRET_TRANSPORT_REFUSED);
      const name = `ThreadStack ${key}`;
      const existing = (await listSecrets()).find((row) => row.name === name);
      if (existing) { await request(`/secrets/${encodeURIComponent(existing.id)}/rotate`, { value }); return existing.id; }
      const created = await request(`/companies/${encodeURIComponent(companyId)}/secrets`, { name, value, description: 'Model credential moved from ThreadStack by its owner.' });
      if (typeof created?.id !== 'string') throw new Error('Paperclip did not confirm the secret.');
      return created.id;
    },
    async link(key, secretId) { await update((current) => {
      const credentialLinks = { ...current.credentialLinks };
      if (secretId === null) delete credentialLinks[key];
      else credentialLinks[key] = { type: 'secret_ref', secretId, version: 'latest' };
      return { ...current, credentialLinks };
    }); },
    async setConsent(enabled) { await update((current) => ({ ...current, allowSecretTransfer: enabled })); },
    async clearLinks() { await update((current) => ({ ...current, credentialLinks: {}, allowSecretTransfer: false })); },
    async metadata() {
      const body = await request(`/plugins/browser-sessions/api/credentials?companyId=${encodeURIComponent(companyId)}`);
      const [config, secrets] = await Promise.all([request(configPath), listSecrets()]);
      const ids = new Set(secrets.map((secret) => secret.id));
      const links = config?.configJson?.credentialLinks ?? {};
      const metadata = normalizePaperclipCredentials({ ...body, companyId });
      const missingKeys = metadata.linkedKeys.filter((key) => !ids.has(links[key]?.secretId));
      return { ...metadata, linkedKeys: metadata.linkedKeys.filter((key) => !missingKeys.includes(key)), missingKeys };
    },
    resolve: (key) => resolveSecret(companyId, key),
  };
}

/** In one fresh transaction: mark `key` linked and erase its stored value (IndexedDB and so backups). */
async function commitLinkedKey(db: ThreadStackDB, key: ModelCredentialKey,
  unchanged: (current: SettingsRecord, config: PaperclipCredentialSettings) => boolean = () => true): Promise<void> {
  await db.transaction('rw', db.settings, async () => {
    const current = await db.settings.get('default');
    const now = normalizePaperclipCredentials(current?.paperclipCredentials);
    if (!current || !unchanged(current, now)) throw new Error('settings_changed');
    const next = { ...current, aws: { ...current.aws }, paperclipCredentials: { ...now, blockedKeys: now.blockedKeys?.filter((blocked) => blocked !== key), linkedKeys: [...new Set([...now.linkedKeys, key])] } };
    setModelCredential(next, key, '');
    await db.settings.put(next);
  });
}

export interface CredentialMoveResult { moved: ModelCredentialKey[]; notMoved: ModelCredentialKey[]; }
/** Values are erased only in a fresh transaction, after exact readback, if the user has not edited them. */
export async function moveModelKeys(db: ThreadStackDB, original: SettingsRecord, backend: CredentialBackend): Promise<CredentialMoveResult> {
  const config = normalizePaperclipCredentials(original.paperclipCredentials);
  if (!config.companyId || !config.allowSecretTransfer) throw new Error('Allow model keys from Paperclip before moving them.');
  const result: CredentialMoveResult = { moved: [], notMoved: [] };
  for (const key of MODEL_CREDENTIAL_KEYS) {
    const value = getModelCredential(original, key);
    if (!value.trim()) continue;
    let linkedHere = false;
    try {
      if (!config.linkedKeys.includes(key)) {
        const secretId = await backend.saveSecret(key, value);
        await backend.link(key, secretId);
        linkedHere = true;
      }
      if (await backend.resolve(key) !== value) throw new Error('readback_mismatch');
      await commitLinkedKey(db, key, (current, now) => getModelCredential(current, key) === value && now.companyId === config.companyId && now.allowSecretTransfer);
      result.moved.push(key);
    } catch {
      // A failed readback never leaves a half-moved link eligible for later metadata import.
      if (linkedHere) await backend.link(key, null).catch(() => undefined);
      result.notMoved.push(key);
    }
  }
  return result;
}

export interface CredentialStatus extends PaperclipCredentialSettings {
  secrets: CredentialSecret[];
  missingKeys: string[];
  moved?: ModelCredentialKey[];
  notMoved?: ModelCredentialKey[];
}
type BackendFactory = typeof createCredentialBackend;
let mutation = Promise.resolve();

/** Called only after the worker validates the manager sender. Values stay out of status responses. */
export async function handleCredentialCommand(db: ThreadStackDB,
  resolveSecret: (companyId: string, key: ModelCredentialKey) => Promise<string>, action: string,
  payload: unknown, factory: BackendFactory = createCredentialBackend,
  /** Feature reads may use the worker's short cache; link/move readbacks always use `resolveSecret`. */
  featureRead?: (companyId: string, key: ModelCredentialKey) => Promise<string>): Promise<unknown> {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const companyId = typeof p.companyId === 'string' ? p.companyId.trim() : '';
  const keyName = typeof p.keyName === 'string' && MODEL_CREDENTIAL_KEYS.includes(p.keyName as ModelCredentialKey) ? p.keyName as ModelCredentialKey : null;
  if (action !== 'credentials.clear' && (!companyId || companyId.length > 200)) throw new Error('Choose a Paperclip company first.');
  const execute = async () => {
    const settings = await db.settings.get('default');
    if (!settings) throw new Error('ThreadStack settings are not ready.');
    const current = normalizePaperclipCredentials(settings.paperclipCredentials);
    const save = async (next: PaperclipCredentialSettings) => {
      await db.settings.update('default', { paperclipCredentials: next });
      return next;
    };
    // The company that stops being the source keeps no consent or links on the server.
    const clearPrevious = async () => { if (current.companyId) await factory(settings, current.companyId, resolveSecret).clearLinks(); };
    if (action === 'credentials.clear') {
      await save({ companyId: '', linkedKeys: [], allowSecretTransfer: false });
      await clearPrevious();
      return { companyId: '', linkedKeys: [], allowSecretTransfer: false, secrets: [], missingKeys: [] } satisfies CredentialStatus;
    }
    const backend = factory(settings, companyId, resolveSecret);
    if (action === 'credentials.resolve') {
      if (!keyName || current.companyId !== companyId || !current.allowSecretTransfer || !current.linkedKeys.includes(keyName)) throw codedError('disabled', 'Model-key access is disabled.');
      const value = featureRead ? await featureRead(companyId, keyName) : await backend.resolve(keyName);
      if (!value.trim()) throw codedError('not_found', 'Paperclip secret is missing.');
      const latest = normalizePaperclipCredentials((await db.settings.get('default'))?.paperclipCredentials);
      if (!latest.allowSecretTransfer || latest.companyId !== companyId || !latest.linkedKeys.includes(keyName)) throw codedError('disabled', 'Model-key access was disabled.');
      return { value };
    }
    if (action === 'credentials.source') {
      if (current.companyId !== companyId) {
        // Local denial is committed before the remote operation, including when it fails.
        await save({ companyId, linkedKeys: [], allowSecretTransfer: false });
        // Both remote clears are attempted; the first failure is reported after the second ran.
        const results = await Promise.allSettled([clearPrevious(), backend.clearLinks()]);
        const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failed) throw failed.reason;
      }
    } else if (action === 'credentials.consent') {
      if (current.companyId !== companyId) throw new Error('Choose this company as the key source first.');
      if (typeof p.enabled !== 'boolean') throw new Error('Choose whether model-key transfer is allowed.');
      if (!p.enabled) await save({ ...current, allowSecretTransfer: false });
      await backend.setConsent(p.enabled);
      await save({ ...current, allowSecretTransfer: p.enabled });
    } else if (action === 'credentials.link') {
      if (!keyName || current.companyId !== companyId) throw new Error('Choose a model key in the source company.');
      const secretId = p.secretId === null ? null : typeof p.secretId === 'string' && p.secretId.length <= 200 ? p.secretId : undefined;
      if (secretId === undefined || secretId === '') throw new Error('Choose a Paperclip secret.');
      if (secretId === null) {
        await save({ ...current, blockedKeys: [...new Set([...(current.blockedKeys ?? []), keyName])], linkedKeys: current.linkedKeys.filter((key) => key !== keyName) });
        await backend.link(keyName, null);
      } else {
        if (!current.allowSecretTransfer) throw new Error('Allow model-key transfer before linking a secret.');
        if (!(await backend.listSecrets()).some((secret) => secret.id === secretId)) throw new Error('The selected secret is missing.');
        await backend.link(keyName, secretId);
        try { if (!(await backend.resolve(keyName)).trim()) throw new Error('secret_missing'); }
        catch { await backend.link(keyName, null).catch(() => undefined); throw new Error('Paperclip could not read the linked secret; the stored key was kept.'); }
        // The readback succeeded: the link replaces the stored copy, which must leave IndexedDB and backups.
        await commitLinkedKey(db, keyName);
      }
    } else if (action === 'credentials.move') {
      if (current.companyId !== companyId || !current.allowSecretTransfer) throw new Error('Allow model-key transfer in the chosen company before moving keys.');
      const result = await moveModelKeys(db, settings, backend);
      const saved = normalizePaperclipCredentials((await db.settings.get('default'))?.paperclipCredentials);
      return { ...saved, ...result, secrets: await backend.listSecrets(), missingKeys: [] } satisfies CredentialStatus;
    } else if (action !== 'credentials.status') throw new Error('Unknown model-key action.');

    const remote = await backend.metadata();
    const local = normalizePaperclipCredentials((await db.settings.get('default'))?.paperclipCredentials);
    const sameSource = local.companyId === companyId;
    // Metadata never opts the extension into transfer; "off" on either side wins.
    const linkedKeys = sameSource ? remote.linkedKeys.filter((key) => !local.blockedKeys?.includes(key) && (local.linkedKeys.includes(key) || !getModelCredential(settings, key as ModelCredentialKey).trim())) : [];
    const next = { companyId, linkedKeys, blockedKeys: sameSource ? local.blockedKeys : [], allowSecretTransfer: sameSource && local.allowSecretTransfer && remote.allowSecretTransfer };
    if (sameSource) await save(next);
    return { ...next, secrets: await backend.listSecrets(), missingKeys: [...new Set([...(remote.missingKeys ?? []), ...local.linkedKeys.filter((key) => !remote.linkedKeys.includes(key))])] } satisfies CredentialStatus;
  };
  if (action === 'credentials.resolve') return execute();
  const task = mutation.then(execute, execute);
  mutation = task.then(() => undefined, () => undefined);
  return task;
}
