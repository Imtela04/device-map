from fastapi.testclient import TestClient
from main import app
from unittest.mock import patch, AsyncMock
from utils.osrm import _cache

client = TestClient(app)

# helper
def assert_valid_route(a,b):
    response = client.post('/api/route', json={
        'a': a,
        'b': b
    })

    assert response.status_code == 200
    coords = response.json()
    assert len(coords)>0

    min_lat = min(a["lat"], b["lat"]) - 1.0
    max_lat = max(a["lat"], b["lat"]) + 1.0
    min_lng = min(a["lng"], b["lng"]) - 1.0
    max_lng = max(a["lng"], b["lng"]) + 1.0

    for coord in coords:
        assert min_lat <= coord[0] <= max_lat
        assert min_lng <= coord[1] <= max_lng


# tests
def test_dhaka_city():
    assert_valid_route({"lat": 23.7269, "lng": 90.4193},{"lat": 23.7808, "lng": 90.4147})

def test_dhaka_to_chittagong():
    assert_valid_route({"lat": 23.7269, "lng": 90.4193}, {"lat": 22.3338, "lng": 91.8344})

def test_international():
    assert_valid_route({"lat": 40.7419, "lng": -73.9893}, {"lat": 38.8951, "lng": -77.0364})


def test_cache_hits_osrm_once():
    _cache.clear()  # start fresh
    with patch("utils.osrm.httpx.AsyncClient") as mock_client:
        mock_response = AsyncMock()
        mock_response.json = lambda: {
            "code": "Ok",
            "routes": [{
                "geometry": {
                    "coordinates": [
                        [-73.9893, 40.7419],
                        [-77.0364, 38.8951]
                    ]
                }
            }]
        }
        mock_client.return_value.__aenter__.return_value.get = AsyncMock(return_value=mock_response)
        
        a = {"lat": 40.7419, "lng": -73.9893}
        b = {"lat": 38.8951, "lng": -77.0364}
        
        client.post("/api/route", json={"a": a, "b": b})
        print(_cache)
        client.post("/api/route", json={"a": a, "b": b})
        
        assert mock_client.return_value.__aenter__.return_value.get.call_count == 1