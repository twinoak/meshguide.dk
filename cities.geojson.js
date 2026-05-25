// Geometri for byer. Hver Feature skal have properties.city = nøgle i window.MCDK_CITIES.
// Punkter i lon/lat (EPSG:4326).
window.MCDK_CITIES_GEOJSON = {
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": { "city": "horsens" },
      "geometry": { "type": "Point", "coordinates": [9.8503, 55.8607] }
    },
    {
      "type": "Feature",
      "properties": { "city": "hornslet" },
      "geometry": { "type": "Point", "coordinates": [10.3210, 56.3149] }
    },
    {
      "type": "Feature",
      "properties": { "city": "oestjylland" },
      "geometry": { "type": "Point", "coordinates": [9.9493, 56.0859] }
    }
  ]
};
