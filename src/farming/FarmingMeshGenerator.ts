import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Shared materials for the watering can
export const FARMING_MATERIALS = {
  wateringCanBody: new THREE.MeshLambertMaterial({
    color: 0x38bdf8, // Heartopia sky cyan
  }),
  wateringCanTrim: new THREE.MeshLambertMaterial({
    color: 0xf8fafc, // White accent
  }),
};

/** Farming props: the watering can and the field's water-drop indicator texture. */
export class FarmingMeshGenerator {
  /**
   * Generates a stylized Heartopia watering can mesh (carried in character's hand).
   */
  public static createWateringCan(): THREE.Group {
    const group = new THREE.Group();
    group.name = 'HeartopiaWateringCan';

    const bodyGeos: THREE.BufferGeometry[] = [];
    const trimGeos: THREE.BufferGeometry[] = [];

    const s = 0.85;

    // 1. Can body (rounded cylinder)
    const body = new THREE.CylinderGeometry(0.08 * s, 0.095 * s, 0.18 * s, 12);
    body.translate(0, -0.05 * s, 0.08 * s);
    bodyGeos.push(body);

    // Bottom rim
    const bottomRim = new THREE.TorusGeometry(0.095 * s, 0.01 * s, 6, 12);
    bottomRim.rotateX(Math.PI / 2);
    bottomRim.translate(0, -0.14 * s, 0.08 * s);
    trimGeos.push(bottomRim);

    // Top rim
    const topRim = new THREE.TorusGeometry(0.08 * s, 0.01 * s, 6, 12);
    topRim.rotateX(Math.PI / 2);
    topRim.translate(0, 0.04 * s, 0.08 * s);
    trimGeos.push(topRim);

    // 2. Arch handle (grip in palm at 0, 0, 0)
    const handle = new THREE.TorusGeometry(0.10 * s, 0.014 * s, 6, 12, Math.PI);
    handle.rotateY(Math.PI / 2);
    handle.translate(0, 0.02 * s, 0);
    trimGeos.push(handle);

    // 3. Spout (pointing forward +Z and up +Y)
    const spout = new THREE.CylinderGeometry(0.016 * s, 0.026 * s, 0.20 * s, 8);
    spout.rotateX(Math.PI / 3.8);
    spout.translate(0, 0.01 * s, 0.18 * s);
    bodyGeos.push(spout);

    // 4. Sprinkler Rosette Head (rose)
    const rose = new THREE.CylinderGeometry(0.042 * s, 0.016 * s, 0.035 * s, 10);
    rose.rotateX(Math.PI / 3.8);
    rose.translate(0, 0.08 * s, 0.26 * s);
    trimGeos.push(rose);

    const mergedBody = mergeGeometries(bodyGeos)!;
    bodyGeos.forEach((g) => g.dispose());
    const bodyMesh = new THREE.Mesh(mergedBody, FARMING_MATERIALS.wateringCanBody);

    group.add(bodyMesh);

    const mergedTrim = mergeGeometries(trimGeos)!;
    trimGeos.forEach((g) => g.dispose());
    const trimMesh = new THREE.Mesh(mergedTrim, FARMING_MATERIALS.wateringCanTrim);

    group.add(trimMesh);

    // Anchor positioned directly at nozzle tip for accurate particle emission
    const nozzleAnchor = new THREE.Object3D();
    nozzleAnchor.name = 'NozzleAnchor';
    nozzleAnchor.position.set(0, 0.09 * s, 0.28 * s);
    group.add(nozzleAnchor);

    return group;
  }

  /**
   * Generates a procedural 2D Water Droplet CanvasTexture for floating billboard field indicators.
   */
  public static createWaterDropTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');

    if (ctx) {
      // 1. Soft radial glow (cyan aura)
      const glowGrad = ctx.createRadialGradient(64, 68, 0, 64, 68, 56);
      glowGrad.addColorStop(0, 'rgba(56, 189, 248, 0.50)');
      glowGrad.addColorStop(0.5, 'rgba(14, 165, 233, 0.22)');
      glowGrad.addColorStop(1.0, 'rgba(14, 165, 233, 0.0)');

      ctx.fillStyle = glowGrad;
      ctx.beginPath();
      ctx.arc(64, 68, 56, 0, Math.PI * 2);
      ctx.fill();

      // 2. Soft shadow under drop
      ctx.shadowColor = 'rgba(2, 132, 199, 0.65)';
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 4;

      // 3. Teardrop path
      ctx.beginPath();
      ctx.moveTo(64, 18);
      ctx.bezierCurveTo(74, 38, 96, 60, 96, 78);
      ctx.arc(64, 78, 32, 0, Math.PI, false);
      ctx.bezierCurveTo(32, 60, 54, 38, 64, 18);
      ctx.closePath();

      // Drop gradient fill
      const dropGrad = ctx.createLinearGradient(64, 18, 64, 110);
      dropGrad.addColorStop(0, '#f0f9ff'); // Top ice cyan sheen
      dropGrad.addColorStop(0.28, '#38bdf8'); // Sky cyan
      dropGrad.addColorStop(0.72, '#0284c7'); // Ocean blue
      dropGrad.addColorStop(1.0, '#0369a1'); // Deep base blue

      ctx.fillStyle = dropGrad;
      ctx.fill();

      ctx.shadowColor = 'transparent';

      // Crisp white border
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();

      // 4. Glossy curved highlight reflection
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(54, 54, 7, 18, -Math.PI / 6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.fill();
      ctx.restore();

      // 5. Specular dot highlight
      ctx.beginPath();
      ctx.arc(74, 82, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }
}
