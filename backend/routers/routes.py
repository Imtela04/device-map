from fastapi import APIRouter
from pydantic import BaseModel
from utils.osrm import fetch_route
import json
import os

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