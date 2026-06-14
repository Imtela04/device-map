# Device Maps — Technical Documentation

## Table of Contents

1. [Overview](#overview)
2. [Local Development](#local-development)
3. [Device Types](#device-types)
4. [Frontend](#frontend)
5. [Backend](#backend)
6. [Environment Variables](#environment-variables)
7. [Authentication](#authentication)
8. [Routing & Caching](#routing--caching)
9. [Static vs Live Routes](#static-vs-live-routes)
10. [Scripts & Data Pipeline](#scripts--data-pipeline)
11. [Testing](#testing)
12. [Data Structures](#data-structures)
13. [Key Design Decisions](#key-design-decisions)

---

## Overview

Device Maps is a network topology visualisation dashboard. It renders network infrastructure (routers, switches, servers) as markers on a MapLibre map, connected by road-routed links. The primary user is a NOC (Network Operations Centre) engineer who needs to monitor and understand network topology at a glance.

The system is split into two processes:

- **Frontend** — React app served by Vite, renders the map and UI
- **Backend** — FastAPI server, proxies routing requests to OSRM with caching, persists dragged routes to SQLite, and handles authentication

---

## Local Development

### Service Map

| Service  | Technology        | Port | Start condition |
| -------- | ----------------- | ---- | --------------- |
| OSRM     | Docker            | 5000 | Every session   |
| Backend  | FastAPI + uvicorn | 8000 | Every session   |
| Frontend | Vite dev server   | 5173 | Every session   |

OSRM **must be running before the backend** serves route requests. It does not persist state — it reads the pre-processed `.osrm` binary files in `backend/osrm-data/` on startup.

### One-command startup (Windows)

```
.\start.ps1              # starts OSRM, backend, frontend
.\start.ps1 -SkipDocker  # skips OSRM if already running
```

Each service opens in its own PowerShell window. Close all three windows to shut down.

### `start.ps1` — how it works

The script checks whether an OSRM container is already bound to port 5000 before starting a new one (`docker ps --filter "publish=5000"`), preventing duplicate container errors. Backend and frontend each launch in a separate `Start-Process powershell` window so their stdout streams are readable independently. The `-SkipDocker` flag is useful when iterating on backend or frontend code without restarting the routing engine.

### Manual startup (any OS)

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

### OSRM data directory

Pre-processed OSRM binary files live in `backend/osrm-data/`. This folder is excluded from version control (`.gitignore`) because the files are large binaries regenerated from OSM source data. The Docker volume mount in `start.ps1` points to this directory:

```
backend/osrm-data/ → /data (inside container)
```

### OSRM data — first-time setup

Download Bangladesh OSM data, then pre-process from `backend/osrm-data/`:

```bash
cd backend/osrm-data

docker run -t -i -v "$(pwd):/data" osrm/osrm-backend osrm-extract -p /opt/car.lua /data/bangladesh-latest.osm.pbf
docker run -t -i -v "$(pwd):/data" osrm/osrm-backend osrm-partition /data/bangladesh-latest.osrm
docker run -t -i -v "$(pwd):/data" osrm/osrm-backend osrm-customize /data/bangladesh-latest.osrm
```

All `.osrm` output files stay in `backend/osrm-data/`.

---

## Device Types

| Type        | Icon (Lucide) | Colour            |
| ----------- | ------------- | ----------------- |
| Core Router | Network       | Red `#ef4444`     |
| Router      | Router        | Magenta `#f63bbe` |
| Switch      | GitFork       | Amber `#f59e0b`   |
| Edge Router | Radio         | Purple `#8b5cf6`  |
| Server      | Server        | Green `#22c55e`   |

Icons are used only at zoom ≥ 12 (DOM marker mode). At lower zoom, devices render as coloured WebGL circles in clustered GeoJSON layers. The colour palette is defined in `frontend/src/data/networkData.js` as `DEVICE_COLORS` and consumed by both `createMarker.jsx` (DOM markers) and `iconSprite.js` (WebGL sprites).

---

## Frontend

### Map Initialisation (`NetworkMap.jsx`)

The map is initialised inside a `useEffect` with an empty dependency array, meaning it runs once on mount. A `useRef` holds the map instance to prevent React re-renders from interfering with MapLibre's internal state.

```
useEffect runs once
  → creates maplibregl.Map instance
  → registers PMTiles protocol (pmtiles://)
  → stores map in mapInstanceRef
  → on 'load' event:
      → fetches devices, links, and persisted routes from backend
      → builds devMap and linksByDevice lookup objects
      → adds PMTiles source (links-vector) — static pre-routed links
      → adds GeoJSON source (live-routes) — dragged + persisted routes
      → adds GeoJSON source (devices) — clustered device points
      → adds route layers for both sources (fiber / copper / wireless)
      → adds cluster layers (clusters-outer, clusters, cluster-count)
      → populates devices source with all 60,000 devices
      → calls hideMarkers() (starting zoom is below threshold)
  → on 'zoomend': showMarkers() if zoom ≥ 12, else hideMarkers()
  → on 'moveend': debounced 150ms → showMarkers() if zoom ≥ 12 (re-renders visible viewport)
  → cleanup: map.remove() on unmount
```

The guard `if (mapInstanceRef.current) return` prevents double-initialisation in React 18 StrictMode.

### Hybrid Zoom Layer

The map uses two rendering strategies depending on zoom level:

| Zoom | Mode                  | Technology | Max devices    |
| ---- | --------------------- | ---------- | -------------- |
| < 12 | GeoJSON cluster layer | WebGL      | 100,000+       |
| ≥ 12 | DOM markers           | HTML/CSS   | ~1,000 visible |

**Why two modes?** DOM markers are draggable and support rich interactivity, but each is a separate DOM node. Browsers struggle past ~1,000 DOM elements. WebGL cluster layers scale to hundreds of thousands of points and show aggregate counts at low zoom.

The switch is triggered by `map.on('zoomend')`:

```js
map.on('zoomend', () => {
  map.getZoom() >= 12 ? showMarkers() : hideMarkers();
});
```

`showMarkers()` queries the current viewport bounds, creates DOM markers only for visible devices, hides cluster layers, and attaches drag event handlers. `hideMarkers()` removes DOM markers and restores cluster layers. `map.on('moveend')` re-runs `showMarkers()` when panning at high zoom to load markers for newly visible devices. `moveend` is debounced at 150ms to prevent marker churn during inertial panning or scroll-zooming. After each `showMarkers()` call, `mainDevicesRef` is updated to reflect the devices now rendered as DOM markers — this keeps marker diffing accurate on subsequent viewport fetches and prevents ghost markers or duplicates on pan.

**Position sync:** When a marker is dragged, `dev.lng` / `dev.lat` are mutated in place (the `devMap` object). On `dragend`, `updateClusterSource()` rebuilds the devices GeoJSON from the updated values, so clusters reflect the new position when zooming back out.

### Zoom Behaviour

| Zoom | Rendering                               | Interaction              |
| ---- | --------------------------------------- | ------------------------ |
| < 12 | WebGL clustered circles (GeoJSON layer) | Click to expand cluster  |
| ≥ 12 | DOM markers with Lucide icons           | Draggable, click tooltip |

`moveend` at zoom ≥ 12 is debounced at 150ms. Panning rapidly fires multiple `moveend` events; only the final one triggers a marker re-render. Switching zoom levels syncs device positions — dragging a marker at high zoom updates the low-zoom circle position when zoomed back out.

### Route Layers (PMTiles + Live GeoJSON)

Two parallel sets of layers render link geometry:

```
links-fiber    ← source: links-vector (PMTiles)
links-copper
links-wireless

live-fiber     ← source: live-routes (GeoJSON)
live-copper
live-wireless
```

On load, the PMTiles layers are hidden with a `HIDDEN_DEFAULT` filter. `refreshFilters()` rebuilds the PMTiles filter to show only links whose `from` or `to` device is within the current viewport bounds, excluding any link IDs in `modifiedRouteIdsRef`. This prevents both sources from rendering the same link simultaneously.

### `refreshFilters()`

Called on `dragstart` and inside `showMarkers()`. Computes visible devices from `map.getBounds()`, then constructs a MapLibre filter expression that:

1. Matches the correct link type (`fiber`, `copper`, `wireless` — case-insensitive)
2. Excludes link IDs already in `modifiedRouteIdsRef` (live GeoJSON owns those)
3. Includes only links connected to a visible device

This avoids rendering tens of thousands of off-screen lines while keeping the visible network accurate.

### Drag Behaviour

Three events handle marker dragging:

- `dragstart` — adds all of the device's link IDs to `modifiedRouteIdsRef` and calls `refreshFilters()`, immediately hiding those links from the PMTiles layer
- `drag` — fires continuously. Updates `dev.lng / dev.lat` and redraws connected links as straight lines via `updateLiveRouteInMap()`. No network calls
- `dragend` — fires once on release. Posts to `POST /api/route` for each affected link with `link_id` and `link_type`, receives real road coordinates, flips `[lat, lng]` → `[lng, lat]` for GeoJSON, and updates the live source

### `updateLiveRouteInMap(linkId, linkType, coordinates, props)`

Replaces or inserts a feature in `liveRoutesRef.current.features` by `linkId`, then calls `map.getSource('live-routes').setData(...)`. This is the single mutation point for live route state — both drag feedback and post-OSRM updates go through here.

### Clustering

At zoom < 12, devices render as a clustered GeoJSON source with three layers:

- `clusters-outer` — translucent halo circle (colour scales green → amber → red by count)
- `clusters` — solid inner circle
- `cluster-count` — abbreviated count label

Clicking a cluster calls `getClusterExpansionZoom()` and `easeTo()` to zoom into it.

### Icon Sprites (`iconSprite.js`)

Each icon is drawn onto an offscreen HTML `canvas` and registered with MapLibre as an image:

```
SVG string → HTMLImageElement → drawImage onto canvas → getImageData → map.addImage()
```

The sprite registration code is used as a fallback at low zoom (before clustering) and ensures device type icons are available for WebGL rendering if needed.

### Custom Markers (`createMarker.jsx`)

Each device type gets a custom SVG icon rendered inside a coloured circle at high zoom. The marker element is a plain DOM `div` with inline styles. MapLibre receives this element via `{ element: el, draggable: true }`.

Tailwind classes are avoided on marker elements to prevent conflicts with MapLibre's CSS transformations.

### Legend (`Legend.jsx`)

The legend derives unique link types from the `LINKS` array using `reduce`, so adding a new link type to `networkData.js` automatically appears in the legend without any other changes.

### Dashboard Integration Surface

`NetworkMap.jsx` exposes two values for the parent dashboard to consume:

| Value            | Type                                    | Description                                                                                                                                                    |
| ---------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stats`          | `{ total, online, offline, warning }`   | Live device counts for the current viewport, updated after every `showMarkers()` call via `setStats`                                                           |
| `refreshMarkers` | `() => void`                            | Alias for `showMarkers()`, exposed so the dashboard toolbar can force a marker re-render after a data push or bulk update without reaching into map internals   |

`stats` is computed from the devices currently rendered in the viewport — not the full 60,000-device fixture. This makes it a meaningful "what's visible right now" count for the NOC status bar rather than a static total.

`refreshMarkers` is the only imperative handle the dashboard should need. Everything else is driven by map events internally.

### Why `useRef` not `useState`

MapLibre is imperative — it manages its own DOM. Using `useState` would trigger React re-renders that conflict with MapLibre's internal state. `useRef` provides stable storage that persists across renders without triggering them. Key refs:

- `mapRef` — the DOM div MapLibre renders into
- `mapInstanceRef` — the MapLibre map instance
- `markersRef` — array of active DOM marker instances
- `mainDevicesRef` — `{ [id]: device }` map of devices currently rendered as DOM markers; synced after every `showMarkers()` call so that pan-triggered re-renders diff correctly and don't duplicate or orphan markers
- `modifiedRouteIdsRef` — Set of link IDs owned by the live GeoJSON layer
- `liveRoutesRef` — current live GeoJSON FeatureCollection (avoids stale closure issues)

---

## Backend

### Entry Point (`main.py`)

Creates the FastAPI app, registers CORS middleware, creates database tables on startup, and mounts routers:

- `/api` — routing and fixture endpoints
- `/auth` — authentication endpoints

CORS allows requests from `http://localhost:5173`. In production, update `origins` to the deployed frontend URL.

### Routing Endpoints (`routers/routes.py`)

| Method | Endpoint              | Description                                                  |
| ------ | --------------------- | ------------------------------------------------------------ |
| POST   | `/api/route`          | Road route between two points; optionally persists to SQLite |
| GET    | `/api/devices`        | All devices from `fixtures/devices.json`                     |
| GET    | `/api/links`          | All links from `fixtures/links.json`                         |
| GET    | `/api/routes/geojson` | All persisted routes as GeoJSON FeatureCollection            |

`POST /api/route` accepts an extended `RouteRequest`:

```python
class RouteRequest(BaseModel):
    a: Point
    b: Point
    link_id: str | None = None
    link_type: str | None = None
```

When `link_id` is provided, the route is upserted into the `routes` SQLite table. This enables the frontend to restore all previously dragged routes on next page load via `GET /api/routes/geojson`.

### Database (`database.py`)

SQLAlchemy is configured with SQLite. Two models are exported:

**`User`** (auth):

| Field        | Type     | Notes                                    |
| ------------ | -------- | ---------------------------------------- |
| id           | Integer  | Primary key                              |
| email        | String   | Unique, not null                         |
| password     | String   | bcrypt hash                              |
| role         | String   | `noc_engineer`, `planner`, `technician`  |
| created\_at  | DateTime | UTC                                      |

**`Route`** (persisted drag results):

| Field        | Type     | Notes                                 |
| ------------ | -------- | ------------------------------------- |
| id           | String   | Primary key — `"{from_id}-{to_id}"`   |
| from\_id     | String   | Source device ID                      |
| to\_id       | String   | Target device ID                      |
| link\_type   | String   | `fiber`, `copper`, `wireless`         |
| coords       | JSON     | `[[lat, lng], ...]` array             |
| updated\_at  | DateTime | UTC, updated on each drag             |

`Base.metadata.create_all(bind=engine)` in `main.py` creates both tables on startup if they don't exist.

### OSRM Utility (`utils/osrm.py`)

Calls the local OSRM Docker instance at `localhost:5000` with a 6-second timeout. Parses GeoJSON geometry and flips coordinates from `[lng, lat]` to `[lat, lng]`. Falls back to a straight line between the two points on any error.

```
fetch_route(a, b):
  check cache → hit → move to end (LRU) → return cached coords
  miss → GET localhost:5000/route/v1/driving/...
       → parse coords
       → haversine check:
           straight_line_km = haversine(a, b)
           if route_length_km > straight_line_km × 2:
               → discard → return [[a.lat, a.lng], [b.lat, b.lng]]  # straight-line fallback
           else → evict LRU if cache full → store → return parsed coords
  error → return [[a.lat, a.lng], [b.lat, b.lng]]
```

**Border-crossing sanity check:** OSRM routes along the shortest road-network path regardless of national boundaries. With a Bangladesh-scoped OSM extract this rarely occurs, but as a defensive layer the backend compares the returned route length against the straight-line (haversine) distance between the two points. Any route exceeding 2× the straight-line distance is rejected and replaced with a direct segment. A legitimate road route in the Bangladesh delta geography will not exceed this ratio; anything that does indicates a cross-border routing artifact.

The 2× threshold is configurable via `OSRM_MAX_DETOUR_RATIO` (see [Environment Variables](#environment-variables)). Lower it if false positives occur on known long-detour corridors (e.g. river crossings); raise it cautiously as it weakens the guard.

---

## Environment Variables

| Variable                  | Default           | Description                                                                                      |
| ------------------------- | ----------------- | ------------------------------------------------------------------------------------------------ |
| `SECRET_KEY`              | dev placeholder   | JWT signing secret. **Must be set in production** — the default is not secure                    |
| `OSRM_MAX_DETOUR_RATIO`   | `2.0`             | Maximum allowed ratio of road-route length to haversine distance before the route is discarded   |

Set these in a `.env` file at the repo root or export them in your shell before starting the backend:

```bash
export SECRET_KEY="your-secret-key-here"
export OSRM_MAX_DETOUR_RATIO=2.5
```

---

## Authentication

### Flow

```
Signup:
  POST /auth/signup { email, password }
  → check email not taken
  → hash password with bcrypt
  → store User in SQLite
  → return success message

Login:
  POST /auth/login { email, password }
  → find user by email
  → verify password against hash
  → create JWT with { sub: email, role: role }
  → return { token, token_type: "bearer" }

Protected request (future):
  Frontend sends: Authorization: Bearer <token>
  Backend calls verify_token(token)
  → valid → proceed
  → invalid → 401
```

### JWT

Tokens are signed with HS256 using a server-side secret key loaded from the `SECRET_KEY` environment variable. The payload contains:

```json
{
  "sub": "user@example.com",
  "role": "noc_engineer",
  "exp": 1234567890
}
```

Tokens expire after 30 minutes.

### Password Security

Passwords are hashed with bcrypt via `passlib`. Plain text passwords are never stored or logged. Verification uses `pwd_context.verify(plain, hashed)` which is timing-safe.

---

## Routing & Caching

### OSRM

The app uses a locally hosted OSRM instance running in Docker on port 5000. OSRM uses Dijkstra's algorithm on OpenStreetMap road data to return the fastest driving route between two points.

The URL format is:

```
/route/v1/driving/{lng1},{lat1};{lng2},{lat2}?overview=full&geometries=geojson
```

Note: OSRM takes longitude before latitude, opposite of most mapping conventions.

### In-Memory LRU Cache

```python
_cache = OrderedDict()  # module-level, persists across requests
MAX_CACHE = 10_000

key = f"{a.lat},{a.lng},{b.lat},{b.lng}"

if key in _cache:
    _cache.move_to_end(key)   # promote to most-recently-used
    return _cache[key]

result = call_osrm(a, b)

if len(_cache) >= MAX_CACHE:
    _cache.popitem(last=False) # evict least-recently-used

_cache[key] = result
return result
```

The cache key combines all four coordinate values. A→B and B→A produce different keys — intentional since road routes are not always reversible.

**Limitations:**

- Lost on server restart
- Not shared across multiple server instances
- Bounded at 10,000 entries with LRU eviction

**Production upgrade path:** Replace `OrderedDict` with Redis. The interface is nearly identical and Redis survives restarts and scales horizontally.

---

## Static vs Live Routes

The map renders two independent route layers that work in tandem:

### PMTiles layer (`links-vector` / `links-*`)

A pre-built `dummy-network.pmtiles` file in `frontend/public/` contains road-routed GeoJSON for all ~60,000 links, built via `backend/fixtures/generate-geojson.js` and compiled with `tippecanoe`. These are rendered as vector tile layers and are visible by default for the current viewport.

### Live GeoJSON layer (`live-routes` / `live-*`)

A mutable in-memory GeoJSON `FeatureCollection` held in `liveRoutesRef`. On page load it is populated from `GET /api/routes/geojson` (all previously dragged routes from SQLite). During drag it updates in real time. After `dragend` it updates with the real OSRM route.

### Handoff logic

When a device is dragged:

1. `dragstart` — adds affected link IDs to `modifiedRouteIdsRef`
2. `refreshFilters()` rebuilds the PMTiles filter to exclude those IDs
3. Live GeoJSON layer now owns those links exclusively
4. No link is ever rendered by both layers simultaneously

This handoff is permanent for the session — once a link is in `modifiedRouteIdsRef`, the PMTiles layer never renders it again. On next page load, `GET /api/routes/geojson` pre-populates `liveRoutesRef` so previously dragged routes are immediately shown in the live layer.

---

## Scripts & Data Pipeline

The full data pipeline that builds the static fixture files and PMTiles archive is:

```
generate_fixtures.py  →  devices.json + links.json (60,000 devices, spatially clustered)
generate-geojson.js   →  dummy-routes.geojson       (road-routed lines via local OSRM)
export_pmtiles.py     →  dummy-network.pmtiles       (vector tile archive via tippecanoe)
seed_db.py            →  SQLite                      (optional: pre-seed auth + route tables)
```

### `scripts/generate_fixtures.py`

Generates `backend/fixtures/devices.json` and `backend/fixtures/links.json`. Devices are placed in spatially clustered groups to simulate realistic network topology across Bangladesh. Run this to regenerate the fixture dataset (e.g. to change device count or geographic distribution).

### `backend/fixtures/generate-geojson.js`

Reads `devices.json` and `links.json`, calls the local OSRM instance for each link, and writes `dummy-routes.geojson`. Requires OSRM to be running on port 5000. This is a one-time (or on-fixture-change) step — the resulting GeoJSON is the input to `export_pmtiles.py`.

```bash
# From backend/fixtures/
node generate-geojson.js
```

### `scripts/export_pmtiles.py`

Converts `dummy-routes.geojson` into `frontend/public/dummy-network.pmtiles` using `tippecanoe`. Requires `tippecanoe` to be installed on the host.

```bash
# From backend/
python scripts/export_pmtiles.py
```

### `scripts/seed_db.py`

Seeds the SQLite database with initial data (users, optional pre-defined routes). Useful for setting up a development environment without going through the signup flow manually.

```bash
cd backend
python scripts/seed_db.py
```

### When to re-run the pipeline

Only run the full pipeline when:

- The device/link fixture data changes (new count, new geography)
- The OSRM road data is updated to a newer OSM extract
- `tippecanoe` settings are tuned for different zoom level detail

Normal development (code changes, UI tweaks) does not require re-running any of these scripts.

---

## Testing

### Backend Tests (pytest)

Tests use FastAPI's `TestClient` which sends requests directly to the app without a running server, making tests fast and reliable.

```bash
cd backend
pytest tests/test_routes.py -v
```

**Route sanity tests** use a dynamic bounding box computed from input points:

```python
min_lat = min(a["lat"], b["lat"]) - 1.0
max_lat = max(a["lat"], b["lat"]) + 1.0
```

This works for any coordinates worldwide.

**Cache test** mocks OSRM using `unittest.mock.patch` to replace `httpx.AsyncClient` with a fake. After two identical requests, `call_count == 1` proves OSRM was only called once.

| Test                        | What it verifies                                      |
| --------------------------- | ----------------------------------------------------- |
| `test_dhaka_city`           | Local route returns valid coords within bounding box  |
| `test_dhaka_to_chittagong`  | Long-distance BD route works correctly                |
| `test_international`        | Routing works for any coordinates worldwide           |
| `test_cache_hits_osrm_once` | OSRM called once for two identical requests           |

### Frontend Performance Tests (Playwright)

Playwright controls a real Chromium browser. Tests access the MapLibre map instance via `window.__map`, exposed in `NetworkMap.jsx` under `import.meta.env.DEV`.

```bash
cd frontend
npx playwright test --headed
```

Requires both the Vite dev server and FastAPI backend to be running.

| Test                   | Threshold  | Notes                                  |
| ---------------------- | ---------- | -------------------------------------- |
| 100 devices (WebGL)    | < 100ms    | GeoJSON source setData + render event  |
| 1,000 devices (WebGL)  | < 200ms    |                                        |
| 10,000 devices (WebGL) | < 500ms    |                                        |
| 60,000 devices load    | < 5,000ms  | Polls source until features populated  |
| 50,000 DOM markers     | < 5,000ms  | Zoom 14, injects raw Marker instances  |
| 60,000 devices render  | < 500ms    | triggerRepaint + render event timing   |

---

## Data Structures

### DEVICES (fixture)

```js
{
  id: string,       // e.g. "router-1"
  name: string,     // display name
  lat: number,
  lng: number,
  type: string      // 'core-router' | 'router' | 'switch' | 'edge-router' | 'server'
}
```

### LINKS (fixture)

```js
{
  id: string,       // e.g. "l1"
  from: string,     // device id
  to: string,       // device id
  type: string,     // 'fiber' | 'copper' | 'wireless'
  color: string     // hex color
}
```

### Route response (`POST /api/route`)

```js
[[lat, lng], [lat, lng], ...]
```

### GeoJSON Device Feature

```json
{
  "type": "Feature",
  "geometry": { "type": "Point", "coordinates": [lng, lat] },
  "properties": { "id": "core-1", "type": "core-router", "name": "Core Router Alpha" }
}
```

### GeoJSON Link Feature (live layer)

```json
{
  "type": "Feature",
  "properties": { "id": "l1", "from": "core-1", "to": "dist-1", "type": "fiber" },
  "geometry": {
    "type": "LineString",
    "coordinates": [[lng, lat], [lng, lat]]
  }
}
```

---

## Key Design Decisions

**Why MapLibre over Leaflet?** MapLibre uses WebGL for rendering and vector tiles for data. Leaflet uses raster tiles and SVG/Canvas for markers — heavier at scale. Performance tests confirm MapLibre renders 10,000 devices in ~85ms.

**Why PMTiles for static routes?** A single `.pmtiles` file replaces tens of thousands of individual GeoJSON sources and layers. It is served as a static file, requires no backend involvement, and MapLibre streams only the tiles needed for the current viewport via range requests.

**Why a hybrid PMTiles + live GeoJSON approach?** PMTiles efficiently serves the static 60,000-link dataset. The live GeoJSON layer handles the small subset of routes that have been modified by dragging, with real-time updates. Trying to do either job with the other technology would be worse: live GeoJSON can't efficiently serve 60,000 features; PMTiles can't be mutated at runtime.

**Why the hybrid zoom approach?** DOM markers are draggable and support Lucide icons but degrade past ~1,000 nodes. WebGL cluster layers scale to 100,000+ devices and give NOC engineers a spatial overview at low zoom. Switching at zoom 12 (district level) provides a fast overview and full interactivity when zoomed in.

**Why FastAPI over Express or Django?** FastAPI is async-native (important for concurrent OSRM calls), generates API docs automatically, and uses Python type hints for validation via Pydantic. Django is too heavy for a simple API layer.

**Why SQLite for both auth and route persistence?** SQLite requires zero configuration for development. SQLAlchemy abstracts the database so switching to PostgreSQL requires changing one connection string. Route persistence (dragged routes surviving page reload) is a lightweight workload well suited to SQLite.

**Why in-memory LRU cache over Redis?** In-memory is zero-dependency and sufficient for a single-instance dev server. The `OrderedDict`-based LRU is bounded at 10,000 entries to prevent unbounded growth. Swapping to Redis is a localised change in `osrm.py`.

**Why JWT over sessions?** JWTs are stateless — the server stores no session data. This makes horizontal scaling simpler and fits the REST API model.

**Why `useRef` for the map instance?** MapLibre manages its own DOM imperatively. `useState` would cause re-renders that conflict with MapLibre's internal state. `useRef` provides stable storage across renders without triggering them.

**Why `liveRoutesRef` instead of deriving state?** The live route FeatureCollection is mutated frequently (every drag frame). Holding it in a ref avoids React re-renders on every mouse move while still allowing `map.getSource('live-routes').setData()` to update the map imperatively.

**Why debounce `moveend` at 150ms and not higher?** 300ms is perceptibly laggy on fast deliberate pans — markers visibly lag the gesture. 150ms is below the threshold of conscious perception for pan completion while still collapsing rapid successive events (trackpad scroll-zoom, inertial scroll) into one call. The value can be tuned per device class if needed.

**Why a haversine check on OSRM output?** The Bangladesh OSM extract eliminates the root cause of cross-border routing. The haversine check is a defensive layer that catches any residual artifacts and is cheap to run (pure arithmetic, no I/O). It also guards against future OSRM data updates introducing unexpected routing behaviour.