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

test('all routes drawn within 8000ms of page load', async ({ page }) => {
    const start = Date.now();
		
    await page.goto('http://localhost:5173');
		await waitForMap(page);
    
		await page.evaluate(() => {
				return new Promise(resolve => {
						const check = () => {
						const allLoaded = window.__linkIds.every(id => {
								const source = window.__map.getSource(id);
								if (!source) return false;
								const data = source.serialize().data;
								const coords = data?.geometry?.coordinates;
								return Array.isArray(coords) && coords.length > 1;
						});
								if (allLoaded) resolve();
								else setTimeout(check, 100);
						};
						check();
				});
		});    
    const duration = Date.now() - start;
    console.log(`All routes drawn in ${duration}ms`);
    expect(duration).toBeLessThan(8000);
});