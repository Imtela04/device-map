import httpx

_cache = {}

async def fetch_route(a, b):
	key = f"{a.lat},{a.lng},{b.lat},{b.lng}"
	
	if key not in _cache:
		url = f"https://router.project-osrm.org/route/v1/driving/{a.lng},{a.lat};{b.lng},{b.lat}?overview=full&geometries=geojson"
		try:     
			async with httpx.AsyncClient() as client:
				response = await client.get(url, timeout=6)
				data     = response.json()
				if data['code'] == 'Ok':
					result = [[lat, lng] for lng, lat in data["routes"][0]["geometry"]["coordinates"]]
					_cache[key] = result
					return _cache[key]
				else:
					return [[a.lat, a.lng], [b.lat, b.lng]]
		except Exception:
				return [[a.lat, a.lng], [b.lat, b.lng]]
	return _cache[key]
	
			
