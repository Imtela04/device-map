import json
import asyncio
import httpx
import os

async def get_road_route(client, from_dev, to_dev, link):
    """Fetches the OSRM route and formats the GeoJSON Feature."""
    try:
        # Note: Using overview=simplified keeps the 60k file size much smaller!
        url = f"http://localhost:5000/route/v1/driving/{from_dev['lng']},{from_dev['lat']};{to_dev['lng']},{to_dev['lat']}?overview=simplified&geometries=geojson"
        
        response = await client.get(url, timeout=10.0)
        data = response.json()
        
        if data.get("code") == "Ok" and data.get("routes"):
            route_coordinates = data["routes"][0]["geometry"]["coordinates"]
        else:
            route_coordinates = [[from_dev['lng'], from_dev['lat']], [to_dev['lng'], to_dev['lat']]]
    except Exception:
        # Fallback to straight line on timeout or connection error
        route_coordinates = [[from_dev['lng'], from_dev['lat']], [to_dev['lng'], to_dev['lat']]]

    return {
        "type": "Feature",
        "properties": {
            "id": link["id"],
            "from": str(link["from"]),
            "to": str(link["to"]),
            "type": link.get("type", "generic"),
            "fromName": from_dev.get("name", "Unknown"),
            "toName": to_dev.get("name", "Unknown")
        },
        "geometry": {
            "type": "LineString",
            "coordinates": route_coordinates
        }
    }

async def build_geojson():
    print("Loading database fixtures...")
    with open('devices.json', 'r', encoding='utf-8') as f:
        devices = json.load(f)
    with open('links.json', 'r', encoding='utf-8') as f:
        links = json.load(f)

    device_map = {str(dev['id']): dev for dev in devices}
    
    BATCH_SIZE = 100
    is_first_feature = True

    print(f"Processing {len(links)} links using Streams and Batching in Python...")

    # Create a pipeline directly to the hard drive (Equivalent to fs.createWriteStream)
    with open('routes.geojson', 'w', encoding='utf-8') as write_stream:
        write_stream.write('{"type":"FeatureCollection","features":[\n')

        # Use a single client session for connection pooling across all batches
        limits = httpx.Limits(max_connections=100, max_keepalive_connections=20)
        async with httpx.AsyncClient(limits=limits) as client:
            
            for i in range(0, len(links), BATCH_SIZE):
                batch = links[i:i + BATCH_SIZE]
                tasks = []

                for link in batch:
                    from_dev = device_map.get(str(link['from']))
                    to_dev = device_map.get(str(link['to']))

                    if from_dev and to_dev:
                        tasks.append(get_road_route(client, from_dev, to_dev, link))

                # Wait for batch to calculate (Equivalent to Promise.all)
                resolved_features = await asyncio.gather(*tasks)

                # Write directly to the hard drive
                for feature in resolved_features:
                    if feature:
                        if not is_first_feature:
                            write_stream.write(',\n')
                        write_stream.write(json.dumps(feature))
                        is_first_feature = False

                # Logging progress
                if (i + BATCH_SIZE) % 1000 == 0 or (i + BATCH_SIZE) >= len(links):
                    print(f"Finished {min(i + BATCH_SIZE, len(links))} / {len(links)} links...")

        # Close the JSON wrapper and the file stream
        write_stream.write('\n]}\n')

    print("Success! Streamed curvy road routes directly to routes.geojson.")

if __name__ == "__main__":
    # Ensure any previous event loops don't conflict
    asyncio.run(build_geojson())