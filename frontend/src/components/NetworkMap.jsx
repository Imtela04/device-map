import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { fetchRoute } from '../utils/fetchRoute';
import Legend from './Legend';
import { createMarker } from '../utils/createMarker';

const LINK_LAYERS   = ['links-fiber', 'links-copper', 'links-wireless'];
const MARKER_ZOOM   = 12;
const LINK_ZOOM     = 11;

export default function NetworkMap() {
  const mapRef         = useRef(null);
  const mapInstanceRef = useRef(null);
  const markersRef     = useRef([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (mapInstanceRef.current) return;

    const map = new maplibregl.Map({
      container: mapRef.current,
      style: `https://api.maptiler.com/maps/streets/style.json?key=${import.meta.env.VITE_MAPTILER_KEY}`,
      center: [90.4193, 23.7269],
      zoom: 11,
    });
    mapInstanceRef.current = map;

    const alive = () => !map._removed;

    map.on('load', async () => {
      // ── 1. Load data ──────────────────────────────────────────────────────
      const [devices, links] = await Promise.all([
        fetch('http://localhost:8000/api/devices').then(r => r.json()),
        fetch('http://localhost:8000/api/links').then(r => r.json()),
      ]).catch(() => {
        setError('Failed to load network data. Is the backend running?');
        return [[], []];
      });

      if (import.meta.env.DEV) {
        window.__map = map;
        window.__linkIds = links.map(l => l.id);
        window.maplibregl = maplibregl;
      }

      // ── 2. State ──────────────────────────────────────────────────────────
      const pos = Object.fromEntries(
        devices.map(d => [d.id, { lat: d.lat, lng: d.lng }])
      );
      const linkCoords = Object.fromEntries(links.map(l => [l.id, []]));
      let rerouteTimer = null;

      // ── 3. Shared popup ───────────────────────────────────────────────────
      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });

      // ── 4. Sources ────────────────────────────────────────────────────────
      map.addSource('links', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addSource('devices', {
        type: 'geojson',
        cluster: true,
        clusterMaxZoom: MARKER_ZOOM-1,
        clusterRadius: 50,
        data: {
          type: 'FeatureCollection',
          features: devices.map(d => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [d.lng, d.lat] },
            properties: { id: d.id, type: d.type, name: d.name },
          })),
        },
      });

      // ── 5. Link layers ────────────────────────────────────────────────────
      const linkStyles = {
        fiber:    { color: '#22d3ee' },
        copper:   { color: '#f59e0b', dasharray: [6, 4] },
        wireless: { color: '#22c55e', dasharray: [3, 6] },
      };

      Object.entries(linkStyles).forEach(([type, style]) => {
        const paint = {
          'line-color': style.color,
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            10, 0.8,   // very thin at city overview
            12, 1.5,
            14, 2.5,
            16, 4,
          ],
          'line-opacity': [
            'interpolate', ['linear'], ['zoom'],
            LINK_ZOOM, 0,        // fade in from invisible
            LINK_ZOOM + 0.5, 1,  // fully visible half a zoom level later
          ],
        };

        if (style.dasharray) paint['line-dasharray'] = style.dasharray;
        map.addLayer({
          id: `links-${type}`, type: 'line', source: 'links',
          filter: ['==', ['get', 'type'], type], paint,
        });
      });

      // Highlight layer — invisible until hover sets the filter
      map.addLayer({
        id: 'links-highlight', type: 'line', source: 'links',
        filter: ['==', ['get', 'id'], ''],
        paint: { 'line-color': '#ffffff', 'line-width': 5, 'line-opacity': 0.45 },
      });

      // ── 6. Cluster layers ─────────────────────────────────────────────────
      map.addLayer({
        id: 'clusters-outer', type: 'circle', source: 'devices',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': ['step', ['get', 'point_count'],
            'rgba(34,197,94,.15)', 100, 'rgba(245,158,11,.15)', 1000, 'rgba(239,68,68,.15)'],
          'circle-radius': ['step', ['get', 'point_count'], 12, 100, 15, 1000, 18],
          'circle-stroke-width': 1,
          'circle-stroke-color': ['step', ['get', 'point_count'],
            'rgba(34,197,94,.4)', 100, 'rgba(245,158,11,.4)', 1000, 'rgba(239,68,68,.4)'],
        },
      });
      map.addLayer({
        id: 'clusters', type: 'circle', source: 'devices',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': ['step', ['get', 'point_count'],
            '#22c55e', 100, '#f59e0b', 1000, '#ef4444'],
          'circle-radius': ['step', ['get', 'point_count'], 9, 100, 12, 1000, 15],
        },
      });
      map.addLayer({
        id: 'cluster-count', type: 'symbol', source: 'devices',
        filter: ['has', 'point_count'],
        layout: {
          'text-field': '{point_count_abbreviated}', 'text-size': 11,
          'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
          'text-allow-overlap': true,
        },
        paint: { 'text-color': '#ffffff' },
      });
      map.addLayer({
        id: 'devices-circles', type: 'circle', source: 'devices',
        filter: ['!', ['has', 'point_count']],
        paint: { 'circle-radius': 0, 'circle-opacity': 0 }, // invisible; just used for hover events
      });

      // ── 7. Helpers ────────────────────────────────────────────────────────
      function buildFeatures() {
        return {
          type: 'FeatureCollection',
          features: links.map(link => ({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: linkCoords[link.id] || [] },
            properties: { id: link.id, from: link.from, to: link.to, type: link.type },
          })),
        };
      }

      function updateLinksSource() {
        if (!alive()) return;          // ← guard
        const bounds  = map.getBounds();
        const z       = map.getZoom();
        // Expand bounds a bit so lines entering the viewport aren't clipped
        const pad     = 0.05;
        const west    = bounds.getWest()  - pad;
        const east    = bounds.getEast()  + pad;
        const south   = bounds.getSouth() - pad;
        const north   = bounds.getNorth() + pad;

        const inBounds = (id) => {
          const p = pos[id];
          return p.lng >= west && p.lng <= east && p.lat >= south && p.lat <= north;
        };

        const features = links
          .filter(link => inBounds(link.from) || inBounds(link.to)) // at least one end visible
          .map(link => ({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: linkCoords[link.id] || [] },
            properties: { id: link.id, from: link.from, to: link.to, type: link.type },
          }));

        map.getSource('links').setData({ type: 'FeatureCollection', features });
      }

      function setLinksVisibility(visible) {
        const v = visible ? 'visible' : 'none';
        LINK_LAYERS.forEach(id => map.setLayoutProperty(id, 'visibility', v));
        // Always hide highlight when links are hidden
        if (!visible) map.setFilter('links-highlight', ['==', ['get', 'id'], '']);
      }

      // ── 8. Initial route load ─────────────────────────────────────────────
      async function fetchInBatches(links, batchSize = 6) {
        for (let i = 0; i < links.length; i += batchSize) {
          if (!alive()) return;        // ← stop looping if map died
          await Promise.all(
            links.slice(i, i + batchSize).map(async link => {
              const coords = await fetchRoute(pos[link.from], pos[link.to]);
              if (!alive()) return;    // ← don't write to dead linkCoords either
              linkCoords[link.id] = coords.map(([lat, lng]) => [lng, lat]);
            })
          );
          updateLinksSource(); // render progressively as batches complete
        }
        setLinksVisibility(map.getZoom() >= LINK_ZOOM);
      }

      await fetchInBatches(links);

      // ── 9. Reroute after drag ─────────────────────────────────────────────
      async function rerouteFor(deviceId) {
        clearTimeout(rerouteTimer);
        rerouteTimer = setTimeout(async () => {
          const affected = links.filter(l => l.from === deviceId || l.to === deviceId);
          await Promise.all(affected.map(async link => {
            const coords = await fetchRoute(pos[link.from], pos[link.to]);
            if (!alive()) return;
            linkCoords[link.id] = coords.map(([lat, lng]) => [lng, lat]);
          }));
          updateLinksSource();
        }, 300);
      }

      // ── 10. Marker show / hide ─────────────────────────────────────────────
      function showMarkers() {
        markersRef.current.forEach(m => m.remove());
        markersRef.current = [];

        const bounds = map.getBounds();
        devices
          .filter(d =>
            pos[d.id].lng >= bounds.getWest() && pos[d.id].lng <= bounds.getEast() &&
            pos[d.id].lat >= bounds.getSouth() && pos[d.id].lat <= bounds.getNorth()
          )
          .forEach(dev => {
            const marker = createMarker({ ...dev, ...pos[dev.id] });
            markersRef.current.push(marker);
            marker.addTo(map);

            marker.on('drag', () => {
              const { lat, lng } = marker.getLngLat();
              pos[dev.id] = { lat, lng };

              const affected = new Set(
                links.filter(l => l.from === dev.id || l.to === dev.id).map(l => l.id)
              );
              // Straight-line preview while dragging
              map.getSource('links').setData({
                type: 'FeatureCollection',
                features: links.map(link => ({
                  type: 'Feature',
                  geometry: {
                    type: 'LineString',
                    coordinates: affected.has(link.id)
                      ? [[pos[link.from].lng, pos[link.from].lat], [pos[link.to].lng, pos[link.to].lat]]
                      : linkCoords[link.id] || [],
                  },
                  properties: { id: link.id, from: link.from, to: link.to, type: link.type },
                })),
              });
            });

            marker.on('dragend', () => rerouteFor(dev.id));
          });

        ['clusters', 'cluster-count', 'devices-circles', 'clusters-outer']
          .forEach(id => map.setLayoutProperty(id, 'visibility', 'none'));
      }

      function hideMarkers() {
        markersRef.current.forEach(m => m.remove());
        markersRef.current = [];
        ['clusters', 'cluster-count', 'devices-circles', 'clusters-outer']
          .forEach(id => map.setLayoutProperty(id, 'visibility', 'visible'));
      }

      // ── 11. Link hover ─────────────────────────────────────────────────────
      LINK_LAYERS.forEach(layerId => {
        map.on('mouseenter', layerId, e => {
          map.getCanvas().style.cursor = 'pointer';
          const { id, from, to, type } = e.features[0].properties;
          map.setFilter('links-highlight', ['==', ['get', 'id'], id]);

          const fromName = devices.find(d => d.id === from)?.name ?? from;
          const toName   = devices.find(d => d.id === to)?.name ?? to;
          popup
            .setLngLat(e.lngLat)
            .setHTML(`<strong>${fromName} → ${toName}</strong><br/><span style="text-transform:capitalize">${type}</span>`)
            .addTo(map);
        });

        map.on('mousemove', layerId, e => popup.setLngLat(e.lngLat));

        map.on('mouseleave', layerId, () => {
          map.getCanvas().style.cursor = '';
          map.setFilter('links-highlight', ['==', ['get', 'id'], '']);
          popup.remove();
        });
      });

      // ── 12. Device hover ───────────────────────────────────────────────────
      map.on('mouseenter', 'devices-circles', e => {
        map.getCanvas().style.cursor = 'pointer';
        const { name, type } = e.features[0].properties;
        popup.setLngLat(e.lngLat)
          .setHTML(`<strong>${name}</strong><br/><span>${type}</span>`)
          .addTo(map);
      });
      map.on('mouseleave', 'devices-circles', () => {
        map.getCanvas().style.cursor = '';
        popup.remove();
      });

      // ── 13. Zoom / pan events ─────────────────────────────────────────────
      map.on('zoomend', () => {
        const z = map.getZoom();
        z >= MARKER_ZOOM ? showMarkers() : hideMarkers();
        setLinksVisibility(z >= LINK_ZOOM);
      });

      map.on('moveend', () => {
        const z = map.getZoom();
        z >= MARKER_ZOOM ? showMarkers() : hideMarkers();
        if (z >= LINK_ZOOM) updateLinksSource(); // re-filter to new viewport
      });

      // ── 14. Cluster click ─────────────────────────────────────────────────
      map.on('click', 'clusters', async (e) => {
        if (map.getLayoutProperty('clusters', 'visibility') === 'none') return;
        const features = map.queryRenderedFeatures(e.point, { layers: ['clusters'] });
        if (!features.length) return;
        const zoom = await map.getSource('devices')
          .getClusterExpansionZoom(features[0].properties.cluster_id);
        map.easeTo({ center: features[0].geometry.coordinates, zoom });
      });
      map.on('mouseenter', 'clusters-outer', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'clusters-outer', () => { map.getCanvas().style.cursor = ''; });

      // Set initial marker visibility
      hideMarkers();
    });

    map.on('styleimagemissing', (e) => {
      // Create a 1x1 transparent placeholder so MapLibre stops complaining
      const empty = { width: 1, height: 1, data: new Uint8Array(4) };
      map.addImage(e.id, empty);
    });

    return () => {
      map.remove();
      mapInstanceRef.current = null;
    };
  }, []);

  return (
    <div className="relative">
      <div ref={mapRef} style={{ height: '100vh', width: '100%' }} />
      <Legend />
      {error && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-red-500 text-white px-4 py-2 rounded shadow z-[99999]">
          {error}
        </div>
      )}
    </div>
  );
}