import httpx
from collections import OrderedDict

_client = httpx.AsyncClient(timeout=6)
_cache  = OrderedDict()
MAX_CACHE = 10_000

async def fetch_route(a, b):
    key = f"{a.lat},{a.lng},{b.lat},{b.lng}"

    # Cache hit
    if key in _cache:
        _cache.move_to_end(key)
        return _cache[key]

    # Cache miss — fetch
    url = f"https://router.project-osrm.org/route/v1/driving/{a.lng},{a.lat};{b.lng},{b.lat}?overview=full&geometries=geojson"
    try:
        response = await _client.get(url)
        data     = response.json()
        if data["code"] == "Ok":
            result = [[lat, lng] for lng, lat in data["routes"][0]["geometry"]["coordinates"]]
        else:
            result = [[a.lat, a.lng], [b.lat, b.lng]]  # fallback straight line
    except Exception:
        result = [[a.lat, a.lng], [b.lat, b.lng]]       # fallback on timeout/error

    # Store then return
    if len(_cache) >= MAX_CACHE:
        _cache.popitem(last=False)  # evict LRU
    _cache[key] = result
    return result