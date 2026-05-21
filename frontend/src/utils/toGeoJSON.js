export function toGeoJSON(coords) {
    return {
        type: "Feature",
        geometry: {
            type: "LineString",
            coordinates: coords.map(([ lat, lng]) => [lng, lat]),
        }
    }
}