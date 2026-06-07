import json
from collections import defaultdict

def analyze_topology(links_file='fixtures/links.json'):
    print("Loading network data...")
    with open(links_file, 'r') as f:
        links = json.load(f)

    # 1. Count connections per device
    connections = defaultdict(int)
    up_links = {} # Maps Child -> Parent (e.g., Customer -> OLT)

    for link in links:
        source = link['from']
        target = link['to']
        
        connections[source] += 1
        connections[target] += 1
        
        # Build pathfinding dictionary (Child points to Parent)
        # Note: We ignore core-to-core links for the up_link dictionary
        if "core" not in source:
            up_links[source] = target

    # Group the connection counts by device type
    stats = defaultdict(list)
    for dev_id, count in connections.items():
        # Extract the text type (e.g., "customer-router-123" -> "customer-router")
        dev_type = "-".join(dev_id.split('-')[:-1])
        stats[dev_type].append(count)

    print("\n=== NETWORK GRAPH STATS (Node Degree) ===")
    for dev_type, counts in stats.items():
        avg = sum(counts) / len(counts)
        min_c = min(counts)
        max_c = max(counts)
        print(f"{dev_type.upper():<16}: Avg {avg:.1f} links | Min {min_c} | Max {max_c} | Total Devices: {len(counts)}")


    # 2. Test Hop Counts (Customer to Core)
    print("\n=== HOP COUNT VALIDATION ===")
    hop_counts = []
    broken_paths = 0

    for dev_id in connections.keys():
        if dev_id.startswith("customer"):
            hops = 0
            current = dev_id
            
            # Trace the path up to the core
            while current in up_links:
                current = up_links[current]
                hops += 1
                if current.startswith("core"):
                    break
            
            if current.startswith("core"):
                hop_counts.append(hops)
            else:
                broken_paths += 1

    if not hop_counts:
        print("CRITICAL ERROR: No customers can reach the core network!")
    else:
        avg_hops = sum(hop_counts) / len(hop_counts)
        print(f"Total Customers Checked : {len(hop_counts)}")
        print(f"Broken/Lost Connections : {broken_paths}")
        print(f"Average Hops to Core    : {avg_hops:.1f}")
        
        if avg_hops == 3.0 and broken_paths == 0:
            print("RESULT                  : PASSED ✅ (Strict 3-Hop Hierarchy Confirmed)")
        else:
            print("RESULT                  : FAILED ❌ (Topology is leaking or inefficient)")

if __name__ == '__main__':
    analyze_topology()