import maplibregl from 'maplibre-gl';
import { INFRA, STATUS_COLOR, TIER_COLOR } from './mapConstants';
import { mockStatus, getLinkStatus } from './mockStatus';
import { buildLinkPopupHTML, buildCustomerPopupHTML } from './popupTemplates';

/**
 * Adds all MapLibre sources, layers, and hover handlers to the map.
 * Called once inside map.on('load'). Returns the shared popup instance
 * so the hook can attach it to device click popups too.
 */
export function setupMapLayers(map, { liveRoutesRef, linkMapRef, devMapRef }) {
  map.addSource('main-devices', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('devices',      { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });

  // ── Route hover layer factory ──────────────────────────────────────────────
  function addRouteLayers(sourceId, prefix) {
    const layerId = `${prefix}-generic`;
    map.addLayer({ id: layerId, type: 'line', source: sourceId,
      paint: { 'line-color': 'rgba(0,0,0,0)', 'line-width': 4 } });

    map.on('mouseenter', layerId, (e) => {
      map.getCanvas().style.cursor = 'pointer';
      if (!e.features.length) return;
      const props    = e.features[0].properties;
      const linkMap  = linkMapRef.current;
      const devMap   = devMapRef.current;
      let fromName   = props.fromName;
      let toName     = props.toName;
      const actualLink = linkMap[String(props.id)];
      if (actualLink) {
        const fDev = devMap[String(actualLink.from)];
        const tDev = devMap[String(actualLink.to)];
        if (fDev) fromName = fDev.name;
        if (tDev) toName   = tDev.name;
      }
      fromName = fromName || props.from || (actualLink ? actualLink.from : 'Unknown');
      toName   = toName   || props.to   || (actualLink ? actualLink.to   : 'Unknown');
      const tier      = props.tier || 'core';
      const tierColor = TIER_COLOR[tier] || '#4f46e5';
      const tierLabel = tier[0].toUpperCase() + tier.slice(1);
      const linkStatus = getLinkStatus(mockStatus(String(props.from)), mockStatus(String(props.to)));
      const linkColor  = STATUS_COLOR[linkStatus] || '#22c55e';
      popup.setLngLat(e.lngLat)
        .setHTML(buildLinkPopupHTML({ fromName, toName, tier, tierColor, tierLabel, linkStatus, linkColor, linkId: props.id }))
        .addTo(map);
    });
    map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; popup.remove(); });
  }

  // ── Live routes ────────────────────────────────────────────────────────────
  map.addSource('live-routes', { type: 'geojson', data: liveRoutesRef.current });
  addRouteLayers('live-routes', 'live');

  map.setPaintProperty('live-generic', 'line-color',
    ['coalesce', ['get', 'statusColor'], ['get', 'tierColor'], '#4f46e5']);
  map.setPaintProperty('live-generic', 'line-width', [
    'step', ['zoom'],
    ['case', ['==', ['get', 'tier'], 'core'], 1.5, 0],
    4,  ['case', ['==', ['get', 'tier'], 'core'], 3.0, 0],
    6,  ['case', ['==', ['get', 'tier'], 'core'], 4.0, ['==', ['get', 'tier'], 'edge'], 2.0, 0],
    8,  ['case', ['==', ['get', 'tier'], 'core'], 5.0, ['==', ['get', 'tier'], 'edge'], 3.0, ['==', ['get', 'tier'], 'olt'], 1.5, 0],
    10, ['case', ['==', ['get', 'tier'], 'core'], 6.0, ['==', ['get', 'tier'], 'edge'], 4.0, ['==', ['get', 'tier'], 'olt'], 3.0, 2.0],
  ]);
  map.setPaintProperty('live-generic', 'line-opacity', [
    'step', ['zoom'],
    ['case', ['==', ['get', 'tier'], 'core'], 0.8, 0.0],
    6,  ['case', ['==', ['get', 'tier'], 'core'], 1.0, ['==', ['get', 'tier'], 'edge'], 0.9, 0.0],
    8,  ['case', ['==', ['get', 'tier'], 'core'], 1.0, ['==', ['get', 'tier'], 'edge'], 0.9, ['==', ['get', 'tier'], 'olt'], 0.8, 0.0],
    10, ['case', ['==', ['get', 'tier'], 'core'], 1.0, ['==', ['get', 'tier'], 'edge'], 0.9, ['==', ['get', 'tier'], 'olt'], 0.8, 0.0],
  ]);


  // ── Drag routes ────────────────────────────────────────────────────────────
  map.addSource('drag-routes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'drag-routes-line', type: 'line', source: 'drag-routes',
    paint: { 'line-color': '#94a3b8', 'line-width': 1.5, 'line-opacity': 0.5 } });

  // ── Customer routes ────────────────────────────────────────────────────────
  map.addSource('customer-route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'customer-route-line', type: 'line', source: 'customer-route',
    paint: {
      'line-color': ['coalesce', ['get', 'statusColor'], '#c4b5fd'],
      'line-width': 2, 'line-opacity': 0.9,
    }
  });

  map.on('mouseenter', 'customer-route-line', (e) => {
    map.getCanvas().style.cursor = 'pointer';
    if (!e.features.length) return;
    const p       = e.features[0].properties;
    const devMap  = devMapRef.current;
    const fromDev = devMap[String(p.from)];
    const toDev   = devMap[String(p.to)];
    // upstream is whichever end is infra
    const upstreamDev  = INFRA.has(fromDev?.safeType) ? fromDev : toDev;
    const customerDev  = INFRA.has(fromDev?.safeType) ? toDev   : fromDev;
    const linkStatus   = p.status || mockStatus(p.id);
    const statusColor  = STATUS_COLOR[linkStatus] || '#22c55e';
    const statusLabel  = linkStatus[0].toUpperCase() + linkStatus.slice(1);
    popup
      .setLngLat(e.lngLat)
      .setHTML(buildCustomerPopupHTML({ customerDev, upstreamDev, statusColor, statusLabel, p }))
      .addTo(map);
  });
  map.on('mouseleave', 'customer-route-line', () => {
    map.getCanvas().style.cursor = '';
    popup.remove();
  });

  // ── Path highlight ─────────────────────────────────────────────────────────
  map.addSource('path-highlight', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'path-line', type: 'line', source: 'path-highlight',
    paint: { 'line-color': ['coalesce', ['get', 'statusColor'], '#4f46e5'], 'line-width': 3.5, 'line-opacity': 1 } });

  return popup;
}