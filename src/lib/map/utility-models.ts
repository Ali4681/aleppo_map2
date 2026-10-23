import * as THREE from 'three';
import { NETWORKS, NETWORK_KINDS } from './simulation';
import type { NetworkEdge, NetworkNode, NetworkKind, SimulatedNetworks } from './simulation';

type Item = NetworkEdge | NetworkNode;
type PickBatch = { object: THREE.Object3D; items: Item[]; lineItems?: number[]; kind: NetworkKind };
export function createUtilityModels(data: SimulatedNetworks) {
  const group = new THREE.Group(); group.name = 'simulated-utilities';
  const layers = new Map<NetworkKind, THREE.Group>();
  const batches: PickBatch[] = [], geometries = new Set<THREE.BufferGeometry>();
  const materials: Array<{ material: THREE.MeshStandardMaterial | THREE.LineBasicMaterial; color: string; kind: NetworkKind }> = [];
  const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  function material(kind: NetworkKind, color: string, line = false) {
    const value = line ? new THREE.LineBasicMaterial({ color }) : new THREE.MeshStandardMaterial({ color, roughness: .78, metalness: .22 });
    materials.push({ material: value, color, kind }); return value;
  }
  function instance<T extends Item>(kind: NetworkKind, items: T[], geometry: THREE.BufferGeometry, value: THREE.Material, place: (item: T, index: number) => void) {
    geometries.add(geometry); if (!items.length) return;
    const mesh = new THREE.InstancedMesh(geometry, value, items.length); mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true;
    items.forEach((item, index) => { position.set(0, 0, 0); rotation.identity(); scale.set(1, 1, 1); place(item, index); mesh.setMatrixAt(index, matrix.compose(position, rotation, scale)); });
    layers.get(kind)!.add(mesh); batches.push({ object: mesh, items, kind });
  }
  function nodePosition(node: NetworkNode, y: number) { position.set(node.point[0], y, -node.point[1]); }
  for (const kind of NETWORK_KINDS) {
    const layer = new THREE.Group(); layer.name = kind; layers.set(kind, layer); group.add(layer);
    const spec = NETWORKS[kind], edges = data.edges.filter(edge => edge.kind === kind), nodes = data.nodes.filter(node => node.kind === kind);
    if (spec.overhead) {
      const pole = material(kind, kind === 'electricity' ? '#aaa89d' : '#735946');
      instance(kind, nodes, new THREE.CylinderGeometry(.12, .21, 1, 7), pole, node => { nodePosition(node, (node.height + .35) / 2); scale.y = node.height + .35; });
      const directionAt = new Map<string, number>();
      for (const edge of edges) for (const p of [edge.from, edge.to]) directionAt.set(`${p[0].toFixed(2)},${p[1].toFixed(2)}`, Math.atan2(edge.to[0] - edge.from[0], -(edge.to[1] - edge.from[1])));
      const metal = material(kind, '#626d70');
      if (kind === 'electricity') {
        instance(kind, nodes, new THREE.BoxGeometry(1.8, .12, .16), metal, node => { nodePosition(node, node.height - .35); rotation.setFromAxisAngle(up, directionAt.get(`${node.point[0].toFixed(2)},${node.point[1].toFixed(2)}`) || 0); });
        const insulators = nodes.flatMap(node => [-.6, -.2, .2, .6].map(offset => ({ ...node, offset })));
        instance(kind, insulators, new THREE.CylinderGeometry(.08, .11, .28, 6), material(kind, '#bdd0bc'), node => {
          const angle = directionAt.get(`${node.point[0].toFixed(2)},${node.point[1].toFixed(2)}`) || 0;
          nodePosition(node, node.height - .15); position.x += Math.cos(angle) * node.offset; position.z -= Math.sin(angle) * node.offset;
        });
        const transformers = nodes.filter(node => node.nodeType === 'transformer');
        instance(kind, transformers, new THREE.BoxGeometry(.85, 1.15, .6), material(kind, '#788a85'), node => { nodePosition(node, node.height * .65); position.x += .45; });
        const radiatorRibs = transformers.flatMap(node => [0, 1, 2, 3].map(rib => ({ ...node, rib })));
        instance(kind, radiatorRibs, new THREE.BoxGeometry(.07, .95, .7), metal, node => { nodePosition(node, node.height * .65); position.x += .16 + node.rib * .18; });
      } else {
        instance(kind, nodes.filter(node => node.connections !== 2), new THREE.BoxGeometry(.32, .5, .22), material(kind, '#454d50'), node => { nodePosition(node, 3.1); position.x += .2; });
      }
      const vertices: number[] = [], lineItems: number[] = [];
      const conductors = kind === 'electricity' ? [-.6, -.2, .2, .6] : [0];
      for (const [index, edge] of edges.entries()) {
        const dx = edge.to[0] - edge.from[0], dy = edge.to[1] - edge.from[1], length = Math.hypot(dx, dy);
        const segments = Math.max(3, Math.min(8, Math.ceil(length / 4))), sag = Math.min(.7, length * .025);
        for (const offset of conductors) for (let step = 0; step < segments; step++) {
          for (const t of [step / segments, (step + 1) / segments]) vertices.push(edge.from[0] + dx * t - dy / length * offset, edge.fromHeight + (edge.toHeight - edge.fromHeight) * t - Math.sin(Math.PI * t) * sag, -(edge.from[1] + dy * t + dx / length * offset));
          lineItems.push(index);
        }
      }
      const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geometries.add(geometry);
      const cable = new THREE.LineSegments(geometry, material(kind, kind === 'electricity' ? '#393d38' : '#343537', true));
      cable.name = `${kind}-sagging-wires`; layer.add(cable); batches.push({ object: cable, items: edges, lineItems, kind });
    } else {
      const pipeMaterial = material(kind, kind === 'water' ? '#478897' : '#a17a5c');
      instance(kind, edges, new THREE.CylinderGeometry(1, 1, 1, 8), pipeMaterial, edge => {
        const direction = new THREE.Vector3(edge.to[0] - edge.from[0], edge.toHeight - edge.fromHeight, -(edge.to[1] - edge.from[1]));
        const length = direction.length(); rotation.setFromUnitVectors(up, direction.normalize());
        position.set((edge.from[0] + edge.to[0]) / 2, (edge.fromHeight + edge.toHeight) / 2, -(edge.from[1] + edge.to[1]) / 2);
        const radius = edge.diameterMm / 2000; scale.set(radius, length, radius);
      });
      const iron = material(kind, '#454d4e');
      if (kind === 'sewer') {
        instance(kind, nodes, new THREE.CylinderGeometry(.43, .43, 1, 10, 1, true), material(kind, '#96958b'), node => { nodePosition(node, -node.depth / 2); scale.y = node.depth; });
        instance(kind, nodes, new THREE.CylinderGeometry(.4, .4, .065, 12), iron, node => nodePosition(node, .16));
        const grooves = nodes.flatMap(node => [-1, 0, 1].map(slot => ({ ...node, slot })));
        instance(kind, grooves, new THREE.BoxGeometry(.52, .012, .035), material(kind, '#202a2b'), node => { nodePosition(node, .2); position.z += node.slot * .13; });
        // Arrows are visible in inspection mode and follow decreasing invert levels.
        instance(kind, edges, new THREE.ConeGeometry(.10, .45, 6), material(kind, '#e4be6d'), edge => {
          const direction = new THREE.Vector3(edge.to[0] - edge.from[0], edge.toHeight - edge.fromHeight, -(edge.to[1] - edge.from[1]));
          rotation.setFromUnitVectors(up, direction.normalize()); position.set((edge.from[0] + edge.to[0]) / 2, (edge.fromHeight + edge.toHeight) / 2 + edge.diameterMm / 2000 + .12, -(edge.from[1] + edge.to[1]) / 2);
        });
      } else {
        const valves = nodes.filter(node => node.nodeType === 'valve');
        instance(kind, nodes, new THREE.SphereGeometry(1, 6, 4), pipeMaterial, node => { nodePosition(node, -node.depth); scale.set(.12, .12, .12); });
        instance(kind, valves, new THREE.BoxGeometry(.3, .36, .3), iron, node => nodePosition(node, -node.depth + .08));
        instance(kind, valves, new THREE.CylinderGeometry(.025, .025, .3, 6), iron, node => nodePosition(node, -node.depth + .38));
        const wheel = new THREE.TorusGeometry(.16, .025, 4, 12); wheel.rotateX(Math.PI / 2);
        instance(kind, valves, wheel, material(kind, '#5b8e8c'), node => nodePosition(node, -node.depth + .55));
        instance(kind, valves, new THREE.BoxGeometry(.38, .07, .38), iron, node => nodePosition(node, .15));
      }
    }
  }
  return {
    group, layers,
    setXray(enabled: boolean) {
      for (const { material } of materials) { material.depthTest = !enabled; material.depthWrite = !enabled; material.needsUpdate = true; }
      for (const batch of batches) batch.object.renderOrder = enabled ? 20 : 0;
    },
    setTint(enabled: boolean) { for (const { material, color, kind } of materials) material.color.set(enabled ? NETWORKS[kind].color : color); },
    pick(ray: THREE.Raycaster, maxDistance = Infinity): Item | undefined {
      const oldThreshold = ray.params.Line.threshold; ray.params.Line.threshold = .45;
      const active = batches.filter(batch => layers.get(batch.kind)!.visible);
      const hits = ray.intersectObjects(active.map(batch => batch.object), false); ray.params.Line.threshold = oldThreshold;
      const hit = hits.find(candidate => candidate.distance <= maxDistance + .12); if (!hit) return;
      const batch = active.find(entry => entry.object === hit.object); if (!batch) return;
      const index = batch.lineItems ? batch.lineItems[Math.floor((hit.index ?? 0) / 2)] : hit.instanceId;
      return index === undefined ? undefined : batch.items[index];
    },
    dispose() { group.removeFromParent(); geometries.forEach(geometry => geometry.dispose()); materials.forEach(({ material }) => material.dispose()); },
  };
}
