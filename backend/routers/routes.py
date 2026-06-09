from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from utils.osrm import fetch_route
import json
import os
from database import SessionLocal, Route
from datetime import datetime, timezone
from sqlalchemy.orm import Session

class Point(BaseModel):
    lat: float
    lng: float

router = APIRouter()

FIXTURES_DIR = os.path.join(os.path.dirname(__file__), '..', 'fixtures')

@router.get('/devices')
def get_devices():
    with open(os.path.join(FIXTURES_DIR, 'devices.json')) as f:
        return json.load(f)

@router.get('/links')
def get_links():
    with open(os.path.join(FIXTURES_DIR, 'links.json')) as f:
        return json.load(f)

# --- NEW ENDPOINT: Handle dragging and saving device locations ---
@router.patch('/devices/{device_id}')
def update_device(device_id: str, request: Point):
    devices_path = os.path.join(FIXTURES_DIR, 'devices.json')
    
    # 1. Read the current devices
    with open(devices_path, 'r') as f:
        devices = json.load(f)
        
    # 2. Find the device and update its coordinates
    device_found = False
    for dev in devices:
        # Convert both to strings to avoid int vs string mismatches ("70" == "70")
        if str(dev.get('id')) == str(device_id):
            dev['lat'] = request.lat
            dev['lng'] = request.lng
            device_found = True
            break
            
    if not device_found:
        raise HTTPException(status_code=404, detail=f"Device {device_id} not found")
        
    # 3. Write the changes back to the JSON file
    with open(devices_path, 'w') as f:
        json.dump(devices, f, indent=2)
        
    return {"message": "success", "device_id": device_id}
# -----------------------------------------------------------------

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

class RouteRequest(BaseModel):
    a: Point
    b: Point
    link_id: str | None = None
    link_type: str | None = None

@router.post("/route")
async def get_route(request: RouteRequest, db: Session = Depends(get_db)):
    result = await fetch_route(request.a, request.b)

    if request.link_id:
        existing = db.query(Route).filter(Route.id == request.link_id).first()
        if existing:
            existing.coords = result
            existing.updated_at = datetime.now(timezone.utc)
        else:
            # Defensive coding: Safely handle the hyphen split so Python never crashes
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