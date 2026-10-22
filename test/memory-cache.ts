function headerPairs(h: Headers): [string, string][] {
  const out: [string, string][] = [];
  h.forEach((v, k) => out.push([k, v]));
  return out;
}

/** Minimal in-memory stand-in for the Workers Cache API (match/put/delete by URL). */
export class MemoryCache {
  store = new Map<string, { body: string; headers: [string, string][]; status: number }>();

  private key(req: RequestInfo | URL): string {
    return typeof req === "string" ? req : req instanceof URL ? req.toString() : req.url;
  }

  async match(req: RequestInfo | URL): Promise<Response | undefined> {
    const hit = this.store.get(this.key(req));
    return hit ? new Response(hit.body, { status: hit.status, headers: hit.headers }) : undefined;
  }

  async put(req: RequestInfo | URL, res: Response): Promise<void> {
    this.store.set(this.key(req), { body: await res.text(), headers: headerPairs(res.headers), status: res.status });
  }

  async delete(req: RequestInfo | URL): Promise<boolean> {
    return this.store.delete(this.key(req));
  }
}

export function installMemoryCaches(): MemoryCache {
  const cache = new MemoryCache();
  (globalThis as unknown as { caches: unknown }).caches = { default: cache };
  return cache;
}
