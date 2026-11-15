// Pure helpers of the consent page (tested without a browser).

/** Digits only, at most 6, as the user types the code Still shows. */
export function normalizeCodeInput(raw: string): string {
  return raw.replace(/\D+/g, '').slice(0, 6);
}

export async function codeMatches(requestId: string, code: string, codeHash: string): Promise<boolean> {
  if (!/^\d{6}$/.test(code) || !codeHash) return false;
  const bytes = new TextEncoder().encode(`${requestId}:${code}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex === codeHash;
}

/** "in 7 minutes" / "in less than a minute". */
export function expiresInLabel(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes <= 0) return 'in less than a minute';
  return minutes === 1 ? 'in 1 minute' : `in ${minutes} minutes`;
}

/** Group a 32-character id for reading aloud and comparing: abcd efgh … */
export function groupedId(id: string): string {
  return id.replace(/(.{4})/g, '$1 ').trim();
}
