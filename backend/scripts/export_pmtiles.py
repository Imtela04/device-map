import json, subprocess, httpx

def export():
  data = httpx.get('http://localhost:8000/api/routes/geojson').json()
  with open('/tmp/routes.geojson', 'w') as f:
    json.dump(data, f)
  # requires tippecanoe installed
  subprocess.run([
    'tippecanoe',
    '-o', 'frontend/public/dummy-network.pmtiles',
    '-l', 'networklinks',
    '--force',
    '/tmp/routes.geojson'
  ])

if __name__ == '__main__':
  export()