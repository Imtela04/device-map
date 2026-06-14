# Device Maps

A network topology dashboard for visualising and managing network devices and links on an interactive map. Built for NOC engineers to monitor infrastructure in real time.

---

## What It Does

Device Maps renders network devices as draggable markers on a MapLibre map, connected by road-routed links. At low zoom, devices render as clustered WebGL points for performance. At high zoom (≥ 12), they switch to draggable DOM markers with Lucide icons. Dragging a device re-routes its connected links via OSRM. The FastAPI backend handles routing requests, caches results, persists dragged routes to SQLite, and serves a JWT-authenticated API. The map exposes a live `stats` object (viewport device counts by status) and a `refreshMarkers()` handle for the parent dashboard to trigger re-renders after external data changes.

---

## Architecture

```
Browser (React + Tailwind + MapLibre)
        ↕  HTTP/JSON
FastAPI (Python)
        ↕
SQLite (routes + user auth)
        ↕
Route Cache (in-memory OrderedDict, LRU, max 10,000)
        ↕
OSRM (road routing — Docker container on :5000)
```

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Frontend | React + Vite | Component model keeps map logic and UI separate |
| Map | MapLibre GL JS | Vector tiles, WebGL rendering, free/open source |
| Static routes | PMTiles | Single-file vector tile archive served statically |
| Styling | Tailwind CSS | Utility-first, no separate CSS files |
| Backend | FastAPI | Async-native, auto docs, Pydantic validation |
| Routing | OSRM | Free, self-hostable road routing engine |
| Auth | JWT + bcrypt | Stateless tokens, industry standard |
| Database | SQLite + SQLAlchemy | Zero-config for development |
| Testing (backend) | pytest + TestClient | Fast, no live server needed |
| Testing (frontend) | Playwright | Real browser automation and performance measurement |

---

## Project Structure

```
device-maps/
├── start.ps1                     # One-command startup (Windows)
│
├── frontend/
│   ├── public/
│   │   └── dummy-network.pmtiles # Pre-built static route tiles
│   ├── src/
│   │   ├── components/
│   │   │   ├── NetworkMap.jsx    # Map init, markers, links, zoom switching
│   │   │   ├── Legend.jsx        # Link type legend overlay
│   │   │   └── DeviceIcon.jsx    # Per-device-type Lucide icon (high zoom)
│   │   ├── data/
│   │   │   └── networkData.js    # DEVICES, LINKS, DEVICE_COLORS (small dataset)
│   │   └── utils/
│   │       ├── fetchRoute.js     # Calls backend /api/route
│   │       ├── toGeoJSON.js      # Converts coord arrays to GeoJSON
│   │       ├── createMarker.jsx  # Creates custom DOM markers (high zoom)
│   │       └── iconSprite.js     # Registers WebGL icon sprites with MapLibre
│   ├── tests/
│   │   └── performance.spec.js  # Playwright performance tests
│   └── playwright.config.js
│
└── backend/
    ├── main.py                   # App entry point, CORS, router registration
    ├── database.py               # SQLAlchemy engine, session, Route model
    ├── osrm-data/                # OSRM pre-processed binary files (.osrm)
    │   └── bangladesh-latest.osrm (+ associated files)
    ├── fixtures/
    │   ├── devices.json          # 60,000 generated network devices
    │   ├── links.json            # Spatially-clustered links
    │   └── generate-geojson.js  # Builds dummy-routes.geojson via local OSRM
    ├── routers/
    │   └── routes.py             # /api/route, /api/devices, /api/links, /api/routes/geojson
    ├── auth/
    │   ├── router.py             # POST /auth/signup, POST /auth/login
    │   ├── models.py             # User SQLAlchemy model
    │   ├── schemas.py            # Pydantic request/response shapes
    │   └── utils.py              # JWT creation/verification, password hashing
    ├── utils/
    │   └── osrm.py               # OSRM fetch with in-memory LRU caching
    ├── scripts/
    │   ├── seed_db.py            # Database seeding
    │   ├── generate_fixtures.py  # Generates devices.json + links.json
    │   └── export_pmtiles.py     # Exports routes GeoJSON → PMTiles via 
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- Python 3.10+
- Docker Desktop
- A free [MapTiler](https://maptiler.com) API key

### OSRM Data (first time only)

Download Bangladesh OSM data then pre-process from the `backend/osrm-data/` directory:

```bash
cd backend/osrm-data

