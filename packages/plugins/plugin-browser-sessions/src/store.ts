import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";

export type RecordKind = "bridge" | "pair" | "session" | "link" | "action" | "event" | "notification";
export interface ListOptions { where?: Record<string, string | boolean>; limit?: number }
export interface Store {
  get<T>(kind: RecordKind, companyId: string, key: string): Promise<T | null>;
  put<T>(kind: RecordKind, companyId: string, key: string, value: T, onlyIfAbsent?: boolean): Promise<boolean>;
  list<T>(kind: RecordKind, companyId: string, options?: ListOptions): Promise<T[]>;
  remove(kind: RecordKind, companyId: string, key?: string): Promise<void>;
}
/** Uses only the host's company-scoped, restricted plugin SQL boundary. */
export class DatabaseStore implements Store {
  private readonly table: string;
  constructor(private readonly db: PluginDatabaseClient) {
    if (!/^[a-z_][a-z0-9_]*$/.test(db.namespace)) throw new Error("Invalid plugin database namespace");
    this.table = `"${db.namespace}".records`;
  }
  async get<T>(kind: RecordKind, companyId: string, key: string): Promise<T | null> {
    const rows = await this.db.query<{ payload: T }>(`SELECT payload FROM ${this.table} WHERE company_id=$1 AND kind=$2 AND record_key=$3`, [companyId, kind, key]);
    return rows[0]?.payload ?? null;
  }
  async put<T>(kind: RecordKind, companyId: string, key: string, value: T, onlyIfAbsent = false): Promise<boolean> {
    const conflict = onlyIfAbsent ? "DO NOTHING" : "DO UPDATE SET payload=EXCLUDED.payload, updated_at=now()";
    const result = await this.db.execute(`INSERT INTO ${this.table} (company_id,kind,record_key,payload) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (company_id,kind,record_key) ${conflict}`, [companyId, kind, key, JSON.stringify(value)]);
    return result.rowCount > 0;
  }
  async list<T>(kind: RecordKind, companyId: string, options: ListOptions = {}): Promise<T[]> {
    const params: unknown[] = [companyId, kind];
    const predicates = ["company_id=$1", "kind=$2"];
    for (const [key, value] of Object.entries(options.where ?? {})) {
      params.push(key, String(value));
      predicates.push(`payload->>$${params.length - 1} = $${params.length}`);
    }
    params.push(options.limit ?? 100_000);
    const rows = await this.db.query<{ payload: T }>(`SELECT payload FROM ${this.table} WHERE ${predicates.join(" AND ")} ORDER BY created_at DESC, record_key LIMIT $${params.length}`, params);
    return rows.map((row) => row.payload);
  }
  async remove(kind: RecordKind, companyId: string, key?: string): Promise<void> {
    await this.db.execute(`DELETE FROM ${this.table} WHERE company_id=$1 AND kind=$2${key === undefined ? "" : " AND record_key=$3"}`, key === undefined ? [companyId, kind] : [companyId, kind, key]);
  }
}

/** Deterministic repository for domain tests; production always uses DatabaseStore. */
export class MemoryStore implements Store {
  private readonly rows = new Map<string, { value: unknown; order: number }>();
  private nextOrder = 0;
  private key(kind: RecordKind, companyId: string, key: string) { return JSON.stringify([companyId, kind, key]); }
  async get<T>(kind: RecordKind, companyId: string, key: string): Promise<T | null> { return structuredClone(this.rows.get(this.key(kind, companyId, key))?.value ?? null) as T | null; }
  async put<T>(kind: RecordKind, companyId: string, key: string, value: T, onlyIfAbsent = false): Promise<boolean> {
    const id = this.key(kind, companyId, key); const old = this.rows.get(id);
    if (old && onlyIfAbsent) return false;
    this.rows.set(id, { value: structuredClone(value), order: old?.order ?? ++this.nextOrder }); return true;
  }
  async list<T>(kind: RecordKind, companyId: string, options: ListOptions = {}): Promise<T[]> {
    return [...this.rows.entries()].filter(([id, row]) => {
      const [company, type] = JSON.parse(id) as string[];
      return company === companyId && type === kind && Object.entries(options.where ?? {}).every(([key, value]) => (row.value as Record<string, unknown>)[key] === value);
    }).sort((a, b) => b[1].order - a[1].order).slice(0, options.limit).map(([, row]) => structuredClone(row.value) as T);
  }
  async remove(kind: RecordKind, companyId: string, key?: string): Promise<void> {
    if (key !== undefined) { this.rows.delete(this.key(kind, companyId, key)); return; }
    for (const id of this.rows.keys()) { const [company, type] = JSON.parse(id) as string[]; if (company === companyId && type === kind) this.rows.delete(id); }
  }
}
