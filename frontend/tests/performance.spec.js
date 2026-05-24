import { test, expect } from '@playwright/test';

async function waitForMap(page) {
    await page.waitForFunction(() => window.__map && window.__map.loaded(), {
        timeout: 10000
    });
}

async function measureRenderTime(page, count) {
    const duration = await page.evaluate((count) => {
        return new Promise(resolve => {
            const map = window.__map;
            const features = Array.from({ length: count }, (_, i) => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [90.4 + Math.random() * 0.5, 23.7 + Math.random() * 0.5] },
                properties: { id: `dev-${i}`, type: 'router', name: `Device ${i}` }
            }));
            performance.mark('start');
            map.getSource('devices').setData({ type: 'FeatureCollection', features });
            map.once('render', () => {
                performance.mark('end');
                performance.measure('render', 'start', 'end');
                resolve(performance.getEntriesByName('render')[0].duration);
            });
        });
    }, count);
    return duration;
}


test('renders 100 devices within 100ms', async ({ page }) => {
    await page.goto('http://localhost:5173');
		await waitForMap(page)
    const duration = await measureRenderTime(page, 100);
    console.log(`100 devices: ${duration.toFixed(2)}ms`);
    expect(duration).toBeLessThan(100);
});

test('renders 1000 devices within 200ms', async ({ page }) => {
    await page.goto('http://localhost:5173');
    await waitForMap(page);
    const duration = await measureRenderTime(page, 1000);
    console.log(`1000 devices: ${duration.toFixed(2)}ms`);
    expect(duration).toBeLessThan(200);
});

test('renders 10000 devices within 500ms', async ({ page }) => {
    await page.goto('http://localhost:5173');
    await waitForMap(page);
    const duration = await measureRenderTime(page, 10000);
    console.log(`10000 devices: ${duration.toFixed(2)}ms`);
    expect(duration).toBeLessThan(500);
});

test('map loads with 60000 devices within 5000ms', async ({ page }) => {
    const start = Date.now();
    await page.goto('http://localhost:5173');
    await waitForMap(page);

    await page.evaluate(() => {
        return new Promise(resolve => {
            const check = () => {
                const source = window.__map.getSource('devices');
                if (!source) return setTimeout(check, 100);
                const data = source.serialize().data;
                if (data?.features?.length > 0) resolve();
                else setTimeout(check, 100);
            };
            check();
        });
    });

    const duration = Date.now() - start;
    console.log(`60000 devices loaded in ${duration}ms`);
    expect(duration).toBeLessThan(5000);
});


test('renders 50000 DOM markers within 5000ms', async ({ page }) => {
    await page.goto('http://localhost:5173');
    await waitForMap(page);

    const duration = await page.evaluate(() => {
        return new Promise(resolve => {
            const map = window.__map;
            
            // zoom in past 13 to trigger DOM markers
            map.setZoom(14);
            
            const start = performance.now();
            
            // inject 50000 devices as markers
            const { Marker, Popup } = window.maplibregl;
            Array.from({ length: 50000 }, (_, i) => {
                const el = document.createElement('div');
                el.style.cssText = 'width:32px;height:32px;border-radius:50%;background:#3b82f6;border:2px solid white;';
                new Marker({ element: el })
                    .setLngLat([90.4 + Math.random() * 0.5, 23.7 + Math.random() * 0.5])
                    .addTo(map);
            });

            requestAnimationFrame(() => {
                resolve(performance.now() - start);
            });
        });
    });

    console.log(`50000 DOM markers: ${duration.toFixed(2)}ms`);
    expect(duration).toBeLessThan(5000);
});

test('renders 60000 devices smoothly', async ({ page }) => {
    await page.goto('http://localhost:5173');
    await waitForMap(page);

    const duration = await page.evaluate(() => {
        return new Promise(resolve => {
            const map = window.__map;
            performance.mark('start');
            map.once('render', () => {
                performance.mark('end');
                performance.measure('render', 'start', 'end');
                resolve(performance.getEntriesByName('render')[0].duration);
            });
            map.triggerRepaint();
        });
    });

    console.log(`60000 devices render time: ${duration.toFixed(2)}ms`);
    expect(duration).toBeLessThan(500);
});