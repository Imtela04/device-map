# device-map# Device Maps

A network topology dashboard for visualising and managing network devices and links on an interactive map. Built for NOC engineers to monitor infrastructure in real time.

---

## What It Does

Device Maps renders network devices as draggable markers on a MapLibre map, connected by road-routed links. Dragging a device re-routes its connected links via OSRM. The FastAPI backend handles routing requests, caches results, and serves a JWT-authenticated API.

---

## Architecture

```
Browser (React + Tailwind + MapLibre)
        ↕  HTTP/JSON
FastAPI (Python)
        ↕
Route Cache (in-memory dict)
        ↕
OSRM (external road routing API)
        ↕
SQLite (user auth)
```

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Frontend | React + Vite | Component model keeps map logic and UI separate |
| Map | MapLibre GL JS | Vector tiles, WebGL rendering, free/open source |
| Styling | Tailwind CSS | Utility-first, no separate CSS files |
| Backend | FastAPI | Async-native, auto docs, Pydantic validation |
| Routing | OSRM | Free, self-hostable road routing engine |
| Auth | JWT + bcrypt | Stateless tokens, industry standard |
| Database | SQLite + SQLAlchemy | Zero-config for development |
| Testing | pytest + TestClient | Fast, no live server needed |

---

## Project Structure

```
device-maps/
├── network-map/                  # React frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── NetworkMap.jsx    # Map initialisation, markers, links
│   │   │   ├── Legend.jsx        # Link type legend overlay
│   │   │   └── DeviceIcon.jsx    # Per-device-type icon component
│   │   ├── data/
│   │   │   └── networkData.js    # DEVICES and LINKS static data
│   │   └── utils/
│   │       ├── fetchRoute.js     # Calls backend /api/route
│   │       ├── toGeoJSON.js      # Converts coord arrays to GeoJSON
│   │       └── createMarker.js   # Creates custom MapLibre markers
│   └── index.css
│
└── backend/                      # FastAPI backend
    ├── main.py                   # App entry point, CORS, router registration
    ├── database.py               # SQLAlchemy engine and session
    ├── routers/
    │   └── routes.py             # POST /api/route endpoint
    ├── auth/
    │   ├── router.py             # POST /auth/signup, POST /auth/login
    │   ├── models.py             # User SQLAlchemy model
    │   ├── schemas.py            # Pydantic request/response shapes
    │   └── utils.py              # JWT creation/verification, password hashing
    ├── utils/
    │   └── osrm.py               # OSRM fetch with in-memory caching
    └── tests/
        └── test_routes.py        # Route sanity and cache tests
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- Python 3.10+
- A free [MapTiler](https://maptiler.com) API key

### Frontend

```bash
cd network-map
npm install
npm run dev
```

Open `http://localhost:5173`

### Backend

```bash
cd backend
python -m venv venv
venv\Scripts\activate        # Windows
source venv/bin/activate     # Mac/Linux

pip install fastapi uvicorn httpx sqlalchemy passlib[bcrypt] python-jose[cryptography] pytest pytest-asyncio

uvicorn main:app --reload
```

API runs at `http://localhost:8000`  
Auto docs at `http://localhost:8000/docs`

---

## API Endpoints

### Routing

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/route` | Get road route between two coordinate pairs |

**Request body:**
```json
{
  "a": { "lat": 23.7269, "lng": 90.4193 },
  "b": { "lat": 23.7808, "lng": 90.4147 }
}
```

**Response:** Array of `[lat, lng]` coordinate pairs tracing the road route.

### Auth

| Method | Endpoint | Description |
|---|---|---|
| POST | `/auth/signup` | Register a new user |
| POST | `/auth/login` | Login and receive a JWT token |

**Signup/Login body:**
```json
{
  "email": "engineer@example.com",
  "password": "yourpassword"
}
```

**Login response:**
```json
{
  "token": "eyJ...",
  "token_type": "bearer"
}
```

---

## Caching

Routes are cached in-memory by coordinate key:

```
"{a.lat},{a.lng},{b.lat},{b.lng}" → [[lat, lng], ...]
```

The same route requested twice only calls OSRM once. Cache persists for the lifetime of the server process. For production, swap the dict for Redis.

---

## Running Tests

```bash
cd backend
pytest tests/test_routes.py -v
```

### Test coverage

| Test | What it verifies |
|---|---|
| `test_dhaka_city` | Local route returns valid coords within bounding box |
| `test_dhaka_to_chittagong` | Long-distance BD route works correctly |
| `test_international` | Routing works for any coordinates worldwide |
| `test_cache_hits_osrm_once` | OSRM called once for two identical requests |

---

## Device Types

| Type | Colour |
|---|---|
| Core Router | Red `#ef4444` |
| Router | Blue `#3b82f6` |
| Switch | Amber `#f59e0b` |
| Edge Router | Purple `#8b5cf6` |
| Server | Green `#22c55e` |

---