// Dexie v3 records of the Sidebar Dock (Still) link. Types only, so db.ts can import them freely.

/** One coalescing outbox row per thread: what the service worker still has to tell Still. */
export interface DockOutboxRecord {
  threadKey: string;
  /** 'upsert' = re-evaluate and push if needed; 'remove' = tell Still the thread left. */
  op: 'upsert' | 'remove';
  /** Removal reason; a `local_only` or `deleted` remove is never downgraded to an upsert. */
  reason?: 'deleted' | 'local_only' | 'out_of_scope';
  /** Sent with origin 'manual' (Send to Still); kept until delivered. */
  manual?: boolean;
  /** Collection choice of a manual send. */
  target?: { collectionId?: string; collectionName?: string } | null;
  /** Still answered needsTranscript, or the next push must carry the transcript. */
  wantTranscript?: boolean;
  /** Still answered too_large with the transcript: the next push goes without it. */
  noTranscript?: boolean;
  /** Earliest ISO time this row may be sent (debounce and backoff). */
  notBefore: string;
  attempts: number;
  lastError: string;
  /** Lease expiry while a drain holds the row. */
  leaseUntil: string;
  /** Bumped by every markDockDirty; an ack deletes the row only when it is unchanged. */
  dirtySeq: number;
  updatedAt: string;
}

/** What Still acknowledged for a thread (per peer and epoch). */
export interface DockSentRecord {
  threadKey: string;
  peerId: string;
  epoch: string;
  fingerprint: string;
  seq: number;
  /** Revision of the transcript Still holds; -1 when it holds none. */
  transcriptRevision: number;
  /** Hash of the transcript-sharing settings in force when this was sent. */
  prefsHash: string;
  /** Cheap digest of the conversation row (and AI insight time) when this was sent. */
  cheapDigest: string;
  itemId: string;
  sentAt: string;
  /**
   * Set after a `deleted` / `out_of_scope` removal Still answered without dropping the chat's data
   * (kept, or moved to Trash): Still may still hold the thread, so a later privacy change must
   * still send `local_only`, but the removal itself is not repeated and nothing is treated as synced.
   */
  held?: 'deleted' | 'out_of_scope';
}

/** Threads Still asked for explicitly (threads.get track, Send to Still); kept in sync under every scope. */
export interface DockTrackedRecord {
  threadKey: string;
  trackedAt: string;
  /** Still answered skipped/dismissed: not pushed again until a manual send. */
  dismissed: boolean;
}

/** Small persisted counters and cursors (seq, reconcile cursor, timestamps). */
export interface DockMetaRecord {
  key: string;
  value: unknown;
}
