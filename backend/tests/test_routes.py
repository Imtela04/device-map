from fastapi.testclient import TestClient
from main import app

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