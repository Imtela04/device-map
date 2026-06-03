import argparse
import random
import json
import os

# Bangladesh bounding box
LAT_MIN, LAT_MAX = 20.7, 26.6
LNG_MIN, LNG_MAX = 88.0, 92.7

# REALISTIC ISP Device distribution for 60,000 total
DEVICE_COUNTS = {
    'core-router': 4,          # National backbone
    'edge-router': 16,         # Regional Gateways / BNGs
    'olt': 100,                # Neighborhood Fiber Aggregators
    'customer-router': 59880   # End-user access devices (ONTs/Routers)
}

def random_bd_coords():
    return {
        'lat': round(random.uniform(LAT_MIN, LAT_MAX), 6),
        'lng': round(random.uniform(LNG_MIN, LNG_MAX), 6)
    }

def generate_devices():
    devices = []
    for device_type, count in DEVICE_COUNTS.items():
        for i in range(count):
            coords = random_bd_coords()
            devices.append({
                'id': f'{device_type}-{i+1}',
                'name': f'{device_type.replace("-", " ").title()} {i+1}',
                'type': device_type,
                'lat': coords['lat'],
                'lng': coords['lng']
            })
    return devices

def get_nearest(source_device, candidates, k=1, max_checks=400):
    """
    Finds the 'k' closest devices geographically.
    """
    pool = candidates
    if len(candidates) > max_checks:
        pool = random.sample(candidates, max_checks)
        
    # Sort the pool by Euclidean distance (squared) to find the closest neighbors
    pool.sort(key=lambda c: (c['lat'] - source_device['lat'])**2 + (c['lng'] - source_device['lng'])**2)
    return pool[:k]

def generate_links(devices):
    by_type = {}
    for dev in devices:
        by_type.setdefault(dev['type'], []).append(dev)

    links = []
    link_id = 1

    def add_link(from_id, to_id):
        nonlocal link_id
        links.append({
            'id': f'l{link_id}',
            'from': from_id,
            'to': to_id,
            'type': 'generic',      # Singular generic type as requested
            'color': '#94a3b8'      # Slate color
        })
        link_id += 1

    print("Connecting network topologically (calculating spatial distances)...")

    # 1. Mesh the Core Routers together
    for i, dev in enumerate(by_type['core-router']):
        if i > 0:
            add_link(dev['id'], by_type['core-router'][i-1]['id'])

    # 2. Edge Routers → 1 nearest Core Router
    for dev in by_type['edge-router']:
        target = get_nearest(dev, by_type['core-router'], k=1)[0]
        add_link(dev['id'], target['id'])

    # 3. OLTs → 1 nearest Edge Router
    for dev in by_type['olt']:
        target = get_nearest(dev, by_type['edge-router'], k=1)[0]
        add_link(dev['id'], target['id'])

    # 4. Customer Routers → 1 nearest OLT
    # (Since there are only 100 OLTs, max_checks won't trigger, giving perfect geographical accuracy)
    for i, dev in enumerate(by_type['customer-router']):
        if i % 10000 == 0 and i > 0:
            print(f"... connected {i} customers")
        target = get_nearest(dev, by_type['olt'], k=1)[0]
        add_link(dev['id'], target['id'])

    return links

def main():
    parser = argparse.ArgumentParser(description='Generate network topology fixtures')
    parser.add_argument('--seed', type=int, help='Random seed for reproducibility')
    args = parser.parse_args()

    if args.seed is not None:
        random.seed(args.seed)
        print(f'Using seed: {args.seed}')
    else:
        print('Using random seed')

    os.makedirs('fixtures', exist_ok=True)

    devices = generate_devices()
    links = generate_links(devices)

    with open('fixtures/devices.json', 'w') as f:
        json.dump(devices, f, indent=2)

    with open('fixtures/links.json', 'w') as f:
        json.dump(links, f, indent=2)

    print(f'Generated {len(devices)} devices and {len(links)} logically clustered links')
    print(f'fixtures/devices.json and fixtures/links.json written')

if __name__ == '__main__':
    main()