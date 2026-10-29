export interface Env {
  API_KEYS?: string;
  RATE_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> };
}

type KeyEntry = { name: string; digest: Uint8Array };
const cache = new Map<string, KeyEntry[]>();
function keysOf(secret: string): KeyEntry[] {
  let entries = cache.get(secret);
  if (entries) return entries;
  entries = secret.split(/[\n,]/).flatMap(line => {
    const match = /^([a-z0-9-]{1,32}):([a-f0-9]{64})$/.exec(line.trim());
    return match ? [{ name: match[1]!, digest: Uint8Array.from(match[2]!.match(/../g)!, byte => parseInt(byte, 16)) }] : [];
  });
  cache.set(secret, entries);
  return entries;
}

export type KeyCheck = { code: 'NOT_CONFIGURED' | 'API_KEY_REQUIRED' | 'API_KEY_INVALID' } | { name: string };
/** Never expose the presented key; every configured digest gets the same byte comparison. */
export async function checkKey(request: Request, secret: string | undefined): Promise<KeyCheck> {
  const entries = secret ? keysOf(secret) : [];
  if (!entries.length) return { code: 'NOT_CONFIGURED' };
  const header = request.headers.get('Authorization') ?? '';
  const bearer = /^Bearer(?:[ \t]+(.*))?$/i.exec(header);
  if (!bearer) return { code: 'API_KEY_REQUIRED' };
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bearer[1] ?? '')));
  let name: string | undefined;
  for (const entry of entries) {
    let difference = 0;
    for (let i = 0; i < digest.length; i++) difference |= digest[i]! ^ entry.digest[i]!;
    if (difference === 0) name = entry.name;
  }
  return name === undefined ? { code: 'API_KEY_INVALID' } : { name };
}
