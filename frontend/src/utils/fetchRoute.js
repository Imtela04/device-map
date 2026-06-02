const inFlight = new Map();
const resolved = new Map(); // ← persists for session lifetime

export async function fetchRoute(a, b) {
  const key = `${a.lat},${a.lng},${b.lat},${b.lng}`;
  
  if (resolved.has(key)) return resolved.get(key);  // instant
  if (inFlight.has(key)) return inFlight.get(key);  // dedupe concurrent

  const promise = (async () => {
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch('http://localhost:8000/api/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ a, b }),
        signal: ctrl.signal,
      });
      const data = await res.json();
      resolved.set(key, data);   // ← cache the result
      return data;
    } catch {
      return [[a.lat, a.lng], [b.lat, b.lng]];
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}