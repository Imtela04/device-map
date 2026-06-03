const fs = require('fs');

//console.log("Loading dummy data...");

const devices = JSON.parse(fs.readFileSync('devices.json', 'utf-8'));
const links = JSON.parse(fs.readFileSync('links.json', 'utf-8'));

const deviceMap = {};
devices.forEach(dev => {
    deviceMap[dev.id] = { lng: dev.lng, lat: dev.lat, name: dev.name };
});

async function getRoadRoute(fromLng, fromLat, toLng, toLat) {
    try {
        const url = `http://localhost:5000/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson`;
        const res = await fetch(url);
        const data = await res.json();
        
        if (data.routes && data.routes[0]) {
            return data.routes[0].geometry.coordinates; 
        }
    } catch (e) {}
    return [ [fromLng, fromLat], [toLng, toLat] ];
}

async function buildGeoJSON() {
    //console.log(`Processing ${links.length} links using Streams and Batching...`);
    
    // Create a pipeline directly to the hard drive
    const writeStream = fs.createWriteStream('dummy-routes.geojson');
    writeStream.write('{"type":"FeatureCollection","features":[\n');

    const BATCH_SIZE = 100; 
    let isFirstFeature = true;

    for (let i = 0; i < links.length; i += BATCH_SIZE) {
        const batch = links.slice(i, i + BATCH_SIZE);
        
        const batchPromises = batch.map(async (link) => {
            const fromDev = deviceMap[link.from];
            const toDev = deviceMap[link.to];

            if (fromDev && toDev) {
                const routeCoordinates = await getRoadRoute(fromDev.lng, fromDev.lat, toDev.lng, toDev.lat);

                return {
                    type: "Feature",
                    properties: {
                        id: link.id,
                        from: String(link.from), 
                        to: String(link.to),     
                        type: link.type || "fiber", 
                        fromName: fromDev.name || "Unknown",
                        toName: toDev.name || "Unknown"
                    },            
                    geometry: {
                        type: "LineString",
                        coordinates: routeCoordinates 
                    }
                };
            }
            return null;
        });

        // Wait for batch to calculate
        const resolvedFeatures = await Promise.all(batchPromises);

        // Write directly to the hard drive
        for (const feature of resolvedFeatures) {
            if (feature) {
                if (!isFirstFeature) {
                    writeStream.write(',\n');
                }
                writeStream.write(JSON.stringify(feature));
                isFirstFeature = false;
            }
        }

        if ((i + BATCH_SIZE) % 1000 === 0 || (i + BATCH_SIZE) >= links.length) {
            //console.log(`Finished ${Math.min(i + BATCH_SIZE, links.length)} / ${links.length} links...`);
        }
    }

    // Close the JSON wrapper and the file stream
    writeStream.write('\n]}\n');
    writeStream.end();
    
    writeStream.on('finish', () => {
        //console.log(`Success! Streamed curvy road routes directly to dummy-routes.geojson.`);
    });
}

buildGeoJSON();