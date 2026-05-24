// utils/fetchRoute.js — replace entire file
const inFlight = new Map();

export async function fetchRoute(a, b) {
  const key = `${a.lat},${a.lng},${b.lat},${b.lng}`;
  if (inFlight.has(key)) return inFlight.get(key);

  const promise = (async () => {
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch('http://localhost:8000/api/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ a, b }),
        signal: ctrl.signal
      });
      return await res.json();
    } catch {
      return [[a.lat, a.lng], [b.lat, b.lng]];
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}