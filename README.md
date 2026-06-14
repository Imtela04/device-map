# Device Maps

A network topology dashboard for visualising and managing ISP infrastructure on an interactive map. Built for NOC engineers to monitor OLT/ONU networks in real time.

---

## What It Does

Device Maps renders an ISP's full device hierarchy — core routers, edge routers, OLTs (Optical Line Terminals), distribution switches, and customer routers/ONUs — as markers on a MapLibre GL JS map, connected by OSRM road-routed links.

Loading is on-demand and tier-based. At country zoom, only the backbone (core and edge routers) is fetched. Zooming to district level brings OLTs, switches, and servers into view. Zooming into a neighbourhood fetches customer routers for the visible viewport only — the full 60,000-device dataset is never loaded at once.

Clicking any infrastructure device opens a stats popup and highlights its upstream path to the backbone. Clicking an OLT also renders its connected ONU routes. Dragging a device re-routes its connected links via OSRM and persists the new position to the backend.

The module exposes a live `stats` object (viewport device counts by status) and a `refreshMarkers()` handle so a parent ISP dashboard can trigger re-renders after external data changes.

---

## Architecture

```
Browser (React + Tailwind + MapLibre GL JS)
        ↕  HTTP/JSON
FastAPI (Python)
   ├── Fixture cache (module-level, loaded once from devices.json / links.json)
   ├── Viewport filtering (bounding box + tier)
   └── SQLite (persisted drag routes + user auth)
        ↕
OSRM public demo API (router.project-osrm.org)   ← live route requests
OSRM Docker (localhost:5000)                      ← PMTiles batch generation only
```

**Two data loading phases on the frontend:**

1. **Eager (on init)** — `GET /api/devices/infra` + `GET /api/links/infra` load the full backbone immediately so core/edge/OLT topology is visible at any zoom, with straight-line geometry shown instantly, then replaced by OSRM road routes in batches.
2. **On-demand (per viewport)** — every `moveend` triggers `GET /api/devices/viewport` + `GET /api/links/viewport` with the current bounding box and a tier parameter, fetching only what is in view at the current zoom level. Grid-based cache keys prevent duplicate fetches for the same area.

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
| Dev runner | concurrently | Backend + frontend in one terminal |

---

## Project Structure

```
device-maps/
├── .gitignore
├── README.md
├── docs.md
├── requirements.txt
├── start.ps1                          # One-command startup (Windows)
│
├── backend/
│   ├── main.py                        # App entry point, CORS, router registration
│   ├── database.py                    # SQLAlchemy engine, session, Route model
│   ├── test_topology.py               # Standalone 3-hop hierarchy validator (not pytest)
│   │
│   ├── auth/
│   │   ├── models.py                  # User SQLAlchemy model
│   │   ├── router.py                  # POST /auth/signup, POST /auth/login
│   │   ├── schemas.py                 # Pydantic request/response shapes
│   │   └── utils.py                   # JWT creation/verification, password hashing
│   │
│   ├── fixtures/
│   │   └── generate-routes.py         # Batch-generates routes.geojson via local OSRM
│   │
│   ├── routers/
│   │   └── routes.py                  # All /api/* endpoints
│   │
│   ├── scripts/
│   │   ├── export_pmtiles.py          # GeoJSON → PMTiles via tippecanoe
│   │   ├── generate_fixtures.py       # Generates devices.json + links.json
│   │   └── seed_db.py                 # (reserved)
│   │
│   ├── tests/
│   │   └── test_routes.py             # pytest suite
│   │
│   └── utils/
│       └── osrm.py                    # OSRM fetch with in-memory LRU cache
│
└── frontend/
    ├── eslint.config.js
    ├── index.html
    ├── playwright.config.js
    ├── vite.config.js
    │
    ├── public/
    │   ├── dummy-network.pmtiles      # Pre-built static route tiles (gitignored source)
    │   ├── favicon.svg
    │   └── icons.svg
    │
    ├── src/
    │   ├── App.jsx                    # Root — renders <NetworkMap />
    │   ├── index.css                  # Tailwind import + NOC pulse keyframes
    │   │
    │   ├── components/
    │   │   ├── DeviceIcon.jsx         # Lucide icon per device type (reference component)
    │   │   ├── Legend.jsx             # Link type legend overlay
    │   │   └── NetworkMap.jsx         # Thin shell — mounts the map div, calls useNetworkMap
    │   │
    │   ├── data/
    │   │   └── networkData.js         # Small static dataset (dev/test reference only)
    │   │
    │   ├── hooks/
    │   │   └── useNetworkMap.js       # All map logic — viewport loading, markers, drag, routes
    │   │
    │   └── utils/
    │       ├── createMarker.jsx       # Creates draggable DOM markers (zoom ≥ 12)
    │       ├── fetchRoute.js          # Calls /api/route with client-side dedup cache
    │       ├── iconSprite.js          # Registers WebGL icon sprites with MapLibre
    │       ├── mapConstants.js        # INFRA set, STATUS_COLOR, DEVICE_LEVEL, TIER, TIER_COLOR, TIER_SPEED
    │       ├── mockStatus.js          # Deterministic fake status derived from device ID
    │       ├── popupTemplates.js      # HTML builders for link, device, and customer popups
    │       ├── setupMapLayers.js      # Adds all MapLibre sources, layers, and hover handlers
    │       └── toGeoJSON.js           # Converts [lat, lng] arrays to GeoJSON LineString
    │
    └── tests/
        └── performance.spec.js        # Playwright performance benchmarks
```

