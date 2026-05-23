import argparse
import random
import json
import os

# Bangladesh bounding box
LAT_MIN, LAT_MAX = 20.7, 26.6
LNG_MIN, LNG_MAX = 88.0, 92.7

# Device distribution for 60,000 total
DEVICE_COUNTS = {
    'core-router':  300,    # 0.5%
    'router':       6000,   # 10%
    'switch':       18000,  # 30%
    'edge-router':  12000,  # 20%
    'server':       23700,  # 39.5%
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

def generate_links(devices):
    by_type = {}
    for dev in devices:
        by_type.setdefault(dev['type'], []).append(dev['id'])

    links = []
    link_id = 1

    def add_link(from_id, to_id, link_type, color):
        nonlocal link_id
        links.append({
            'id': f'l{link_id}',
            'from': from_id,
            'to': to_id,
            'type': link_type,
            'color': color
        })
        link_id += 1

    # routers → 1-2 core-routers (fiber)
    for dev_id in by_type['router']:
        targets = random.sample(by_type['core-router'], random.randint(1, 2))
        for t in targets:
            add_link(dev_id, t, 'fiber', '#22d3ee')

    # switches → 1-2 routers (fiber)
    for dev_id in by_type['switch']:
        targets = random.sample(by_type['router'], random.randint(1, 2))
        for t in targets:
            add_link(dev_id, t, 'fiber', '#22d3ee')

    # edge-routers → 1 switch (copper)
    for dev_id in by_type['edge-router']:
        add_link(dev_id, random.choice(by_type['switch']), 'copper', '#f59e0b')

    # servers → 1 switch or edge-router (copper)
    pool = by_type['switch'] + by_type['edge-router']
    for dev_id in by_type['server']:
        add_link(dev_id, random.choice(pool), 'copper', '#f59e0b')

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

    print(f'Generated {len(devices)} devices and {len(links)} links')
    print(f'fixtures/devices.json and fixtures/links.json written')

if __name__ == '__main__':
    main()