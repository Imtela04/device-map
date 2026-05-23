# Device Maps — Technical Documentation

## Table of Contents

1. [Overview](#overview)
2. [Frontend](#frontend)
3. [Backend](#backend)
4. [Authentication](#authentication)
5. [Routing & Caching](#routing--caching)
6. [Testing](#testing)
7. [Data Structures](#data-structures)
8. [Key Design Decisions](#key-design-decisions)

---

## Overview

Device Maps is a network topology visualisation dashboard. It renders network infrastructure (routers, switches, servers) as markers on a MapLibre map, connected by road-routed links. The primary user is a NOC (Network Operations Centre) engineer who needs to monitor and understand network topology at a glance.

The system is split into two processes:

- **Frontend** — React app served by Vite, renders the map and UI
- **Backend** — FastAPI server, proxies routing requests to OSRM with caching and handles authentication

---

## Frontend

### Map Initialisation (`NetworkMap.jsx`)

The map is initialised inside a `useEffect` with an empty dependency array, meaning it runs once on mount. A `useRef` holds the map instance to prevent React re-renders from interfering with MapLibre's internal state.

```
useEffect runs once
  → creates maplibregl.Map instance
  → stores in mapInstanceRef
  → exposes window.__map, window.__linkIds, window.maplibregl (DEV only)
  → on 'load' event:
      → builds pos object (mutable device positions)
      → defines showMarkers() / hideMarkers()
      → registers zoom event for hybrid switching
      → defines rerouteFor()
      → creates DOM markers, stores in markersRef
      → adds link sources and layers
      → loads icon sprites via loadDeviceIcons()
      → adds devices GeoJSON source and symbol layer
      → adds device and link hover tooltips
      → calls hideMarkers() (starting zoom is 11, below threshold)
      → fetches initial routes for all links
  → cleanup: map.remove() on unmount
```

The guard `if (mapInstanceRef.current) return` prevents double-initialisation in React 18 StrictMode.

### Hybrid Zoom Layer

The map uses two rendering strategies depending on zoom level:

| Zoom | Mode | Technology | Max devices |
|---|---|---|---|
| ≤ 13 | GeoJSON symbol layer | WebGL | 100,000+ |
| > 13 | DOM markers | HTML/CSS | ~1,000 |

**Why two modes?** DOM markers are draggable and support rich interactivity, but each is a separate DOM node. Browsers struggle past ~1,000 DOM elements. WebGL renders from a single GeoJSON source and can handle hundreds of thousands of points.

The switch is triggered by `map.on('zoom')`:

```js
map.on('zoom', () => {
    map.getZoom() > 13 ? showMarkers() : hideMarkers();
});
```

`showMarkers()` adds DOM markers to the map and hides the symbol layer. `hideMarkers()` removes DOM markers and shows the symbol layer. DOM marker instances are stored in `markersRef` (a `useRef`) so they persist between zoom events without triggering re-renders.

**Position sync:** When a marker is dragged at high zoom, `pos[dev.id]` is updated. On `dragend`, `rerouteFor()` also rebuilds the `devices` GeoJSON source from current `pos` values, so circles reflect the new position when zooming back out.

### Icon Sprites (`iconSprite.js`)

At low zoom, devices render as icon sprites registered with MapLibre via `map.addImage()`. Each icon is drawn onto an offscreen HTML `canvas`:

```
SVG string → HTMLImageElement → drawImage onto canvas → getImageData → map.addImage()
```

The canvas draws a coloured circle background first, then the Lucide icon SVG on top. Images are registered by device type name (`'router'`, `'server'`, etc.) and referenced in the symbol layer via `['get', 'type']`.

Icons use the exact SVG paths from [lucide.dev](https://lucide.dev) to match the high-zoom DOM marker appearance.

### Why `useRef` not `useState`

MapLibre is imperative — it manages its own DOM. Using `useState` would trigger React re-renders that conflict with MapLibre's internal state. `useRef` provides stable storage that persists across renders without triggering them. Three refs are used:

- `mapRef` — the DOM div MapLibre renders into
- `mapInstanceRef` — the MapLibre map instance
- `markersRef` — array of DOM marker instances

### Sources and Layers

Each link has a GeoJSON source and a line layer. The source holds coordinate data; the layer defines how to render it. This separation allows updating data (`source.setData()`) without recreating the layer.

```js
map.addSource(link.id, { type: 'geojson', data: emptyFeature });
map.addLayer({ id: link.id, type: 'line', source: link.id, paint: {...} });
map.getSource(link.id).setData(toGeoJSON(coords));  // update data only
```

Devices use a single shared source (`'devices'`) with a symbol layer (`'devices-circles'`). The source is a `FeatureCollection` of all device points. Device type colours are applied via a MapLibre `match` expression:

```js
'circle-color': ['match', ['get', 'type'],
    'core-router', '#ef4444',
    'router', '#3b82f6',
    // ...
]
```

### Drag Behaviour

Two events handle marker dragging:

- `drag` — fires continuously. Updates `pos[dev.id]` and redraws connected links as straight lines for instant visual feedback. No network calls.
- `dragend` — fires once on release. Calls `rerouteFor(deviceId)` which fetches real road routes from the backend for all affected links, then rebuilds the devices GeoJSON source to sync circle positions.

### Tooltips

**Device tooltips (low zoom):** MapLibre mouse events on the symbol layer show a `Popup` with device name and type on hover.

**Device tooltips (high zoom):** MapLibre `Popup` attached to each DOM marker via `marker.setPopup()`, shown on click.

**Link tooltips:** MapLibre mouse events on each line layer show a `Popup` with `from → to` and link type on hover.

### GeoJSON Helper (`toGeoJSON.js`)

MapLibre requires data in GeoJSON format. The helper converts the backend's `[[lat, lng], ...]` array to a GeoJSON Feature:

```js
export function toGeoJSON(coords) {
    return {
        type: "Feature",
        geometry: {
            type: "LineString",
            coordinates: coords.map(([lat, lng]) => [lng, lat])
        }
    }
}
```

Note the coordinate flip — GeoJSON uses `[lng, lat]` (longitude first), opposite of the backend's `[lat, lng]` pairs.

### Custom Markers (`createMarker.jsx`)

Each device type gets a custom SVG icon rendered inside a coloured circle at high zoom. The marker element is a plain DOM `div` with inline styles and SVG `innerHTML`. MapLibre receives this element via `{ element: el }`.

Tailwind classes are avoided on marker elements to prevent conflicts with MapLibre's CSS transformations.

### Legend (`Legend.jsx`)

The legend derives unique link types from the `LINKS` array using `reduce`, avoiding hardcoded entries. This means adding a new link type to `networkData.js` automatically appears in the legend.

```js
const linkTypes = Object.values(
    LINKS.reduce((acc, cur) => {
        acc[cur.type] = acc[cur.type] || { type: cur.type, color: cur.color };
        return acc;
    }, {})
);
```

### Device Colors (`networkData.js`)

`DEVICE_COLORS` is the single source of truth for device type colours, imported by both `iconSprite.js` (low zoom WebGL) and `DeviceIcon.jsx` (high zoom DOM):

```js
export const DEVICE_COLORS = {
  'core-router': '#ef4444',
  'router':      '#3b82f6',
  'switch':      '#f59e0b',
  'edge-router': '#8b5cf6',
  'server':      '#22c55e',
};
```

---

## Backend

### Entry Point (`main.py`)

Creates the FastAPI app, registers CORS middleware, creates database tables, and mounts routers:

- `/api` — routing endpoints
- `/auth` — authentication endpoints

CORS allows requests from `http://localhost:5173` (Vite dev server). In production, update `origins` to the deployed frontend URL.

### Routing Endpoint (`routers/routes.py`)

`POST /api/route` accepts two `Point` objects, calls `fetch_route`, and returns a coordinate array. Pydantic validates the request shape automatically — invalid input returns a 422 response without any manual validation code.

### OSRM Utility (`utils/osrm.py`)

Calls the OSRM public API with a 6-second timeout. Parses the GeoJSON geometry from the response and flips coordinates from `[lng, lat]` to `[lat, lng]`. Falls back to a straight line between the two input points on any error.

```
fetch_route(a, b):
  check cache → hit → return cached coords
  miss → call OSRM → parse coords → store in cache → return coords
  error → return [[a.lat, a.lng], [b.lat, b.lng]]
```

### Database (`database.py`)

SQLAlchemy is configured with SQLite for development. Three objects are exported:

- `engine` — the database connection
- `SessionLocal` — session factory (one session per request)
- `Base` — declarative base class for models

`Base.metadata.create_all(bind=engine)` in `main.py` creates tables on startup if they don't exist. For production schema changes, use Alembic migrations instead.

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

### User Model

| Field | Type | Notes |
|---|---|---|
| id | Integer | Primary key, auto-increment |
| email | String | Unique, not null |
| password | String | bcrypt hash, never plain text |
| role | String | `noc_engineer`, `planner`, `technician` |
| created_at | DateTime | UTC, set on insert |

### JWT

Tokens are signed with HS256 using a server-side secret key. The payload contains:

```json
{
  "sub": "user@example.com",
  "role": "noc_engineer",
  "exp": 1234567890
}
```

Tokens expire after 30 minutes. `verify_token` raises `JWTError` on invalid or expired tokens.

### Password Security

Passwords are hashed with bcrypt via `passlib`. Plain text passwords are never stored or logged. Verification uses `pwd_context.verify(plain, hashed)` which is timing-safe.

---

## Routing & Caching

### OSRM

The app uses the OSRM public demo server at `router.project-osrm.org`. OSRM uses Dijkstra's algorithm on OpenStreetMap road data to return the fastest driving route between two points.

The URL format is:
```
/route/v1/driving/{lng1},{lat1};{lng2},{lat2}?overview=full&geometries=geojson
```

Note: OSRM takes longitude before latitude, opposite of most mapping conventions.

### In-Memory Cache

```python
_cache = {}  # module-level, persists across requests

key = f"{a.lat},{a.lng},{b.lat},{b.lng}"

if key in _cache:
    return _cache[key]          # cache hit, no OSRM call

result = call_osrm(a, b)
_cache[key] = result            # store on success
return result
```

The cache key combines all four coordinate values. The same route requested from different directions (A→B vs B→A) produces different keys — intentional since road routes are not always reversible.

**Limitations of in-memory cache:**
- Lost on server restart
- Not shared across multiple server instances
- No eviction — grows unbounded over time

**Production upgrade path:** Replace the dict with Redis. The interface is nearly identical and Redis survives restarts and scales horizontally.

---

## Testing

### Backend Tests (pytest)

Tests use FastAPI's `TestClient` which sends requests directly to the app without a running server, making tests fast and reliable.

**Route sanity tests** use a dynamic bounding box computed from input points:

```python
min_lat = min(a["lat"], b["lat"]) - 1.0
max_lat = max(a["lat"], b["lat"]) + 1.0
min_lng = min(a["lng"], b["lng"]) - 1.0
max_lng = max(a["lng"], b["lng"]) + 1.0
```

This works for any coordinates worldwide — a test for Tokyo uses Tokyo's bounding box, not Dhaka's.

**Cache test** mocks OSRM using `unittest.mock.patch` to replace `httpx.AsyncClient` with a fake returning a valid OSRM response. After two identical requests, `call_count == 1` proves OSRM was only called once. The mock must return `{"code": "Ok"}` so the cache storage branch is reached — `InvalidUrl` would hit the fallback, bypassing the cache.

### Frontend Performance Tests (Playwright)

Playwright controls a real Chromium browser. Tests access the MapLibre map instance via `window.__map`, exposed in `NetworkMap.jsx` under `import.meta.env.DEV`.

**WebGL render tests** inject N fake devices into the `devices` GeoJSON source and measure time until the next `render` event fires:

```js
map.getSource('devices').setData({ type: 'FeatureCollection', features });
map.once('render', () => resolve(performance.now() - start));
```

**Route load test** polls all link sources until their coordinate arrays are non-empty, measuring total time from page navigation to all routes drawn.

**DOM marker test** zooms to level 14, injects 10,000 markers via `maplibregl.Marker`, and measures time until the next animation frame.

```
Results (measured):
  100 devices (WebGL):    26ms   / 100ms threshold
  1,000 devices (WebGL):  18ms   / 200ms threshold
  10,000 devices (WebGL): 85ms   / 500ms threshold
  All routes on load:     1544ms / 8000ms threshold
```

---

## Data Structures

### DEVICES

```js
{
  id: string,       // unique identifier
  name: string,     // display name for tooltip
  lat: number,      // latitude
  lng: number,      // longitude
  type: string      // 'core-router' | 'router' | 'switch' | 'edge-router' | 'server'
}
```

### LINKS

```js
{
  id: string,       // unique identifier, used as MapLibre source/layer id
  from: string,     // device id
  to: string,       // device id
  type: string,     // 'fiber' | 'copper' | 'wireless'
  color: string     // hex color for the line
}
```

### Route Response

```python
[[lat, lng], [lat, lng], ...]  # array of coordinate pairs
```

### GeoJSON Device Feature

```json
{
  "type": "Feature",
  "geometry": { "type": "Point", "coordinates": [lng, lat] },
  "properties": { "id": "core-1", "type": "core-router", "name": "Core Router Alpha" }
}
```

### GeoJSON Link Feature

```json
{
  "type": "Feature",
  "geometry": {
    "type": "LineString",
    "coordinates": [[lng, lat], [lng, lat], ...]
  }
}
```

---

## Key Design Decisions

**Why MapLibre over Leaflet?**
MapLibre uses WebGL for rendering (faster, smoother at scale) and vector tiles (more data, better styling control). Leaflet uses raster tiles — less flexible and heavier at scale. Performance tests confirm MapLibre renders 10,000 devices in 85ms.

**Why the hybrid zoom approach?**
DOM markers are draggable and support Lucide icons but break at scale. WebGL layers scale to 100,000+ devices but don't support native drag. Switching at zoom 13 (street level) gives NOC engineers a fast overview at low zoom and full interactivity when zoomed in to a specific area.

**Why FastAPI over Express or Django?**
FastAPI is async-native (important for concurrent OSRM calls), generates API docs automatically, and uses Python type hints for validation via Pydantic. Django is too heavy for a simple API layer.

**Why SQLite over PostgreSQL for auth?**
SQLite requires zero configuration for development. The ORM (SQLAlchemy) abstracts the database, so switching to PostgreSQL for production requires changing one connection string.

**Why in-memory cache over Redis?**
In-memory is zero-dependency and sufficient for a single-instance dev server. The cache interface is abstracted in `osrm.py` so swapping to Redis later is a localised change.

**Why JWT over sessions?**
JWTs are stateless — the server doesn't store session data. This makes horizontal scaling simpler and fits the REST API model well.

**Why `useRef` for the map instance?**
MapLibre manages its own DOM imperatively. React's `useState` would cause re-renders that conflict with MapLibre's internal state. `useRef` provides stable storage that persists across renders without triggering them.

**Why expose `window.__map` in DEV?**
Playwright runs in a separate browser context from the React app. Exposing the map instance on `window` under `import.meta.env.DEV` lets performance tests access MapLibre directly without modifying production code.