export async function fetchRoute(a, b) {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 6000);
    const url = `http://localhost:8000/api/route`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a, b }),
      signal: ctrl.signal
    })
    const data = await res.json();
    return data
  } catch {}
  return [[a.lat, a.lng], [b.lat, b.lng]]; // fallback
}