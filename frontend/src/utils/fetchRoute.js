const inFlight = new Map();
const MAX_RESOLVED = 500;
const resolved = new Map();
function cacheSet(key, value) {
  if (resolved.size >= MAX_RESOLVED) {
    resolved.delete(resolved.keys().next().value); // evict LRU (insertion order)
  }
  cacheSet(key, data);

}

export async function fetchRoute(a, b, extra = {}) {
  const key = `${a.lat},${a.lng},${b.lat},${b.lng}`;
  const isPersist = Boolean(extra.link_id);

  // Bypass cache for persist calls so dragend always hits the backend
  if (!isPersist) {
    if (resolved.has(key)) return resolved.get(key);
    if (inFlight.has(key)) return inFlight.get(key);
  }

  const promise = (async () => {
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch('http://localhost:8000/api/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ a, b, ...extra }),
        signal: ctrl.signal,
      });
      const data = await res.json();
      resolved.set(key, data); // always refresh cache with the latest result
      return data;
    } catch {
      return [[a.lat, a.lng], [b.lat, b.lng]];
    } finally {
      if (!isPersist) inFlight.delete(key);
    }
  })();

  if (!isPersist) inFlight.set(key, promise);
  return promise;
}