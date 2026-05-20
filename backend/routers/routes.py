from fastapi import APIRouter
from pydantic import BaseModel
from utils.osrm import fetch_route

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