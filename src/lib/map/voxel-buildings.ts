import * as THREE from 'three';

/** Cell-centre rasterization preserves courtyards and removes overlapping columns. */
export class VoxelBuildings {
  private heights: Float32Array;
  private bases: Float32Array;
  private colors: Uint32Array;
  constructor(private S: number, private W: number, private H: number) {
    this.heights = new Float32Array(W * H); this.bases = new Float32Array(W * H); this.colors = new Uint32Array(W * H);
  }
  put(x: number, y: number, height: number, base: number, color: string) {
    const ix = Math.floor(x / this.S), iy = Math.floor(y / this.S);
    if (ix < 0 || iy < 0 || ix >= this.W || iy >= this.H) return;
    const i = ix + iy * this.W, h = Math.max(this.S, Math.round(height / this.S) * this.S), b = Math.round(base / this.S) * this.S;
    if (b + h <= this.bases[i] + this.heights[i]) return;
    this.heights[i] = h; this.bases[i] = b; this.colors[i] = new THREE.Color(color).getHex();
  }
  paint(rings: THREE.Vector2[][], height: number, base: number, color: string) {
    const outer = rings[0]; if (!outer?.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of outer) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const inside = (x: number, y: number) => {
      let result = false;
      for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) result = !result;
      }
      return result;
    };
    let filled = 0;
    for (let iy = Math.max(0, Math.floor(y0 / this.S)); iy <= Math.min(this.H - 1, Math.floor(y1 / this.S)); iy++) {
      for (let ix = Math.max(0, Math.floor(x0 / this.S)); ix <= Math.min(this.W - 1, Math.floor(x1 / this.S)); ix++) {
        const x = (ix + .5) * this.S, y = (iy + .5) * this.S;
        if (inside(x, y)) { this.put(x, y, height, base, color); filled++; }
      }
    }
    // Tiny footprints still get a visible block, without filling narrow courtyards.
    if (!filled && rings.length === 1) { const center = outer.reduce((sum, p) => sum.add(p), new THREE.Vector2()).divideScalar(outer.length); this.put(center.x, center.y, height, base, color); }
  }
  mesh(): THREE.InstancedMesh {
    const count = this.heights.reduce((sum, h) => sum + Number(h > 0), 0);
    const box = new THREE.BoxGeometry(1, 1, 1); box.translate(0, .5, 0);
    const material = new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true });
    const size = this.S;
    material.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 voxelPosition; varying vec3 voxelNormal;');
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvoxelPosition=(instanceMatrix*vec4(position,1.0)).xyz;voxelNormal=normal;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 voxelPosition; varying vec3 voxelNormal;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
        vec3 cell=fract(voxelPosition/${size.toFixed(4)});vec3 edge=min(cell,1.0-cell);
        float seam=abs(voxelNormal.y)>.5?min(edge.x,edge.z):min(edge.y,abs(voxelNormal.x)>.5?edge.z:edge.x);
        float fade=1.0-smoothstep(.08,.3,length(fwidth(voxelPosition/${size.toFixed(4)})));
        diffuseColor.rgb*=1.0-.12*(1.0-smoothstep(.008,.025,seam))*fade;`);
    };
    material.customProgramCacheKey = () => `voxel-buildings-${size}`;
    const mesh = new THREE.InstancedMesh(box, material, count); mesh.name = 'voxel-buildings';
    const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), scale = new THREE.Vector3(), rotation = new THREE.Quaternion();
    let instance = 0;
    for (let i = 0; i < this.heights.length; i++) if (this.heights[i]) {
      const x = i % this.W, y = Math.floor(i / this.W);
      matrix.compose(position.set((x + .5) * size, this.bases[i], -(y + .5) * size), rotation, scale.set(size, this.heights[i], size)); mesh.setMatrixAt(instance, matrix);
      mesh.setColorAt(instance++, new THREE.Color(this.colors[i]).multiplyScalar(.96 + ((Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0) / 4294967296 * .08));
    }
    mesh.castShadow = mesh.receiveShadow = true; mesh.frustumCulled = false; return mesh;
  }
}
