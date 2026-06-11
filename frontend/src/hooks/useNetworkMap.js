import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { createMarker } from '../utils/createMarker';
import { loadDeviceIcons } from '../utils/iconSprite';
import { fetchRoute } from '../utils/fetchRoute';
import { toGeoJSON } from '../utils/toGeoJSON';
import { INFRA, STATUS_COLOR, DEVICE_LEVEL, TIER, TIER_COLOR, TIER_SPEED } from '../utils/mapConstants';
import { mockStatus } from '../utils/mockStatus';
import { buildLinkPopupHTML, buildCustomerPopupHTML, buildDevicePopupHTML } from '../utils/popupTemplates';
import { setupMapLayers } from '../utils/setupMapLayers';

export function useNetworkMap() {
  const mapRef                      = useRef(null);

  // Map instance
  const mapInstanceRef              = useRef(null);

  // Device & link state
  const devMapRef                   = useRef({});
  const linkMapRef                  = useRef({});
  const ObjectLinksByDeviceRef      = useRef({});

  // Route state
  const liveRoutesRef               = useRef({ type: 'FeatureCollection', features: [] });
  const liveRouteMapRef             = useRef(new Map());
  const liveRouteUpdateTimeout      = useRef(null);
  const fetchedRouteIdsRef          = useRef(new Set());
  const modifiedRouteIdsRef         = useRef(new Set());

  // Marker & focus state
  const activeMarkersRef            = useRef(new Map());
  const focusedDeviceIdRef          = useRef(null);
  const focusedCustomerRouteIdsRef  = useRef(new Set());
  const showMarkersRef              = useRef(null);

  // Device lists (for viewport filtering)
  const mainDevicesRef              = useRef([]);
  const accessDevicesRef            = useRef([]);

  const [stats, setStats] = useState({ total: 0, online: 0, degraded: 0, down: 0 });

  useEffect(() => {
    if (mapInstanceRef.current) return;

    // 1. Prevent Protocol Collision
    try {
      const protocol = new Protocol();
      maplibregl.addProtocol('pmtiles', protocol.tile);
    } catch (err) {
      // Safely ignore if already registered
    }

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

    let isMounted = true;
    map.on('load', async () => {
      try {
				// ── Icon Loading ───────────────────────────────────────────────────────────
				await loadDeviceIcons(map).catch(e => console.error('❌ loadDeviceIcons failed:', e));
				if (!isMounted) return;

				// ── Shared State ───────────────────────────────────────────────────────────
				const devMap = devMapRef.current;
				const linkMap = {};
				const ObjectLinksByDevice = {};
				linkMapRef.current = linkMap;
				ObjectLinksByDeviceRef.current = ObjectLinksByDevice;
				const fetchedViewportRef = new Set(); // Prevent fetching the same area twice

				// ── Layer & Source Setup ───────────────────────────────────────────────────
				const popup = setupMapLayers(map, { liveRoutesRef, linkMapRef, devMapRef });

				// ── Viewport Data Fetching ─────────────────────────────────────────────────
				async function fetchViewportData() {
					const bounds = map.getBounds();
					const zoom = map.getZoom();

					// 1. Determine Tier based on Zoom Level
					let maxTier = 'core'; 
					if (zoom >= 6 && zoom < 10) maxTier = 'olt';    // Regional: Core + Edge + OLT
					if (zoom >= 10) maxTier = 'access';             // District: Everything

					// 2. Create a grid key that INCLUDES the tier, so zooming in forces a refetch
					const G = zoom >= 10 ? 0.05 : 0.25; 
					const key = [
						Math.floor(bounds.getWest()  / G),
						Math.floor(bounds.getSouth() / G),
						Math.ceil(bounds.getEast()   / G),
						Math.ceil(bounds.getNorth()  / G),
						maxTier
					].join(',');

					if (fetchedViewportRef.has(key)) return;
					fetchedViewportRef.add(key);

					const q = `west=${bounds.getWest()}&south=${bounds.getSouth()}&east=${bounds.getEast()}&north=${bounds.getNorth()}&tier=${maxTier}`;

        try {
          // 3. Fetch ONLY what is in the viewport at the required tier
          const [viewDevices, viewLinks] = await Promise.all([
            fetch(`http://localhost:8000/api/devices/viewport?${q}`).then(r => r.ok ? r.json() : []).catch(() => []),
            fetch(`http://localhost:8000/api/links/viewport?${q}`).then(r => r.ok ? r.json() : []).catch(() => []),
          ]);

          // Hydrate devMap with safeType so INFRA.has() checks work throughout
          viewDevices.forEach(d => {
            const strId = String(d.id);
            if (!devMapRef.current[strId]) {
              devMapRef.current[strId] = { ...d, safeType: d.type };
            }
          });
          // Keep accessDevicesRef in sync — used by showMarkers for viewport filtering
          accessDevicesRef.current = Object.values(devMapRef.current)
            .filter(d => !INFRA.has(d.safeType));
					mainDevicesRef.current = Object.values(devMapRef.current)
						.filter(d => INFRA.has(d.safeType));


          // Populate linkMap + ObjectLinksByDevice so topology traversal works
          viewLinks.forEach(l => {
            const lid = String(l.id);
            linkMap[lid] = l;
            [String(l.from), String(l.to)].forEach(devId => {
              if (!ObjectLinksByDevice[devId]) ObjectLinksByDevice[devId] = [];
              if (!ObjectLinksByDevice[devId].some(x => String(x.id) === lid))
                ObjectLinksByDevice[devId].push(l);
            });
          });


          updateAllDeviceSources();
					const allDevices = Object.values(devMapRef.current);
					const online   = allDevices.filter(d => mockStatus(d.id) === 'online').length;
					const degraded = allDevices.filter(d => mockStatus(d.id) === 'degraded').length;
					const down     = allDevices.filter(d => mockStatus(d.id) === 'down').length;
					setStats({ total: allDevices.length, online, degraded, down });

          queueLiveRouteUpdate();
					if (map.getZoom() >= 12) showMarkers();


        } catch (error) {
          console.error("Viewport fetch failed:", error);
        }
				}
				fetchViewportData();
				let _viewportFetchTimer = null;
				map.on('moveend', () => {
					clearTimeout(_viewportFetchTimer);
					_viewportFetchTimer = setTimeout(fetchViewportData, 150);
				});

				// ── Device Source Sync ─────────────────────────────────────────────────────
				const toGeoJSONFeature = (device) => {
					let renderType = 'Access';
					const t = (device.type || '').toLowerCase();
					if (t.includes('core')) renderType = 'Core Router';
					else if (t.includes('edge')) renderType = 'Edge Router';
					else if (t.includes('olt')) renderType = 'OLT';

					return {
						type: 'Feature',
						geometry: { type: 'Point', coordinates: [device.lng, device.lat] },
						properties: { 
							id: String(device.id), 
							name: device.name || 'Unknown',
							type: device.type,
							safeType: device.safeType,
							renderType
						} 
					};
				};
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

				// ── Route Management ───────────────────────────────────────────────────────
				function queueLiveRouteUpdate() {
					if (liveRouteUpdateTimeout.current) return;
					liveRouteUpdateTimeout.current = setTimeout(() => {
						const m = mapInstanceRef.current;
						if (!m?.getSource('live-routes')) { liveRouteUpdateTimeout.current = null; return; }
						const zoom = m.getZoom();
						// Mirror the line-opacity zoom steps: only pass features MapLibre would
						// render at this zoom. Keeps the setData payload proportional to what's
						// actually visible regardless of how large liveRouteMapRef grows.
						const features = [];
						for (const f of liveRouteMapRef.current.values()) {
							const tier = f.properties?.tier;
							if (zoom <  5)                                                           continue;
							if (zoom <  8 && tier !== 'core' && tier !== 'edge')                     continue;
							if (zoom < 10 && tier !== 'core' && tier !== 'edge' && tier !== 'olt')   continue;
							features.push(f);
						}
						liveRoutesRef.current.features = features;
						m.getSource('live-routes').setData(liveRoutesRef.current);
						liveRouteUpdateTimeout.current = null;
					}, 100);
				}
				function updateLiveRouteInMap(linkId, linkType, coordinates, props = {}) {
					const safeId = String(linkId);
					fetchedRouteIdsRef.current.add(safeId); 
					const newFeature ={
						type: 'Feature',
						properties: (() => {
							const fType = devMap[String(props.from)]?.safeType || '';
							const tType = devMap[String(props.to)]?.safeType   || '';
							const linkLevel = Math.min(
								DEVICE_LEVEL[fType] || 1,
								DEVICE_LEVEL[tType]   || 1
							);
							const tier = linkLevel >= 4 ? 'core'
												: linkLevel === 3 ? 'edge'
												: linkLevel === 2 ? 'olt'
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
					};
					liveRouteMapRef.current.set(safeId, newFeature);
					queueLiveRouteUpdate();
					modifiedRouteIdsRef.current.add(safeId);
				}

				// ── Path Highlighting ──────────────────────────────────────────────────────
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
						const existing = liveRouteMapRef.current.get(lid);
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

						const linkLevel = Math.min(
							DEVICE_LEVEL[fType] || 1,
							DEVICE_LEVEL[tType]   || 1
						);
						const tier = linkLevel >= 4 ? 'core'
											: linkLevel === 3 ? 'edge'
											: linkLevel === 2 ? 'olt'
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

				// ── Customer Routes ────────────────────────────────────────────────────────
				async function fetchFocusedCustomerRoutes(deviceId) {
					const strId = String(deviceId);
					const links = ObjectLinksByDevice[strId] || [];

					const features = await Promise.all(links.map(async (link) => {
						const lid  = String(link.id);
						const from = devMap[String(link.from)];
						const to   = devMap[String(link.to)];
						if (!from || !to) return null;

						focusedCustomerRouteIdsRef.current.add(lid);

						// Re-use an already-fetched geometry if the OLT side was loaded as infra
						const existing = liveRouteMapRef.current.get(lid);
						let coordinates;
						if (existing) {
							coordinates = existing.geometry.coordinates;
						} else {
							try {
								const res = await fetch('http://localhost:8000/api/route', {
									method: 'POST',
									headers: { 'Content-Type': 'application/json' },
									body: JSON.stringify({
										a: { lat: from.lat, lng: from.lng },
										b: { lat: to.lat,   lng: to.lng   },
										link_id:   `${link.from}-${link.to}`,
										link_type: link.type || 'generic'
									}),
								});
								if (!res.ok) throw new Error(res.status);
								const coords = await res.json();
								coordinates = coords.map(([lat, lng]) => [lng, lat]);
							} catch {
								coordinates = [[from.lng, from.lat], [to.lng, to.lat]];
							}
						}

						return {
							type: 'Feature',
							properties: {
								id: lid,
								from:      String(link.from),
								to:        String(link.to),
								fromName:  from.name || 'Unknown',
								toName:    to.name   || 'Unknown',
								fromType:  from.safeType || '',
								toType:    to.safeType   || '',
								tier:      'access',
								status:    mockStatus(lid),
								statusColor: STATUS_COLOR[mockStatus(lid)] ?? '#c4b5fd',
							},
							geometry: { type: 'LineString', coordinates }
						};
					}));

					map.getSource('customer-route')?.setData({
						type: 'FeatureCollection',
						features: features.filter(Boolean)
					});
				}
				function clearCustomerRoute() {
					map.getSource('customer-route')?.setData({ type: 'FeatureCollection', features: [] });
					focusedCustomerRouteIdsRef.current.clear();
				}
				function loadViewportCustomerRoutes() {
					if (focusedDeviceIdRef.current) return; // focused mode takes priority
					const bounds = map.getBounds();
					const w = bounds.getWest(), e = bounds.getEast();
					const s = bounds.getSouth(), n = bounds.getNorth();

					const visibleAccess = accessDevicesRef.current.filter(
						d => d.lng >= w && d.lng <= e && d.lat >= s && d.lat <= n
					).slice(0, 300); // hard cap — keeps setData payload bounded

					const seenLinks = new Set();
					const features  = [];

					for (const dev of visibleAccess) {
						for (const link of (ObjectLinksByDevice[String(dev.id)] || [])) {
							const lid = String(link.id);
							if (seenLinks.has(lid)) continue;
							seenLinks.add(lid);

							const from = devMap[String(link.from)];
							const to   = devMap[String(link.to)];
							if (!from || !to) continue;

							// Prefer cached OSRM geometry; fall back to straight line
							const existing     = liveRouteMapRef.current.get(lid);
							const coordinates  = existing?.geometry.coordinates
								?? [[from.lng, from.lat], [to.lng, to.lat]];

							const status = mockStatus(lid);
							features.push({
								type: 'Feature',
								properties: {
									id: lid,
									from:     String(link.from),
									to:       String(link.to),
									fromName: from.name || 'Unknown',
									toName:   to.name   || 'Unknown',
									fromType: from.safeType || '',
									toType:   to.safeType   || '',
									tier:     'access',
									status,
									statusColor: STATUS_COLOR[status] ?? '#c4b5fd',
								},
								geometry: { type: 'LineString', coordinates }
							});
						}
					}

					map.getSource('customer-route')?.setData({ type: 'FeatureCollection', features });
				}
				// ── Markers ────────────────────────────────────────────────────────────────
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
						// Cap access neighbors — OLTs can have 600+ customer downlinks and
						// creating that many Marker instances in one frame causes severe lag.
						const infraNeighbors  = [];

						const accessNeighbors = [];
						for (const nid of neighborIds) {
							const d = devMapRef.current[nid];
							if (!d) continue;
							if (INFRA.has(d.safeType)) infraNeighbors.push(d);
							else if (accessNeighbors.length < 50) accessNeighbors.push(d);
						}

						devicesToRender = [...infraNeighbors, ...accessNeighbors];
					} else {
						const w = bounds.getWest(), e = bounds.getEast();
						const s = bounds.getSouth(), n = bounds.getNorth();
						const infraInView = mainDevicesRef.current.filter(
							dev => dev.lng >= w && dev.lng <= e && dev.lat >= s && dev.lat <= n
						);
						// Access devices are invisible below zoom 12 — only load them when
						// DOM markers are active, capped to keep DOM node count manageable.
						const accessInView = map.getZoom() >= 12
							? accessDevicesRef.current.filter(
									dev => dev.lng >= w && dev.lng <= e && dev.lat >= s && dev.lat <= n
								).slice(0, 400)
							: [];
						devicesToRender = [...infraInView, ...accessInView];
					}        

					['links-generic', 'live-generic', 'live-generic-glow'].forEach(id => {
						if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible');
					});

					if (map.getLayer('unclustered-main-devices')) {
						map.setLayoutProperty('unclustered-main-devices', 'visibility', 'none');
					}


					const visibleIds = new Set(devicesToRender.map(d => String(d.id)));

					for (const [id, marker] of activeMarkersRef.current.entries()) {
							if (!visibleIds.has(id)) {
									marker.remove();
									activeMarkersRef.current.delete(id);
							}
					}

					devicesToRender.forEach(dev => {
						const strId = String(dev.id);
						const isInfra = INFRA.has(dev.safeType);

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
								clearCustomerRoute();
								focusedDeviceIdRef.current = String(dev.id);
								showMarkers(); 
								showStatsPopup(dev); 
								if (!INFRA.has(dev.safeType)) {
									fetchFocusedCustomerRoutes(String(dev.id));
								}
							});

							marker.on('dragstart', () => {
								const affected = ObjectLinksByDevice[strId] || [];
								affected.forEach(l => modifiedRouteIdsRef.current.add(String(l.id)));
								refreshFilters(); 
							});

							let _dragRaf = null;

						marker.on('drag', () => {
							if (_dragRaf) cancelAnimationFrame(_dragRaf);
							_dragRaf = requestAnimationFrame(() => {
								_dragRaf = null;
								const coords = marker.getLngLat();

								dev.lng = coords.lng; dev.lat = coords.lat;

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
								})

								map.getSource('drag-routes').setData({ type: 'FeatureCollection', features: dragFeatures });

								});
								
							});

							marker.on('dragend', async () => {
								const coords = marker.getLngLat();
								dev.lng = coords.lng; dev.lat = coords.lat;

								const allConnections = ObjectLinksByDevice[strId] || [];

								// Clear the temporary red dragging line
								map.getSource('drag-routes').setData({ type: 'FeatureCollection', features: [] });

								// Only process infra↔infra connections. Adding access links (customer→OLT)
								// to liveRouteMapRef floods it with hundreds of entries and causes cascading
								// setData calls that lock the browser. The drag-routes layer already handles
								// customer link visuals during the drag gesture — they need nothing more.
								const infraConnections = allConnections.filter(l => {
									const otherId = String(l.from) === strId ? String(l.to) : String(l.from);
									return INFRA.has(devMap[otherId]?.safeType);
								});

								const BATCH = 6;
								for (let i = 0; i < infraConnections.length; i += BATCH) {
									await Promise.all(
										infraConnections.slice(i, i + BATCH).map(async (link) => {
											try {
												const isFrom      = String(link.from) === strId;
												const otherDevId  = isFrom ? String(link.to) : String(link.from);
												const otherDev    = devMap[otherDevId];
												if (!otherDev) return;

												const hyphenatedId = `${link.from}-${link.to}`;

												// Snap to straight line immediately, then overwrite with OSRM road route
												updateLiveRouteInMap(link.id, link.type || 'generic',
													isFrom
														? [[dev.lng, dev.lat], [otherDev.lng, otherDev.lat]]
														: [[otherDev.lng, otherDev.lat], [dev.lng, dev.lat]],
													{ from: link.from, to: link.to, fromName: dev.name, toName: otherDev.name, isInfra: true }
												);

												const routeResponse = await fetchRoute(
													{ lat: dev.lat, lng: dev.lng },
													{ lat: otherDev.lat, lng: otherDev.lng },
													{ link_id: hyphenatedId, link_type: link.type || 'generic' }
												);
												updateLiveRouteInMap(link.id, link.type || 'generic',
													toGeoJSON(routeResponse).geometry.coordinates,
													{ from: link.from, to: link.to, fromName: dev.name, toName: otherDev.name, isInfra: true }
												);
											} catch (err) {
												console.error('Failed routing link:', link.id, err);
											}
										})
									);
								}
								updateAllDeviceSources();
								refreshFilters();

								fetch(`http://localhost:8000/api/devices/${dev.id}`, {
									method: 'PATCH',
									headers: { 'Content-Type': 'application/json' },
									body: JSON.stringify({ lng: coords.lng, lat: coords.lat })
								}).catch(console.error);
							});
						}
					});

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
						const fType = devMap[String(l.from)]?.safeType || '';
						const tType = devMap[String(l.to)]?.safeType   || '';
						return INFRA.has(fType) && INFRA.has(tType);
					});



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
					if (!focusedDeviceIdRef.current && map.getZoom() >= 12) {
						loadViewportCustomerRoutes();
					}

					
				}
				function hideMarkers() {
					clearCustomerRoute();
					for (const marker of activeMarkersRef.current.values()) {
							marker.remove();
					}
					activeMarkersRef.current.clear();
					focusedDeviceIdRef.current = null; 

				['unclustered-main-devices']
					.forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible'); });
					if (map.getLayer('unclustered-main-devices')) map.setFilter('unclustered-main-devices', null);
				}      
				showMarkersRef.current = showMarkers;

				// ── Filters ────────────────────────────────────────────────────────────────
				function refreshFilters() {
					const focusId = focusedDeviceIdRef.current;

					if (focusId) {
						// USER CLICKED A DEVICE: Show ONLY the routes connected to this specific device
						const connectedLinkIds = (ObjectLinksByDevice[String(focusId)] || []).map(l => String(l.id));
						const focusFilter = ['in', ['to-string', ['get', 'id']], ['literal', connectedLinkIds]];

						if (map.getLayer('live-generic')) map.setFilter('live-generic', focusFilter);
						if (map.getLayer('live-generic-glow')) map.setFilter('live-generic-glow', focusFilter);

						// Hide the focused device's WebGL dot so the popup HTML marker doesn't look messy
						if (map.getLayer('unclustered-main-devices')) {
							map.setFilter('unclustered-main-devices', ['!=', ['to-string', ['get', 'id']], String(focusId)]);
						}
					} else {
						// NO DEVICE FOCUSED: Show ALL routes natively. 
						// (Our line-opacity zoom steps will naturally hide the customer routes at country-level)
						if (map.getLayer('live-generic')) map.setFilter('live-generic', null);
						if (map.getLayer('live-generic-glow')) map.setFilter('live-generic-glow', null);

						// Restore all device dots
						if (map.getLayer('unclustered-main-devices')) map.setFilter('unclustered-main-devices', null);
						if (map.getLayer('unclustered-devices')) map.setFilter('unclustered-devices', null);
					}
				}
	
				// ── Device Stats Popup ─────────────────────────────────────────────────────
				map.on('click', 'unclustered-main-devices', (e) => {
					const featureId = e.features[0].properties.id;
					const coords = e.features[0].geometry.coordinates.slice();
					const dev = devMap[String(featureId)];

					popup.remove();
					clearCustomerRoute();
					focusedDeviceIdRef.current = featureId;

					map.easeTo({ center: coords, zoom: Math.max(map.getZoom(), 13) });

					map.once('moveend', () => {
						showMarkers();               
						showUpstreamPath(featureId);   
						if (dev) showStatsPopup(dev);
					});
				});
				map.addLayer({
					id: 'unclustered-main-devices', 
					type: 'symbol', 
					source: 'main-devices',
					minzoom: 5, 
					layout: {
						'icon-image': ['get', 'safeType'],
						'icon-size': 1.0, 'icon-allow-overlap': true, 'icon-ignore-placement': true,
						'text-field': ['get', 'name'], 'text-offset': [0, 1.6], 'text-size': 10, 'text-optional': true, 'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
					},
					paint: { 
						'text-color': '#1e293b', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5,
						'icon-opacity': [
							'step', ['zoom'],
							0.0,
							// Zoom < 5: Only Core Routers
							5, ['case', ['==', ['get', 'safeType'], 'core-router'], 1.0, 0.0],
							// Zoom 5-7: Core + Edge Routers
							6, ['case', ['==', ['get', 'safeType'], 'core-router'], 1.0, ['==', ['get', 'safeType'], 'edge-router'], 1.0, 0.0],
							// Zoom 7+: Show all remaining infra (OLTs, etc)
							8, 1.0
						],
						'text-opacity': [
							'step', ['zoom'],
							0.0,
							5, ['case', ['==', ['get', 'safeType'], 'core-router'], 1.0, 0.0],
							6, ['case', ['==', ['get', 'safeType'], 'core-router'], 1.0, ['==', ['get', 'safeType'], 'edge-router'], 1.0, 0.0],
							8, 1.0
						]
					},
				});
				function showStatsPopup(dev) {
					const connectedLinks = ObjectLinksByDevice[String(dev.id)] || [];
					new maplibregl.Popup({ offset: 25, closeButton: true, closeOnClick: true })
						.setLngLat([dev.lng, dev.lat])
						.setHTML(buildDevicePopupHTML(dev, connectedLinks, devMap))
						.addTo(map);
				}
				map.on('mouseenter', 'unclustered-main-devices', () => { map.getCanvas().style.cursor = 'pointer'; });
				map.on('mouseleave', 'unclustered-main-devices', () => { map.getCanvas().style.cursor = ''; });
       
				// ── Initialisation ─────────────────────────────────────────────────────────
				hideMarkers();
				clearUpstreamPath();
				refreshFilters();

				// ── STARTUP DATA LOAD ────────────────────────────────────────────────────
				const [infraDevices, infraLinkData] = await Promise.all([
					fetch('http://localhost:8000/api/devices/infra').then(r => r.ok ? r.json() : []).catch(() => []),
					fetch('http://localhost:8000/api/links/infra').then(r => r.ok ? r.json() : []).catch(() => []),
				]);
				if (!isMounted) return;
				infraDevices.forEach(d => {
					devMap[String(d.id)] = { ...d, safeType: d.type };
				});
				mainDevicesRef.current = infraDevices.map(d => ({ ...d, safeType: d.type }));
				if (infraDevices.length > 0) {
					const n = infraDevices.length;
					const cLng = infraDevices.reduce((s, d) => s + d.lng, 0) / n;
					const cLat = infraDevices.reduce((s, d) => s + d.lat, 0) / n;

					map.addSource('network-dot', {
							type: 'geojson',
							data: {
									type: 'Feature',
									geometry: { type: 'Point', coordinates: [cLng, cLat] },
									properties: {}
							}
					});

					map.addLayer({
						id: 'network-dot-pulse',
						type: 'circle',
						source: 'network-dot',
						maxzoom: 5,
						paint: {
							'circle-radius':         5,
							'circle-color':          'transparent',
							'circle-stroke-width':   2,
							'circle-stroke-color':   '#4f46e5',
							'circle-stroke-opacity': 0, 
						}
					});

					map.addLayer({
							id: 'network-dot',
							type: 'circle',
							source: 'network-dot',
							maxzoom: 5,
							paint: {
									'circle-radius':          ['interpolate', ['linear'], ['zoom'], 1, 5, 4, 11],
									'circle-color':           '#4f46e5',
									'circle-opacity':         0.85,
									'circle-stroke-width':    2,
									'circle-stroke-color':    '#ffffff',
									'circle-stroke-opacity':  0.9,
							}
					});

					// Animate the ring — slow, professional pulse
					let _pulseRaf = null;
					const PULSE_DURATION = 2200; // ms per cycle
					function animatePulse(ts) {
						if (!mapInstanceRef.current?.getLayer('network-dot-pulse')) return;
						const t   = (ts % PULSE_DURATION) / PULSE_DURATION; // 0 → 1
						const radius  = 5 + t * 18;                          // 5px → 23px
						const opacity = 0.6 * (1 - t);                       // fades out as it expands
						mapInstanceRef.current.setPaintProperty('network-dot-pulse', 'circle-radius',         radius);
						mapInstanceRef.current.setPaintProperty('network-dot-pulse', 'circle-stroke-opacity', opacity);
						_pulseRaf = requestAnimationFrame(animatePulse);
					}
					_pulseRaf = requestAnimationFrame(animatePulse);

				}
				infraLinkData.forEach(l => {
					const lid = String(l.id);
					linkMap[lid] = l;
					[String(l.from), String(l.to)].forEach(devId => {
						if (!ObjectLinksByDevice[devId]) ObjectLinksByDevice[devId] = [];
						if (!ObjectLinksByDevice[devId].some(x => String(x.id) === lid))
							ObjectLinksByDevice[devId].push(l);
					});
				});


				updateAllDeviceSources();
				const backboneLinks = infraLinkData.filter(l => {
					const fType = devMap[String(l.from)]?.safeType || '';
					const tType = devMap[String(l.to)]?.safeType   || '';
					return (fType === 'core-router' || tType === 'core-router' ||
									fType === 'edge-router' || tType === 'edge-router') &&
								!fetchedRouteIdsRef.current.has(String(l.id));
				});
				backboneLinks.forEach(l => fetchedRouteIdsRef.current.add(String(l.id)));
				const oltInfraLinks = infraLinkData.filter(l => {
					const fType = devMap[String(l.from)]?.safeType || '';
					const tType = devMap[String(l.to)]?.safeType   || '';
					return (fType === 'olt' || tType === 'olt') &&
								INFRA.has(fType) && INFRA.has(tType) &&
								!fetchedRouteIdsRef.current.has(String(l.id));
				});
				oltInfraLinks.forEach(l => fetchedRouteIdsRef.current.add(String(l.id)));
				[...backboneLinks, ...oltInfraLinks].forEach(link => {
					const from = devMap[String(link.from)];
					const to   = devMap[String(link.to)];
					if (!from || !to) return;
					const fType = from.safeType || '';
					const tType = to.safeType   || '';
					const tier  =
						fType === 'core-router' || tType === 'core-router' ? 'core'
						: fType === 'edge-router' || tType === 'edge-router' ? 'edge'
						: 'olt';
					liveRouteMapRef.current.set(String(link.id), {
						type: 'Feature',
						properties: {
							id: String(link.id), type: link.type || 'generic',
							from: String(link.from), to: String(link.to),
							fromName: from.name, toName: to.name,
							isInfra: true, tier,
							tierColor:   TIER_COLOR[tier],
							statusColor: STATUS_COLOR[mockStatus(link.id)] ?? TIER_COLOR[tier],
						},
						geometry: { type: 'LineString', coordinates: [[from.lng, from.lat], [to.lng, to.lat]] }
					});
				});
				liveRoutesRef.current.features = Array.from(liveRouteMapRef.current.values());
				map.getSource('live-routes').setData(liveRoutesRef.current);
				refreshFilters();
				const BB_BATCH = 25;
				for (let i = 0; i < backboneLinks.length; i += BB_BATCH) {
					await Promise.all(
						backboneLinks.slice(i, i + BB_BATCH).map(async (link) => {
							const from = devMap[String(link.from)], to = devMap[String(link.to)];
							if (!from || !to) return;
							const ctrl = new AbortController();
							const timer = setTimeout(() => ctrl.abort(), 8000);
							try {
								const res = await fetch('http://localhost:8000/api/route', {
									method: 'POST', headers: { 'Content-Type': 'application/json' },
									body: JSON.stringify({ a: { lat: from.lat, lng: from.lng }, b: { lat: to.lat, lng: to.lng },
										link_id: `${link.from}-${link.to}`, link_type: link.type || 'generic' }),
									signal: ctrl.signal,
								});
								if (!res.ok) throw new Error(res.status);
								const coords = await res.json();
								updateLiveRouteInMap(link.id, link.type || 'generic', coords.map(([lat, lng]) => [lng, lat]),
									{ from: link.from, to: link.to, fromName: from.name, toName: to.name, isInfra: true });
							} catch {
								updateLiveRouteInMap(link.id, 'generic', [[from.lng, from.lat], [to.lng, to.lat]],
									{ from: link.from, to: link.to, fromName: from.name, toName: to.name, isInfra: true });
							} finally {
								clearTimeout(timer);
							}
						})
					);
				}
				refreshFilters();

				// ── Map Event Listeners ────────────────────────────────────────────────────
				let _showMarkersTimer = null;
				map.on('zoomend', () => {
					const currentZoom = map.getZoom();
					if (currentZoom < 12) {
						clearTimeout(_showMarkersTimer);
						hideMarkers();
						return;
					}
					if (currentZoom < 5) queueLiveRouteUpdate();
				});
				map.on('moveend', () => {
					if (map.getZoom() < 12) return;
					clearTimeout(_showMarkersTimer);
					_showMarkersTimer = setTimeout(showMarkers, 80);
				});
				map.on('click', (e) => {
					const interactiveLayers = ['unclustered-main-devices', 'unclustered-devices'];
					const activeLayers = interactiveLayers.filter(l => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none');
					
					if (activeLayers.length > 0) {
						const features = map.queryRenderedFeatures(e.point, { layers: activeLayers });
						if (features.length > 0) return; 
					}

					if (e.originalEvent.target.tagName.toLowerCase() !== 'canvas') return;
					
					clearCustomerRoute();
					focusedDeviceIdRef.current = null;
					clearUpstreamPath();
					if (map.getZoom() >= 12) { 
						showMarkers(); 
						loadViewportCustomerRoutes();
					} 
					else { hideMarkers(); }
					refreshFilters();
				});
			}catch (err) {
				console.error('🔴 Map load failed at:', err);
			}
		});
  return () => {
    isMounted = false;
    if (_pulseRaf) cancelAnimationFrame(_pulseRaf);

    if (liveRouteUpdateTimeout.current) {
      clearTimeout(liveRouteUpdateTimeout.current);
    }

    for (const marker of activeMarkersRef.current.values()) {
      marker.remove();
    }
    activeMarkersRef.current.clear();

    if (mapInstanceRef.current) {
      mapInstanceRef.current.remove();
      mapInstanceRef.current = null;
    }
  };
}, []);


  return { mapRef, stats,  refreshMarkers: () => showMarkersRef.current?.(),};
}