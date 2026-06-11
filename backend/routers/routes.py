from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from utils.osrm import fetch_route
import json
import os
from database import SessionLocal, Route
from datetime import datetime, timezone
from sqlalchemy.orm import Session

INFRA_TYPES = {'core-router', 'edge-router', 'olt', 'server', 'switch', 'router'}

# --- OSRM ROUTE GENERATOR ---
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class Point(BaseModel):
    lat: float
    lng: float
    
class RouteRequest(BaseModel):
    a: Point
    b: Point
    link_id: str | None = None
    link_type: str | None = None

router = APIRouter()

FIXTURES_DIR = os.path.join(os.path.dirname(__file__), '..', 'fixtures')

_devices_cache = None
_links_cache = None

def _load_devices():
    global _devices_cache
    if _devices_cache is None:
        with open(os.path.join(FIXTURES_DIR, 'devices.json')) as f:
            _devices_cache = json.load(f)
    return _devices_cache

def _load_links():
    global _links_cache
    if _links_cache is None:
        with open(os.path.join(FIXTURES_DIR, 'links.json')) as f:
            _links_cache = json.load(f)
    return _links_cache

# --- TIER MAPPING FOR PROGRESSIVE LOADING ---
TIER_MAPPING = {
    'core': {'core-router', 'edge-router'},
    'olt': {'core-router', 'edge-router', 'olt', 'server', 'switch', 'router'},
    'access': {'core-router', 'edge-router', 'olt', 'server', 'switch', 'router', 'customer-router'}
}

# Keep simple global gets for debugging purposes
@router.get('/devices')
def get_devices():
    return _load_devices()

@router.get('/links')
def get_links():
    return _load_links()

# --- VIEWPORT ENDPOINTS ---

@router.get('/devices/viewport')
def get_devices_viewport(west: float, south: float, east: float, north: float, tier: str = 'access'):
    allowed_types = TIER_MAPPING.get(tier, TIER_MAPPING['access'])
    
    return [
        d for d in _load_devices()
        if d.get('type') in allowed_types
        and west <= d.get('lng', 0) <= east
        and south <= d.get('lat', 0) <= north
    ]

@router.get('/links/viewport')
def get_links_viewport(west: float, south: float, east: float, north: float, tier: str = 'access'):
    allowed_types = TIER_MAPPING.get(tier, TIER_MAPPING['access'])
    
    # 1. Map all allowed devices globally (even outside viewport) 
    # to ensure we don't draw links connecting to hidden tiers
    dev_map = {str(d['id']): d for d in _load_devices() if d.get('type') in allowed_types}
    
    result = []
    for l in _load_links():
        from_id, to_id = str(l['from']), str(l['to'])
        
        # 2. Both ends of the link must be visible in the current tier
        d_from = dev_map.get(from_id)
        d_to = dev_map.get(to_id)
        
        if not d_from or not d_to:
            continue
            
        # 3. Include link if AT LEAST ONE connected device is inside the viewport bounding box
        from_in_box = (west <= d_from.get('lng', 0) <= east and south <= d_from.get('lat', 0) <= north)
        to_in_box = (west <= d_to.get('lng', 0) <= east and south <= d_to.get('lat', 0) <= north)
        
        if from_in_box or to_in_box:
            result.append(l)
            
    return result

@router.get("/routes/viewport")
def get_routes_viewport(west: float, south: float, east: float, north: float, tier: str = 'access', db: Session = Depends(get_db)):
    allowed_types = TIER_MAPPING.get(tier, TIER_MAPPING['access'])
    dev_map = {str(d['id']): d for d in _load_devices() if d.get('type') in allowed_types}
    
    routes = db.query(Route).all()
    features = []
    
    for r in routes:
        # Check if the route endpoints match the currently active tier
        d_from = dev_map.get(str(r.from_id))
        d_to = dev_map.get(str(r.to_id))
        
        if not d_from or not d_to:
            continue
            
        # Check if the route enters the viewport
        from_in_box = (west <= d_from.get('lng', 0) <= east and south <= d_from.get('lat', 0) <= north)
        to_in_box = (west <= d_to.get('lng', 0) <= east and south <= d_to.get('lat', 0) <= north)
        
        if from_in_box or to_in_box:
            features.append({
                "type": "Feature",
                "properties": {
                    "id": r.id,
                    "from": r.from_id,
                    "to": r.to_id,
                    "type": r.link_type
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[lng, lat] for lat, lng in r.coords] # GeoJSON format
                }
            })
            
    return {
        "type": "FeatureCollection",
        "features": features
    }

# --- DEVICE DRAG & DROP ENDPOINT ---

@router.get('/devices/infra')
def get_infra_devices():
    """All non-customer infrastructure nodes (core, edge, OLT …).
    Always loaded eagerly on map init so the backbone is visible at any zoom.
    """
    return [d for d in _load_devices() if d.get('type') in INFRA_TYPES]


@router.get('/links/infra')
def get_infra_links():
    """All inter-infra links (both endpoints are infra nodes).
    Customer→OLT access links are excluded; they are fetched on-demand
    by the viewport system when the user zooms to district level.
    """
    dev_map = {str(d['id']) for d in _load_devices() if d.get('type') in INFRA_TYPES}
    return [
        l for l in _load_links()
        if str(l['from']) in dev_map and str(l['to']) in dev_map
    ]

@router.patch('/devices/{device_id}')
def update_device(device_id: str, request: Point):
    devices_path = os.path.join(FIXTURES_DIR, 'devices.json')
    
    with open(devices_path, 'r') as f:
        devices = json.load(f)
        
    device_found = False
    for dev in devices:
        if str(dev.get('id')) == str(device_id):
            dev['lat'] = request.lat
            dev['lng'] = request.lng
            device_found = True
            break
            
    if not device_found:
        raise HTTPException(status_code=404, detail=f"Device {device_id} not found")
        
    with open(devices_path, 'w') as f:
        json.dump(devices, f, indent=2)
        
    global _devices_cache
    _devices_cache = None
        
    return {"message": "success", "device_id": device_id}


@router.post("/route")
async def get_route(request: RouteRequest, db: Session = Depends(get_db)):
    result = await fetch_route(request.a, request.b)

    if request.link_id:
        existing = db.query(Route).filter(Route.id == request.link_id).first()
        if existing:
            existing.coords = result
            existing.updated_at = datetime.now(timezone.utc)
        else:
            from_id = request.link_id.split('-')[0] if '-' in request.link_id else request.link_id
            to_id = request.link_id.split('-')[1] if '-' in request.link_id else "unknown"

            db.add(Route(
                id=request.link_id,
                from_id=from_id,
                to_id=to_id,
                link_type=request.link_type or 'fiber',
                coords=result
            ))
        db.commit()

    return result

# Left for debugging or legacy needs, but frontend will mostly use /routes/viewport now
@router.get("/routes/geojson")
def get_routes_geojson(db: Session = Depends(get_db)):
    routes = db.query(Route).all()
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "id": r.id,
                    "from": r.from_id,
                    "to": r.to_id,
                    "type": r.link_type
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[lng, lat] for lat, lng in r.coords]
                }
            }
            for r in routes
        ]
    }