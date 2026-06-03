from fastapi import APIRouter, Depends
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

class RouteRequest(BaseModel):
    a: Point
    b: Point


router = APIRouter()

@router.post("/route")
async def get_route(request: RouteRequest):
    result = await fetch_route(request.a, request.b)
    return result


FIXTURES_DIR = os.path.join(os.path.dirname(__file__), '..', 'fixtures')

@router.get('/devices')
def get_devices():
    with open(os.path.join(FIXTURES_DIR, 'devices.json')) as f:
        return json.load(f)

@router.get('/links')
def get_links():
    with open(os.path.join(FIXTURES_DIR, 'links.json')) as f:
        return json.load(f)
    
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
      db.add(Route(
        id=request.link_id,
        from_id=request.link_id.split('-')[0],
        to_id=request.link_id.split('-')[1],
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