docker run -t -i -v "$(pwd):/data" osrm/osrm-backend osrm-extract -p /opt/car.lua /data/bangladesh-latest.osm.pbf
docker run -t -i -v "$(pwd):/data" osrm/osrm-backend osrm-partition /data/bangladesh-latest.osrm
docker run -t -i -v "$(pwd):/data" osrm/osrm-backend osrm-customize /data/bangladesh-latest.osrm
```

All `.osrm` output files stay in `backend/osrm-data/`.

### Running — Windows (one command)

```powershell
.\start.ps1
```

Add `-SkipDocker` if the OSRM container is already running:

```powershell
.\start.ps1 -SkipDocker
```

Each service opens in its own PowerShell window. Close all three to shut everything down.

### Running — Manual (any OS)

```bash
# Terminal 1 — OSRM
docker run -t -i -p 5000:5000 \
  -v "./backend/osrm-data:/data" \
  osrm/osrm-backend \
  osrm-routed --algorithm mld /data/bangladesh-latest.osrm

# Terminal 2 — Backend
cd backend
source venv/bin/activate        # Mac/Linux
# .\venv\Scripts\activate       # Windows
uvicorn main:app --reload

# Terminal 3 — Frontend
cd frontend
npm run dev
```

Open `http://localhost:5173`

---

## Service Map

| Service  | Technology        | Port | Notes                             |
|----------|-------------------|------|-----------------------------------|
| OSRM     | Docker            | 5000 | Must be running before backend    |
| Backend  | FastAPI + uvicorn | 8000 | Proxies OSRM, serves fixtures     |
| Frontend | Vite dev server   | 5173 | Hot-reloads on file changes       |

OSRM does not persist state — it reads the pre-processed `.osrm` binary files on every startup. It **must be running** before the backend serves any route requests.

---

## API Endpoints

### Routing

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/route` | Get road route between two coordinate pairs |
| GET | `/api/devices` | All devices from fixtures |
| GET | `/api/links` | All links from fixtures |
| GET | `/api/routes/geojson` | All persisted dragged routes as GeoJSON FeatureCollection |

**POST `/api/route` request body:**
```json
{
  "a": { "lat": 23.7269, "lng": 90.4193 },
  "b": { "lat": 23.7808, "lng": 90.4147 },
  "link_id": "core-1-dist-1",
  "link_type": "fiber"
}
```

`link_id` and `link_type` are optional. When provided, the resulting route is persisted to SQLite and returned by `/api/routes/geojson` on next load.

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

Routes are cached in-memory with an LRU eviction policy (max 10,000 entries):

```
"{a.lat},{a.lng},{b.lat},{b.lng}" → [[lat, lng], ...]
```

The same route requested twice only calls OSRM once. For production, swap the `OrderedDict` for Redis.

---

## Running Tests

### Backend

```bash
cd backend
pytest tests/test_routes.py -v
```

| Test | What it verifies |
|---|---|
| `test_dhaka_city` | Local route returns valid coords within bounding box |
| `test_dhaka_to_chittagong` | Long-distance BD route works correctly |
| `test_international` | Routing works for any coordinates worldwide |
| `test_cache_hits_osrm_once` | OSRM called once for two identical requests |

### Frontend Performance

```bash
cd frontend
npx playwright test --headed
```

Requires both the Vite dev server and FastAPI backend to be running.

| Test | Threshold | Actual |
|---|---|---|
| 100 devices (WebGL) | < 100ms | ~26ms |
| 1,000 devices (WebGL) | < 200ms | ~18ms |
| 10,000 devices (WebGL) | < 500ms | ~85ms |
| 50,000 DOM markers | < 5000ms | measured |
| 60,000 devices load | < 5000ms | measured |
| 60,000 devices render | < 500ms | measured |

---

## Device Types

| Type | Icon | Colour |
|---|---|---|
| Core Router | Network | Red `#ef4444` |
| Router | Router | Magenta `#f63bbe` |
| Switch | GitFork | Amber `#f59e0b` |
| Edge Router | Radio | Purple `#8b5cf6` |
| Server | Server | Green `#22c55e` |

---

## Zoom Behaviour

| Zoom | Rendering | Interaction |
|---|---|---|
| < 12 | WebGL clustered circles (GeoJSON layer) | Click to expand cluster |
| ≥ 12 | DOM markers with Lucide icons | Draggable, click tooltip |

> `moveend` at zoom ≥ 12 is debounced at 150ms. Panning rapidly fires multiple `moveend` events; only the final one triggers a marker re-render.

Switching zoom levels syncs device positions — dragging a marker at high zoom updates the low-zoom circle position when zoomed back out.

---

## Static vs Live Routes

| Layer | Source | Purpose |
|---|---|---|
| `links-*` | PMTiles (`dummy-network.pmtiles`) | 60,000 pre-routed links, rendered via vector tiles |
| `live-*` | GeoJSON (`live-routes` source) | Dragged routes + routes persisted in SQLite |

When a device is dragged, its affected link IDs are added to `modifiedRouteIdsRef`. The PMTiles layer filters those IDs out, and the live GeoJSON layer takes over, ensuring no visual duplication.