> `fixtures/devices.json`, `fixtures/links.json`, `osrm-data/`, and compiled `.pmtiles` are gitignored. Generate them locally with the scripts below.

---

## Getting Started

### Prerequisites

- Node.js 18+
- Python 3.10+
- A free [MapTiler](https://maptiler.com) API key
- Docker Desktop — only needed to regenerate `dummy-network.pmtiles`; not required for normal development

### Generate Fixtures (first time only)

```bash
cd backend
python scripts/generate_fixtures.py
```

Outputs `fixtures/devices.json` (60,000 devices) and `fixtures/links.json`. For a reproducible dataset:

```bash
python scripts/generate_fixtures.py --seed 42
```

### OSRM Data (PMTiles regeneration only)

Live route requests call the public OSRM demo API — no local Docker needed for day-to-day development. Docker OSRM is only required when regenerating `dummy-network.pmtiles`.

Download Bangladesh OSM data, then pre-process from `backend/osrm-data/`:

```bash
cd backend/osrm-data

docker run -t -i -v "$(pwd):/data" osrm/osrm-backend osrm-extract -p /opt/car.lua /data/bangladesh-latest.osm.pbf
docker run -t -i -v "$(pwd):/data" osrm/osrm-backend osrm-partition /data/bangladesh-latest.osrm
docker run -t -i -v "$(pwd):/data" osrm/osrm-backend osrm-customize /data/bangladesh-latest.osrm
```

Then generate routes and compile tiles:

```bash
# From backend/fixtures/ — requires local OSRM on :5000
python generate-routes.py

# From backend/ — requires tippecanoe installed
python scripts/export_pmtiles.py
```

### Running — Windows (one command)

```powershell
.\start.ps1
```

Starts OSRM in Docker (detached, skipped if already running), then runs FastAPI and Vite together in the same terminal via `concurrently`. Press `Ctrl+C` to stop both.

```powershell
.\start.ps1 -SkipDocker   # skip OSRM container check
```

### Running — Manual (any OS)

```bash
# Terminal 1 — Backend
cd backend
source venv/bin/activate        # Mac/Linux
# .\venv\Scripts\activate       # Windows
pip install -r requirements.txt # first time only
uvicorn main:app --reload

# Terminal 2 — Frontend
cd frontend
npm install                     # first time only
npm run dev
```

Open `http://localhost:5173`

---

## Service Map

| Service | Technology | Port | Notes |
|---|---|---|---|
| Backend | FastAPI + uvicorn | 8000 | Serves device/link data, proxies route requests |
| Frontend | Vite dev server | 5173 | Hot-reloads on file changes |
| OSRM (Docker) | osrm-backend | 5000 | PMTiles batch generation only — not used at runtime |

Live route requests (`POST /api/route`) call `https://router.project-osrm.org` — the Docker container is not required during normal development.

---

## API Endpoints

### Devices & Links

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/devices/infra` | Backbone devices (core-router, edge-router, olt, server, switch, router) — loaded eagerly on init |
| GET | `/api/links/infra` | Inter-infra links (both endpoints are infra nodes) — loaded eagerly on init |
| GET | `/api/devices/viewport` | Devices inside a bounding box, filtered by tier |
| GET | `/api/links/viewport` | Links where at least one endpoint is in the bounding box, filtered by tier |
| PATCH | `/api/devices/{device_id}` | Persist a dragged device's new lat/lng to `devices.json` |
| GET | `/api/devices` | All devices (debug/legacy) |
| GET | `/api/links` | All links (debug/legacy) |

**Viewport query parameters:**

```
west, south, east, north : float    — bounding box coordinates
tier                      : string  — 'core' | 'olt' | 'access'
```

**Tier → device type mapping:**

| Tier | Device types included |
|---|---|
| `core` | core-router, edge-router |
| `olt` | + olt, server, switch, router |
| `access` | + customer-router |

Links at each tier are only returned when **both** endpoints belong to an allowed type. A link is included if at least one endpoint falls within the bounding box.

### Routing

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/route` | Compute a road route between two points; persists to SQLite when `link_id` is provided |
| GET | `/api/routes/viewport` | Persisted routes where at least one endpoint is in the viewport, filtered by tier |
| GET | `/api/routes/geojson` | All persisted routes as GeoJSON (debug/legacy) |

**POST `/api/route` body:**

```json
{
  "a": { "lat": 23.7269, "lng": 90.4193 },
  "b": { "lat": 23.7808, "lng": 90.4147 },
  "link_id": "olt-42-customer-router-1871",
  "link_type": "generic"
}
```

`link_id` and `link_type` are optional. When provided, the route is upserted into SQLite and returned by `/api/routes/viewport` on subsequent loads.

**Response:** Array of `[lat, lng]` coordinate pairs tracing the road route.

### Auth

| Method | Endpoint | Description |
|---|---|---|
| POST | `/auth/signup` | Register a new user |
| POST | `/auth/login` | Login and receive a JWT |

**Login response:**

```json
{
  "token": "eyJ...",
  "token_type": "bearer"
}
```

---

## Caching

**Backend — route results:** LRU `OrderedDict` in `utils/osrm.py`, max 10,000 entries, keyed by `"{a.lat},{a.lng},{b.lat},{b.lng}"`. OSRM is only called once per unique coordinate pair per server session. Swap for Redis in production.

**Backend — fixture data:** `devices.json` and `links.json` are read from disk once on first request and held in module-level globals. `PATCH /api/devices/{id}` invalidates the cache after each write.

**Frontend — route results:** `fetchRoute.js` maintains a client-side resolved-results cache and an in-flight dedup map. Identical route requests in the same browser session return without a network call. `dragend` persist calls bypass the client cache so they always reach the backend.

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
| `test_cache_hits_osrm_once` | OSRM called exactly once for two identical requests |

**Topology validator** (standalone script, not pytest):

```bash
cd backend
python test_topology.py
```

Confirms the strict 3-hop hierarchy (customer → OLT → edge → core) across all generated devices. Reports average hop count and flags any broken paths.

### Frontend Performance

```bash
cd frontend
npx playwright test --headed
```

Requires the Vite dev server and FastAPI backend to be running. Playwright accesses the map via `window.__map`, exposed in `DEV` mode inside `useNetworkMap.js`.

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

| Type | Icon | Colour | Tier |
|---|---|---|---|
| Core Router | Network | Indigo `#7c3aed` | Backbone |
| Edge Router | Radio | Orange `#f97316` | Regional |
| OLT | Monitor | Teal `#14b8a6` | Aggregation |
| Router | Router | Green `#22c55e` | Distribution |
| Switch | GitFork | Emerald `#10b981` | Distribution |
| Server | Server | Slate `#475569` | Infrastructure |
| Customer Router | — | WebGL cluster only below zoom 12 | Access |

Icons at zoom ≥ 12 are rendered by `createMarker.jsx` (inline SVG DOM markers). Icons at low zoom are WebGL sprites registered by `iconSprite.js`. The colours above are from `createMarker.jsx`, which is the canonical source at high zoom.

---

## Zoom Behaviour

| Zoom | Tier | What is fetched | Rendering |
|---|---|---|---|
| < 5 | — | Nothing (infra already in memory) | Single animated network dot |
| 5–9 | `core` | Core + edge routers | WebGL symbol icons |
| 10–11 | `olt` | + OLTs, switches, servers, routers | WebGL symbol icons |
| ≥ 12 | `access` | + customer routers (viewport, capped 400) | Draggable DOM markers |

Viewport fetches use a grid-key cache that includes the tier, so zooming in always triggers a re-fetch even if the geographic area was already seen at a lower tier. `moveend` at zoom ≥ 12 is debounced at 80ms.

Infrastructure symbol icons (`unclustered-main-devices` layer) are always visible from zoom 5 upward regardless of DOM marker state, using zoom-stepped opacity to reveal core → edge → OLT progressively.

---

## Device Focus Mode

Clicking any device (WebGL icon or DOM marker) enters focus mode:

- Map routes filter to show only connections from the selected device
- Neighbouring devices render as DOM markers (infra: all; access: capped at 50)
- Infrastructure devices: upstream path to the backbone is highlighted on the `path-highlight` source
- OLT devices: connected customer/ONU routes are fetched and shown on the `customer-route` source
- Clicking the map background exits focus mode and restores full rendering

---

## Static vs Live Routes

| Layer ID | Source | Purpose |
|---|---|---|
| `live-generic` | `live-routes` GeoJSON | All infrastructure routes and dragged routes |
| `live-routes` GeoJSON | Soft glow behind live routes, status-coloured |
| `customer-route-line` | `customer-route` GeoJSON | ONU/customer routes (focus mode or viewport) |
| `drag-routes-line` | `drag-routes` GeoJSON | Temporary straight-line visual during drag gesture |
| `path-line` | `path-highlight` GeoJSON | Upstream path highlight on device click |

All live route state lives in `liveRouteMapRef` — a `Map<linkId, GeoJSONFeature>`. Updates are flushed to the `live-routes` MapLibre source through a 100ms debounced `queueLiveRouteUpdate()`, which also filters by tier so the payload is proportional to what the current zoom would actually render.

Line width and opacity are zoom-stepped per tier: backbone routes are wide and visible at country level; access routes only appear when zoomed in past district level.

---

## Integration Interface

`useNetworkMap()` returns three values:

```js
const { mapRef, stats, refreshMarkers } = useNetworkMap();
```

| Value | Type | Description |
|---|---|---|
| `mapRef` | `React.RefObject<HTMLDivElement>` | Attach to the map container `<div>` |
| `stats` | `{ total, online, degraded, down }` | Live device counts for the current viewport, updated on each viewport fetch |
| `refreshMarkers` | `() => void` | Forces a marker re-render for the current viewport |

```jsx
export default function Dashboard() {
  const { mapRef, stats, refreshMarkers } = useNetworkMap();

  return (
    <>
      <StatusBar
        online={stats.online}
        degraded={stats.degraded}
        down={stats.down}
      />
      <div ref={mapRef} style={{ height: '100vh', width: '100%' }} />
      <button onClick={refreshMarkers}>Refresh</button>
    </>
  );
}
```

`stats` counts devices currently held in `devMapRef` (all fetched devices, not just the visible viewport slice). `refreshMarkers` is an alias for the internal `showMarkers()` function and is the only imperative handle the parent dashboard should need.