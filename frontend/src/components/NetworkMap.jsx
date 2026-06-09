import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { createMarker } from '../utils/createMarker'; 
import { loadDeviceIcons } from '../utils/iconSprite';
import { fetchRoute } from '../utils/fetchRoute';
import { toGeoJSON } from '../utils/toGeoJSON';
import Legend from './Legend';

export default function NetworkMap() {
  const mapRef                        = useRef(null);
  const mapInstanceRef                = useRef(null);
  const activeMarkersRef              = useRef(new Map()); 
  const liveRouteUpdateTimeout        = useRef(null);

  const modifiedRouteIdsRef           = useRef(new Set());
  const liveRoutesRef                 = useRef({ type: 'FeatureCollection', features: [] });
  const focusedDeviceIdRef            = useRef(null);
  const fetchedRouteIdsRef            = useRef(new Set());
  const mainDevicesRef                = useRef([]);
  const [stats, setStats]             = useState({ total: 0, online: 0, degraded: 0, down: 0 });
  const searchRef                     = useRef(null);
  const showMarkersRef                = useRef(null);  
  const devMapRef                     = useRef({});    


  // Helper Set to identify Infrastructure vs Customers
  const INFRA = new Set(['core-router', 'router', 'edge-router', 'olt', 'server', 'switch']);

  useEffect(() => {
    if (mapInstanceRef.current) return;

    let protocol = new Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile);

    const map = new maplibregl.Map({
      container: mapRef.current,
      style: `https://api.maptiler.com/maps/streets/style.json?key=B2aWdlpiBBhi0n5jeueG`,
      center: [90.4193, 23.7269], 
      zoom: 11
    });

    mapInstanceRef.current = map;
    if (import.meta.env.DEV) {
      window.__map = map;
      window.maplibregl = maplibregl;
    }

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    map.on('styleimagemissing', (e) => {
        map.addImage(e.id, new ImageData(1, 1));
    });

    map.on('load', async () => {
      function mockStatus(id) {
        const n = String(id).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
        return ['online','online','online','online','online','online','degraded','degraded','down','down'][n % 10];
      }

      await loadDeviceIcons(map);
      const toGeoJSONFeature = (device) => {
        let renderType = 'Access';
        const t = (device.type || '').toLowerCase();
        if (t.includes('core')) renderType = 'Core Router';
        else if (t.includes('edge')) renderType = 'Edge Router';
        else if (t.includes('olt')) renderType = 'OLT';

        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [device.lng, device.lat] },
          properties: { ...device, renderType, id: String(device.id) } 
        };
      };

      const [apiDevices, rawLinks, dbRoutes] = await Promise.all([
        fetch('http://localhost:8000/api/devices').then(r => r.json()),
        fetch('http://localhost:8000/api/links').then(r => r.json()),
        fetch('http://localhost:8000/api/routes/geojson').then(r => r.json()).catch(() => null)
      ]);

      const links = rawLinks.map(l => ({ ...l, id: `${l.from}-${l.to}` }));

      const devices = apiDevices.map(d => {
        const t = (d.type || '').toLowerCase();
        let safeType = 'access';
        if (t.includes('core')) safeType = 'core-router';
        else if (t.includes('edge')) safeType = 'edge-router';
        else if (t.includes('olt')) safeType = 'olt';
        else if (t.includes('server')) safeType = 'server';
        else if (t.includes('switch')) safeType = 'switch';
        else if (t === 'router') safeType = 'router';
        return { ...d, safeType }; 
      });

      if (dbRoutes?.features?.length) {
        liveRoutesRef.current.features = dbRoutes.features.map(f => ({
          type: 'Feature',
          properties: {
            id: String(f.properties.id),
            type: f.properties.type || 'generic',
            from: String(f.properties.from),
            to: String(f.properties.to),
            fromName: f.properties.fromName,
            toName: f.properties.toName,
          },
          geometry: f.geometry,
        }));
        dbRoutes.features.forEach(f => {
          const id = String(f.properties.id);
          fetchedRouteIdsRef.current.add(id);
          modifiedRouteIdsRef.current.add(id); 
        });
      }

      const devMap = {};
      const linkMap = {};
      const ObjectLinksByDevice = {};
      
      devices.forEach(d => {
        const strId = String(d.id);
        devMap[strId] = d;
        devMapRef.current = devMap; 
        ObjectLinksByDevice[strId] = [];
      });

      links.forEach(l => {
        linkMap[String(l.id)] = l;
        const fromId = String(l.from);
        const toId = String(l.to);
        if (!ObjectLinksByDevice[fromId]) ObjectLinksByDevice[fromId] = [];
        if (!ObjectLinksByDevice[toId]) ObjectLinksByDevice[toId] = [];
        ObjectLinksByDevice[fromId].push(l);
        ObjectLinksByDevice[toId].push(l);
      });
      
      const statuses = links.map(l => mockStatus(l.id));
      setStats({
        total: links.length,
        online:   statuses.filter(s => s === 'online').length,
        degraded: statuses.filter(s => s === 'degraded').length,
        down:     statuses.filter(s => s === 'down').length,
      });

      const accessDevices = [];
      mainDevicesRef.current = []; 
      
      devices.forEach(d => {
        if (INFRA.has(d.safeType)) {
          mainDevicesRef.current.push(d);
        } else {
          accessDevices.push(d);
        }
      });
      
      map.addSource('devices', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: accessDevices.map(toGeoJSONFeature) }
      });


      map.addSource('main-devices', {
        type: 'geojson', cluster: true, clusterMaxZoom: 9, clusterRadius: 35,
        data: { type: 'FeatureCollection', features: mainDevicesRef.current.map(toGeoJSONFeature) }
      });

      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
      
      const addRouteLayers = (sourceId, prefix, sourceLayer = null) => {
        const layerId = `${prefix}-generic`;
        const layerConfig = {
          id: layerId, 
          type: 'line', 
          source: sourceId, 
          minzoom: 10, 
          paint: { 'line-color': 'rgba(0,0,0,0)', 'line-width': 4 }
        };
        if (sourceLayer) layerConfig['source-layer'] = sourceLayer;

        map.addLayer(layerConfig);

        map.on('mouseenter', layerId, (e) => {
          map.getCanvas().style.cursor = 'pointer';
          if (e.features.length > 0) {
            const props = e.features[0].properties;
            let fromName = props.fromName;
            let toName = props.toName;
            
            const actualLink = linkMap[String(props.id)];
            if (actualLink) {
              const fDev = devMap[String(actualLink.from)];
              const tDev = devMap[String(actualLink.to)];
              if (fDev) fromName = fDev.name;
              if (tDev) toName = tDev.name;
            }

            fromName = fromName || props.from || (actualLink ? actualLink.from : 'Unknown');
            toName = toName || props.to || (actualLink ? actualLink.to : 'Unknown');

            popup.setLngLat(e.lngLat).setHTML(
              `<div style="padding: 4px;">
                <strong>Link Data</strong><br/>
                <span style="font-size: 0.9em; color: #555;">From: ${fromName}</span><br/>
                <span style="font-size: 0.9em; color: #555;">To: ${toName}</span>
              </div>`
            ).addTo(map);
          }
        });
        
        map.on('mouseleave', layerId, () => {
          map.getCanvas().style.cursor = '';
          popup.remove();
        });
      };
      
      if (!map.getSource('live-routes')) {
          map.addSource('live-routes', { type: 'geojson', data: liveRoutesRef.current });
      }
      if (!map.getSource('drag-routes')) {
          map.addSource('drag-routes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
          map.addLayer({
            id: 'drag-routes-line', type: 'line', source: 'drag-routes',
            paint: { 'line-color': '#94a3b8', 'line-width': 1.5, 'line-opacity': 0.5 } 
          });
      }

      addRouteLayers('live-routes', 'live');

      map.setPaintProperty('live-generic', 'line-color',
        ['coalesce', ['get', 'statusColor'], ['get', 'tierColor'], '#4f46e5']
      );

      map.setPaintProperty('live-generic', 'line-width', [
        'case',
        ['==', ['get', 'tier'], 'core'], 6.0,
        ['==', ['get', 'tier'], 'edge'], 4.0,
        ['==', ['get', 'tier'], 'olt'],  3.0,
        2.0 // Fallback for access/customers
      ]);

      map.setPaintProperty('live-generic', 'line-opacity', [
        'case',
        ['==', ['get', 'tier'], 'core'], 1.0,
        ['==', ['get', 'tier'], 'edge'], 0.9,
        ['==', ['get', 'tier'], 'olt'],  0.8,
        0.8 // Fallback for access/customers
      ]);
      
      map.addLayer({
        id: 'live-generic-glow',
        type: 'line',
        source: 'live-routes',
        minzoom: 10,
        paint: {
          'line-color': ['coalesce', ['get', 'tierColor'], '#4f46e5'],
          'line-width': 12,
          'line-opacity': 0.18,
          'line-blur': 8,
        }
      }, 'live-generic');


      // path-highlight: two-layer glow + solid status-coloured line
      map.addSource('path-highlight', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'path-glow', type: 'line', source: 'path-highlight',
        paint: { 'line-color': '#ffffff', 'line-width': 14, 'line-opacity': 0.18, 'line-blur': 8 }
      });
      map.addLayer({
        id: 'path-line', type: 'line', source: 'path-highlight',
        paint: { 'line-color': ['coalesce', ['get', 'statusColor'], '#4f46e5'], 'line-width': 3.5, 'line-opacity': 1 }
      });

      // --- VISUAL HIERARCHY FOR CUSTOMER DOTS ---
      map.addLayer({
        id: 'unclustered-devices',
        type: 'circle',
        source: 'devices',
        minzoom: 13,
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': '#f63bbe',
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 3, 16, 5],
          'circle-stroke-width': 1,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.6, 15, 0.9]
        }
      });
      
      map.on('click', 'unclustered-devices', (e) => {
          const featureId = e.features[0].properties.id; 
          popup.remove();
          focusedDeviceIdRef.current = featureId;
          showMarkers(); 
          showUpstreamPath(featureId);
          
          const dev = devMap[String(featureId)];
          if (dev) showStatsPopup(dev);
      });      

      map.on('click', 'unclustered-main-devices', (e) => {
        const featureId = e.features[0].properties.id;
        const coords = e.features[0].geometry.coordinates.slice();
        const dev = devMap[String(featureId)];

        popup.remove();
        focusedDeviceIdRef.current = featureId;

        map.easeTo({ center: coords, zoom: Math.max(map.getZoom(), 13) });

        map.once('moveend', () => {
          showMarkers();               
          showUpstreamPath(featureId);   
          if (dev) showStatsPopup(dev);
        });
      });
      map.on('mouseenter', 'unclustered-main-devices', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'unclustered-main-devices', () => { map.getCanvas().style.cursor = ''; });
  
      map.addLayer({
        id: 'main-clusters', type: 'circle', source: 'main-devices', filter: ['has', 'point_count'],
        paint: { 'circle-color': '#7c3aed', 'circle-radius': ['step', ['get', 'point_count'], 13, 10, 17, 50, 21], 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' },
      });
      map.addLayer({
        id: 'main-cluster-count', type: 'symbol', source: 'main-devices', filter: ['has', 'point_count'],
        layout: { 'text-field': '{point_count_abbreviated}', 'text-size': 11, 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'] },
        paint: { 'text-color': '#ffffff' },
      });
      
      map.addLayer({
        id: 'unclustered-main-devices', type: 'symbol', source: 'main-devices', filter: ['!', ['has', 'point_count']],
        layout: {
          'icon-image': ['get', 'safeType'],
          'icon-size': 1.0, 'icon-allow-overlap': true, 'icon-ignore-placement': true,
          'text-field': ['get', 'name'], 'text-offset': [0, 1.6], 'text-size': 10, 'text-optional': true, 'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        },
        paint: { 'text-color': '#1e293b', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
      });

      function showStatsPopup(dev) {
        let statsHtml = '';
        const connectedLinks = ObjectLinksByDevice[String(dev.id)] || [];

        if (dev.safeType === 'olt') {
          const customerCount = Math.max(0, connectedLinks.length - 1);
          statsHtml = `
            <div style="display:flex; justify-content:space-between; margin-top:6px; font-size:12px;">
              <span style="color:#64748b;">Downstream ONTs:</span>
              <strong style="color:#10b981;">${customerCount} Units</strong>
            </div>
            <div style="display:flex; justify-content:space-between; margin-top:4px; font-size:12px;">
              <span style="color:#64748b;">Uplink Port:</span>
              <strong style="color:#3b82f6;">10G SFP+</strong>
            </div>`;
        } else if (dev.safeType === 'edge-router') {
          const oltCount = connectedLinks.filter(l => devMap[String(l.to)]?.safeType === 'olt' || devMap[String(l.from)]?.safeType === 'olt').length;
          statsHtml = `
            <div style="display:flex; justify-content:space-between; margin-top:6px; font-size:12px;">
              <span style="color:#64748b;">Subtended OLTs:</span>
              <strong style="color:#2563eb;">${oltCount} Active Hubs</strong>
            </div>
            <div style="display:flex; justify-content:space-between; margin-top:4px; font-size:12px;">
              <span style="color:#64748b;">Core Link:</span>
              <strong style="color:#10b981;">100G Primary</strong>
            </div>`;
        } else if (dev.safeType === 'core-router') {
          statsHtml = `
            <div style="display:flex; justify-content:space-between; margin-top:6px; font-size:12px;">
              <span style="color:#64748b;">Mesh Topology:</span>
              <strong style="color:#9333ea;">Active Backbone</strong>
            </div>
            <div style="display:flex; justify-content:space-between; margin-top:4px; font-size:12px;">
              <span style="color:#64748b;">Path Redundancy:</span>
              <strong style="color:#10b981;">Active / Active</strong>
            </div>`;
        } else {
          statsHtml = `
            <div style="display:flex; justify-content:space-between; margin-top:6px; font-size:12px;">
              <span style="color:#64748b;">Connection:</span>
              <strong style="color:#10b981;">Online</strong>
            </div>
            <div style="display:flex; justify-content:space-between; margin-top:4px; font-size:12px;">
              <span style="color:#64748b;">Plan:</span>
              <strong style="color:#3b82f6;">1 Gbps Fiber</strong>
            </div>`;
        }

        new maplibregl.Popup({ offset: 25, closeButton: true, closeOnClick: true })
          .setLngLat([dev.lng, dev.lat])
          .setHTML(`
            <div style="font-family: system-ui, sans-serif; padding: 4px; min-width: 180px;">
              <h4 style="margin: 0; font-size: 14px; color: #1e293b;">${dev.name}</h4>
              <p style="margin: 2px 0 8px 0; font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em;">
                ${(dev.type || '').replace('-', ' ')}
              </p>
              <div style="padding-top: 6px; border-top: 1px solid #e2e8f0;">
                ${statsHtml}
              </div>
            </div>
          `)
          .addTo(map);
      }

      const TIER = { access: 0, olt: 1, 'edge-router': 2, 'core-router': 3 };

      // Single source of truth for all route colours.
      // TIER_COLOR = base colour showing network hierarchy on a healthy network.
      // STATUS_COLOR = null means "healthy → fall back to tier colour".
      //   Amber/red only appear when something is actually wrong, so alerts stand out.
      const TIER_COLOR = {
        core:   '#4f46e5',  // indigo     – national backbone
        edge:   '#0891b2',  // cyan       – regional gateways
        olt:    '#7c3aed',  // violet     – neighbourhood aggregators
        access: '#c4b5fd',  // violet-300 – last-mile access / customers
      };
      const STATUS_COLOR = {
        online:   null,        // healthy → use TIER_COLOR[tier]
        degraded: '#f59e0b',   // amber
        down:     '#ef4444',   // red
      };
      if (liveRoutesRef.current.features.length) {
        liveRoutesRef.current.features = liveRoutesRef.current.features.map(f => {
          const fromType = devMap[String(f.properties.from)]?.safeType || '';
          const toType   = devMap[String(f.properties.to)]?.safeType   || '';
          const tier =
            fromType === 'core-router' || toType === 'core-router' ? 'core'
            : fromType === 'edge-router' || toType === 'edge-router' ? 'edge'
            : fromType === 'olt'         || toType === 'olt'         ? 'olt'
            : 'access';
          return {
            ...f,
            properties: {
              ...f.properties,
              isInfra:     INFRA.has(fromType) || INFRA.has(toType),
              tier,
              tierColor:   TIER_COLOR[tier],
              statusColor: STATUS_COLOR[mockStatus(f.properties.id)] ?? TIER_COLOR[tier],
            }
          };
        });
      }

      function getUpstreamPath(startId) {
        const linkIds = [], deviceIds = [];
        let cur = String(startId);
        for (let i = 0; i < 10; i++) {
          const dev = devMap[cur];
          if (!dev) break;
          const tier = TIER[dev.safeType] ?? -1;
          deviceIds.push(cur);
          if (tier >= 3 || tier < 0) break;
          const upLink = (ObjectLinksByDevice[cur] || []).find(l => {
            const otherId = String(l.from) === cur ? String(l.to) : String(l.from);
            return (TIER[devMap[otherId]?.safeType] ?? -1) > tier;
          });
          if (!upLink) break;
          linkIds.push(String(upLink.id));
          cur = String(upLink.from) === cur ? String(upLink.to) : String(upLink.from);
        }
        return { linkIds, deviceIds };
      }

      function showUpstreamPath(deviceId) {
        const { linkIds } = getUpstreamPath(deviceId);
        const features = linkIds.map(lid => {
          const color = STATUS_COLOR[mockStatus(lid)];
          const existing = liveRoutesRef.current.features.find(f => String(f.properties.id) === lid);
          if (existing) {
            const safeColor = STATUS_COLOR[mockStatus(lid)] ?? (existing.properties.tierColor || '#4f46e5');
            return { ...existing, properties: { ...existing.properties, statusColor: safeColor } };
          }

          const link = linkMap[lid];
          if (!link) return null;
          const from = devMap[String(link.from)], to = devMap[String(link.to)];
          if (!from || !to) return null;
          const fType  = devMap[String(link.from)]?.safeType || '';
          const tType  = devMap[String(link.to)]?.safeType   || '';
          const tier   =
            fType === 'core-router' || tType === 'core-router' ? 'core'
            : fType === 'edge-router' || tType === 'edge-router' ? 'edge'
            : fType === 'olt'         || tType === 'olt'         ? 'olt'
            : 'access';
          const tColor = TIER_COLOR[tier];
          return {
            type: 'Feature',
            properties: {
              id: lid,
              tier,
              tierColor:   tColor,
              statusColor: STATUS_COLOR[mockStatus(lid)] ?? tColor,
            },
            geometry: { type: 'LineString', coordinates: [[from.lng, from.lat], [to.lng, to.lat]] }
          };
        }).filter(Boolean);
        map.getSource('path-highlight')?.setData({ type: 'FeatureCollection', features });
      }

      function clearUpstreamPath() {
        map.getSource('path-highlight')?.setData({ type: 'FeatureCollection', features: [] });
      }

      function queueLiveRouteUpdate() {
        if (liveRouteUpdateTimeout.current) return;
        liveRouteUpdateTimeout.current = setTimeout(() => {
            if (mapInstanceRef.current && mapInstanceRef.current.getSource('live-routes')) {
                mapInstanceRef.current.getSource('live-routes').setData(liveRoutesRef.current);
            }
            liveRouteUpdateTimeout.current = null;
        }, 32); 
      }

      function updateLiveRouteInMap(linkId, linkType, coordinates, props = {}) {
        const safeId = String(linkId);
        fetchedRouteIdsRef.current.add(safeId); 
        const features = liveRoutesRef.current.features.filter(f => String(f.properties.id) !== safeId);
        features.push({
          type: 'Feature',
          properties: (() => {
            const fType = devMap[String(props.from)]?.safeType || '';
            const tType = devMap[String(props.to)]?.safeType   || '';
            const tier =
              fType === 'core-router' || tType === 'core-router' ? 'core'
              : fType === 'edge-router' || tType === 'edge-router' ? 'edge'
              : fType === 'olt'         || tType === 'olt'         ? 'olt'
              : 'access';
            return {
              id: safeId, type: linkType, ...props,
              from: String(props.from), to: String(props.to),
              tier,
              tierColor:   TIER_COLOR[tier],
              statusColor: STATUS_COLOR[mockStatus(safeId)] ?? TIER_COLOR[tier],
            };
          })(),
          geometry: { type: 'LineString', coordinates }
        });

        liveRoutesRef.current.features = features;
        queueLiveRouteUpdate();
        modifiedRouteIdsRef.current.add(safeId);
      }

      function updateAllDeviceSources() {
        const accessFeatures = [];
        const mainFeatures = [];
        Object.values(devMapRef.current).forEach(d => {
          if (INFRA.has(d.safeType)) {
            mainFeatures.push(toGeoJSONFeature(d));
          } else {
            accessFeatures.push(toGeoJSONFeature(d));
          }
        });
        if (map.getSource('devices')) {
          map.getSource('devices').setData({ type: 'FeatureCollection', features: accessFeatures });
        }
        if (map.getSource('main-devices')) {
          map.getSource('main-devices').setData({ type: 'FeatureCollection', features: mainFeatures });
        }
      }
      function refreshFilters() {
        const focusId = focusedDeviceIdRef.current;
        const focusedDev = focusId ? devMapRef.current[String(focusId)] : null;
        const isFocusInfra = focusedDev ? INFRA.has(focusedDev.safeType) : false;

        let liveFilter = ['==', ['get', 'isInfra'], true];

        if (focusId && !isFocusInfra) {
          const customerLinkIds = (ObjectLinksByDevice[String(focusId)] || []).map(l => String(l.id));
          liveFilter = [
            'any',
            ['==', ['get', 'isInfra'], true],
            ['in', ['to-string', ['get', 'id']], ['literal', customerLinkIds]]
          ];
        }

        if (map.getLayer('live-generic')) map.setFilter('live-generic', liveFilter);
        if (map.getLayer('live-generic-glow')) map.setFilter('live-generic-glow', liveFilter);

        if (focusId) {
          if (map.getLayer('unclustered-main-devices')) {
            map.setFilter('unclustered-main-devices', ['!=', ['to-string', ['get', 'id']], String(focusId)]);
          }
          if (map.getLayer('unclustered-devices')) {
            map.setFilter('unclustered-devices', ['all', ['!', ['has', 'point_count']], ['!=', ['to-string', ['get', 'id']], String(focusId)]]);
          }
        } else {
          if (map.getLayer('unclustered-main-devices')) map.setFilter('unclustered-main-devices', null);
          if (map.getLayer('unclustered-devices')) map.setFilter('unclustered-devices', ['!', ['has', 'point_count']]);
        }
      }

      function showMarkers() {
        const bounds = map.getBounds();
        const focusId = focusedDeviceIdRef.current;
        let devicesToRender = [];

        if (focusId) {
          const connectedLinks = ObjectLinksByDevice[String(focusId)] || [];
          const neighborIds = new Set(
            connectedLinks.map(l => String(l.from) === String(focusId) ? String(l.to) : String(l.from))
          );
          neighborIds.add(String(focusId));
          devicesToRender = devices.filter(d => neighborIds.has(String(d.id)));
        } else {
          devicesToRender = mainDevicesRef.current.filter(dev =>
            dev.lng >= bounds.getWest() && dev.lng <= bounds.getEast() &&
            dev.lat >= bounds.getSouth() && dev.lat <= bounds.getNorth()
          );
        }
        
        ['links-generic', 'live-generic', 'live-generic-glow'].forEach(id => {
          if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible');
        });

        if (map.getLayer('unclustered-main-devices')) {
          map.setLayoutProperty('unclustered-main-devices', 'visibility', 'none');
        }


        const visibleIds = new Set(devicesToRender.map(d => String(d.id)));

        // 1. Cleanup off-screen markers or unfocused customers
        for (const [id, marker] of activeMarkersRef.current.entries()) {
            const isInfra = INFRA.has(devMap[id]?.safeType || '');
            const isFocused = id === String(focusedDeviceIdRef.current);
            if (!visibleIds.has(id) || (!isInfra && !isFocused)) {
                marker.remove();
                activeMarkersRef.current.delete(id);
            }
        }

        // 2. Generate HTML markers AND assign all drag logic in ONE unified loop
        devicesToRender.forEach(dev => {
          const strId = String(dev.id);
          const isInfra = INFRA.has(dev.safeType);
          const isFocused = strId === String(focusedDeviceIdRef.current);
          
          if (!isInfra && !isFocused) return; 
          
          if (!activeMarkersRef.current.has(strId)) {
            const marker = createMarker(dev, map);  
            const status = mockStatus(dev.id);
            const el = marker.getElement();
            
            el.classList.remove('marker-status-down', 'marker-status-degraded');
            if (status === 'down')     el.classList.add('marker-status-down');
            if (status === 'degraded') el.classList.add('marker-status-degraded');
            
            marker.addTo(map);
            activeMarkersRef.current.set(strId, marker);

            marker.getElement().addEventListener('click', (e) => {
              e.stopPropagation();
              focusedDeviceIdRef.current = dev.id;
              showMarkers(); 
              showStatsPopup(dev); 
            });

            marker.on('dragstart', () => {
               const affected = ObjectLinksByDevice[strId] || [];
               affected.forEach(l => modifiedRouteIdsRef.current.add(String(l.id)));
               refreshFilters(); 
            });

            marker.on('drag', () => {
              const coords = marker.getLngLat();
              dev.lng = coords.lng; dev.lat = coords.lat;
              if (INFRA.has(dev.safeType)) {
                updateAllDeviceSources();
                refreshFilters();
              }

              const affected = ObjectLinksByDevice[strId] || [];
              const dragFeatures = [];

              affected.forEach(link => {
                const isFrom = String(link.from) === strId;
                const otherDevId = isFrom ? String(link.to) : String(link.from);
                const otherDev = devMap[otherDevId];
                
                if (otherDev) {
                  const isOtherDevInfra = INFRA.has(otherDev.safeType);
                  const isThisDevInfra = INFRA.has(dev.safeType);

                  if ((isThisDevInfra && isOtherDevInfra) || affected.length < 15) {
                      dragFeatures.push({
                        type: 'Feature', properties: { id: link.id },
                        geometry: { type: 'LineString', coordinates: isFrom ? [[coords.lng, coords.lat], [otherDev.lng, otherDev.lat]] : [[otherDev.lng, otherDev.lat], [coords.lng, coords.lat]] }
                      });
                  }
                }
              });
              
              map.getSource('drag-routes').setData({ type: 'FeatureCollection', features: dragFeatures });
            });

            marker.on('dragend', async () => {
              const coords = marker.getLngLat();
              dev.lng = coords.lng; dev.lat = coords.lat;

              const allConnections = ObjectLinksByDevice[strId] || [];

              // Clear the temporary red dragging line
              map.getSource('drag-routes').setData({ type: 'FeatureCollection', features: [] });

              // Loop through ALL connections (both Infra and Customers)
              await Promise.all(allConnections.map(async (link) => {
                try {
                  const isFrom = String(link.from) === strId;
                  const otherDevId = isFrom ? String(link.to) : String(link.from);
                  const otherDev = devMap[otherDevId];
                  if (!otherDev) return;

                  const isOtherInfra = INFRA.has(otherDev.safeType);
                  const isThisInfra = INFRA.has(dev.safeType);
                  const hyphenatedId = `${link.from}-${link.to}`;

                  // 1. Immediately update the map with a straight line to the new coordinates
                  // This fixes the "ghost routes" by snapping all lines immediately
                  updateLiveRouteInMap(link.id, link.type || 'generic',
                      isFrom ? [[dev.lng, dev.lat], [otherDev.lng, otherDev.lat]] : [[otherDev.lng, otherDev.lat], [dev.lng, dev.lat]],
                      { from: link.from, to: link.to, fromName: dev.name, toName: otherDev.name, isInfra: isThisInfra || isOtherInfra }
                  );

                  // 2. If BOTH ends are infrastructure, fetch the real street route from backend
                  if (isThisInfra && isOtherInfra) {
                      const routeResponse = await fetchRoute(
                        { lat: dev.lat, lng: dev.lng },
                        { lat: otherDev.lat, lng: otherDev.lng },
                        { link_id: hyphenatedId, link_type: link.type || 'generic' }
                      );
                      updateLiveRouteInMap(link.id, link.type || 'generic',
                        toGeoJSON(routeResponse).geometry.coordinates,
                        { from: link.from, to: link.to, fromName: dev.name, toName: otherDev.name, isInfra: true }
                      );
                  }
                } catch (err) {
                  console.error("Failed routing link:", link.id, err);
                }
              }));

              // 3. Update the MapLibre Sources so the underlying WebGL dots actually move
              updateAllDeviceSources();
              refreshFilters();

              // 4. Save to Database
              fetch(`http://localhost:8000/api/devices/${dev.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ lng: coords.lng, lat: coords.lat })
              }).catch(console.error);
            });
          }
        });

        // 3. Batch Initial OSRM loading for visible infra on Pan
        const seenLinkIds = new Set();
        const candidates = [];
        for (const id of visibleIds) {
          for (const link of (ObjectLinksByDevice[id] || [])) {
            const lid = String(link.id);
            if (!seenLinkIds.has(lid) && !fetchedRouteIdsRef.current.has(lid)) {
              seenLinkIds.add(lid);
              candidates.push(link);
            }
          }
        }

        const infraLinks = candidates.filter(l => {
            const fType = (devMap[String(l.from)]?.type || '').toLowerCase();
            const tType = (devMap[String(l.to)]?.type || '').toLowerCase();
            return INFRA.has(fType) || INFRA.has(tType);
        }).slice(0, 20); 

        if (infraLinks.length) {
          infraLinks.forEach(l => fetchedRouteIdsRef.current.add(String(l.id)));
          Promise.all(infraLinks.map(async (link) => {
            const from = devMap[String(link.from)], to = devMap[String(link.to)];
            if (!from || !to) return;
            try {
              const res = await fetch('http://localhost:8000/api/route', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                // Use the correct hyphenated format for initialization too
                body: JSON.stringify({ a: { lat: from.lat, lng: from.lng }, b: { lat: to.lat, lng: to.lng }, link_id: `${link.from}-${link.to}`, link_type: link.type || 'generic' }),
              });
              if (!res.ok) throw new Error(res.status);
              const coords = await res.json();
              updateLiveRouteInMap(link.id, link.type || 'generic', coords.map(([lat, lng]) => [lng, lat]),
                { from: link.from, to: link.to, fromName: from.name, toName: to.name, isInfra: true });
            } catch { 
              updateLiveRouteInMap(link.id, 'generic', [[from.lng, from.lat], [to.lng, to.lat]],
                    { from: link.from, to: link.to, fromName: from.name, toName: to.name, isInfra: true }); 
            }
          })).then(() => refreshFilters());
        }
      }

      showMarkersRef.current = showMarkers;

      function hideMarkers() {
        for (const marker of activeMarkersRef.current.values()) {
            marker.remove();
        }
        activeMarkersRef.current.clear();
        focusedDeviceIdRef.current = null; 

      ['main-clusters', 'main-cluster-count', 'unclustered-main-devices']
        .forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible'); });
        if (map.getLayer('unclustered-main-devices')) map.setFilter('unclustered-main-devices', null);
        if (map.getLayer('unclustered-devices')) map.setFilter('unclustered-devices', ['!', ['has', 'point_count']]);
      }      

      hideMarkers();
      clearUpstreamPath();

      let _showMarkersTimer = null;
      const debouncedShowMarkers = () => {
        clearTimeout(_showMarkersTimer);
        _showMarkersTimer = setTimeout(showMarkers, 120);
      };

      map.on('moveend', () => { if (map.getZoom() >= 12) debouncedShowMarkers(); });
      map.on('zoomend', () => { map.getZoom() >= 12 ? debouncedShowMarkers() : hideMarkers(); });

      map.on('click', (e) => {
        const interactiveLayers = ['unclustered-main-devices', 'main-clusters', 'unclustered-devices'];
        const activeLayers = interactiveLayers.filter(l => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none');
        
        if (activeLayers.length > 0) {
          const features = map.queryRenderedFeatures(e.point, { layers: activeLayers });
          if (features.length > 0) return; 
        }

        if (e.originalEvent.target.tagName.toLowerCase() !== 'canvas') return;
        
        focusedDeviceIdRef.current = null;
        clearUpstreamPath();
        if (map.getZoom() >= 12) { showMarkers(); } 
        else { hideMarkers(); }
      });

      map.on('click', 'main-clusters', async (e) => {
        const features = map.queryRenderedFeatures(e.point, { layers: ['main-clusters'] });
        const clusterId = features[0].properties.cluster_id;
        const zoom = await map.getSource('main-devices').getClusterExpansionZoom(clusterId);
        map.easeTo({ center: features[0].geometry.coordinates, zoom });
      });

      map.on('mouseenter', 'main-clusters', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'main-clusters', () => { map.getCanvas().style.cursor = ''; });

    });   
    
    const handleSearch = (e) => {
      if (e.key !== 'Enter') return;
      const q = e.target.value.trim().toLowerCase();
      if (!q) return;
      const match = Object.values(devMapRef.current).find(d =>
        d.name?.toLowerCase().includes(q) || String(d.id).toLowerCase().includes(q)
      );
      if (!match) return;
      const map = mapInstanceRef.current;
      map.flyTo({ center: [match.lng, match.lat], zoom: 15, duration: 900 });
      map.once('moveend', () => {
        focusedDeviceIdRef.current = String(match.id);
        showMarkersRef.current?.();
      });
      if (searchRef.current) searchRef.current.blur();
    };

    searchRef.current?.addEventListener('keydown', handleSearch);
    
    return () => {
      searchRef.current?.removeEventListener('keydown', handleSearch);
      if (liveRouteUpdateTimeout.current) clearTimeout(liveRouteUpdateTimeout.current);
      if (mapInstanceRef.current) {
         mapInstanceRef.current.remove();
         mapInstanceRef.current = null;
      }
      maplibregl.removeProtocol('pmtiles'); 
    }
  }, []);

  return (
    <div className='relative'>
      <div ref={mapRef} style={{ height: '100vh', width: '100%' }} />
    </div>
  );
}