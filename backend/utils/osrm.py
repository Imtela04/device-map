import httpx

async def fetch_route(a, b):
    url = f"https://router.project-osrm.org/route/v1/driving/{a['lng']},{a['lat']};{b['lng']},{b['lat']}?overview=full&geometries=geojson"
    try:     
        async with httpx.AsyncClient() as client:
            response = await client.get(url, timeout=6)
            data     = response.json()
            if data['code'] == 'Ok':
                return [[lat, lng] for lng, lat in data["routes"][0]["geometry"]["coordinates"]]
            return [[a['lat'], a['lng']], [b['lat'], b['lng']]]
    except Exception:
        return [[a['lat'], a['lng']], [b['lat'], b['lng']]]
