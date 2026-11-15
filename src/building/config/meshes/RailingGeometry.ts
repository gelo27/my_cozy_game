import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MODULE_SIZE, HALF_SIZE } from '../BuildingConstants';
import { BUILDING_MATERIALS } from '../BuildingMaterials';
import type { PieceMeshTemplate } from './PieceMeshTemplate';

/**
 * Builds stylized straight wood railing geometry with end/center newel posts,
 * top handrail, bottom rail, and vertical baluster pickets.
 */
export function buildStraightRailingGeometry(width: number, height: number = 0.95): PieceMeshTemplate {
  const woodGeos: THREE.BufferGeometry[] = [];
  const darkGeos: THREE.BufferGeometry[] = [];

  const postThickness = 0.08;
  const postHalfW = width / 2.0 - postThickness / 2.0;

  // 1. End posts (newel posts)
  const postLeft = new THREE.BoxGeometry(postThickness, height, postThickness);
  postLeft.translate(-postHalfW, 0, 0);
  darkGeos.push(postLeft);

  const postRight = new THREE.BoxGeometry(postThickness, height, postThickness);
  postRight.translate(postHalfW, 0, 0);
  darkGeos.push(postRight);

  // Decorative post caps
  const capGeoL = new THREE.BoxGeometry(postThickness * 1.25, 0.03, postThickness * 1.25);
  capGeoL.translate(-postHalfW, height / 2.0 + 0.015, 0);
  darkGeos.push(capGeoL);

  const capGeoR = new THREE.BoxGeometry(postThickness * 1.25, 0.03, postThickness * 1.25);
  capGeoR.translate(postHalfW, height / 2.0 + 0.015, 0);
  darkGeos.push(capGeoR);

  // Center post if 2m railing
  if (width >= 1.5) {
    const postMid = new THREE.BoxGeometry(postThickness, height, postThickness);
    darkGeos.push(postMid);
    const capMid = new THREE.BoxGeometry(postThickness * 1.25, 0.03, postThickness * 1.25);
    capMid.translate(0, height / 2.0 + 0.015, 0);
    darkGeos.push(capMid);
  }

  // 2. Top handrail (поручень - profiled dark wood)
  const handrailH = 0.06;
  const handrailD = 0.10;
  const topHandrail = new THREE.BoxGeometry(width, handrailH, handrailD);
  topHandrail.translate(0, height / 2.0 - handrailH / 2.0, 0);
  darkGeos.push(topHandrail);

  // 3. Bottom rail (нижня балка - slightly raised off floor)
  const bottomRailH = 0.04;
  const bottomRailD = 0.06;
  const bottomRailY = -height / 2.0 + 0.08;
  const bottomRail = new THREE.BoxGeometry(width - 0.02, bottomRailH, bottomRailD);
  bottomRail.translate(0, bottomRailY, 0);
  woodGeos.push(bottomRail);

  // 4. Vertical balusters (балясини)
  const balusterH = (height / 2.0 - handrailH) - (bottomRailY + bottomRailH / 2.0);
  const balusterY = bottomRailY + bottomRailH / 2.0 + balusterH / 2.0;
  const balusterThick = 0.035;

  if (width >= 1.5) {
    // 3 balusters on left span, 3 on right span
    const halfSpan = width / 2.0 - postThickness;
    const subStep = halfSpan / 4.0;
    for (let i = 1; i <= 3; i++) {
      const bL = new THREE.BoxGeometry(balusterThick, balusterH, balusterThick);
      bL.translate(-postThickness / 2.0 - i * subStep, balusterY, 0);
      woodGeos.push(bL);

      const bR = new THREE.BoxGeometry(balusterThick, balusterH, balusterThick);
      bR.translate(postThickness / 2.0 + i * subStep, balusterY, 0);
      woodGeos.push(bR);
    }
  } else {
    // 3 balusters evenly spaced on 1m railing
    const span = width - postThickness * 2;
    const subStep = span / 4.0;
    for (let i = 1; i <= 3; i++) {
      const bx = -postHalfW + i * subStep;
      const b = new THREE.BoxGeometry(balusterThick, balusterH, balusterThick);
      b.translate(bx, balusterY, 0);
      woodGeos.push(b);
    }
  }

  const mergedWood = mergeGeometries(woodGeos)!;
  woodGeos.forEach((g) => g.dispose());

  const mergedDark = mergeGeometries(darkGeos)!;
  darkGeos.forEach((g) => g.dispose());

  const finalGeo = mergeGeometries([mergedWood, mergedDark], true)!;
  mergedWood.dispose();
  mergedDark.dispose();

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.wood, BUILDING_MATERIALS.woodDark],
    boundingBox: new THREE.Box3(),
  };
}

/**
 * Builds stylized 45-degree sloped stair railing geometry for WOOD_STAIRS_2X2.
 * Mounts flush to stair sockets side_left and side_right.
 */
export function buildStairRailingGeometry(): PieceMeshTemplate {
  const woodGeos: THREE.BufferGeometry[] = [];
  const darkGeos: THREE.BufferGeometry[] = [];

  const slopeLength = Math.sqrt(2) * MODULE_SIZE; // 2.828m
  const postThickness = 0.08;

  // 1. Bottom newel post at landing foot (z = -HALF_SIZE = -1.0, y goes from -1.0 to 0.0)
  const postBot = new THREE.BoxGeometry(postThickness, 1.0, postThickness);
  postBot.translate(0, -0.5, -HALF_SIZE);
  darkGeos.push(postBot);

  const capBot = new THREE.BoxGeometry(postThickness * 1.25, 0.03, postThickness * 1.25);
  capBot.translate(0, 0.015, -HALF_SIZE);
  darkGeos.push(capBot);

  // 2. Top newel post at top landing (z = HALF_SIZE = 1.0, y goes from 1.0 to 2.0)
  const postTop = new THREE.BoxGeometry(postThickness, 1.0, postThickness);
  postTop.translate(0, 1.5, HALF_SIZE);
  darkGeos.push(postTop);

  const capTop = new THREE.BoxGeometry(postThickness * 1.25, 0.03, postThickness * 1.25);
  capTop.translate(0, 2.015, HALF_SIZE);
  darkGeos.push(capTop);

  // 3. Middle newel post at half-flight (z = 0, y goes from 0.0 to 1.0)
  const postMid = new THREE.BoxGeometry(postThickness, 1.0, postThickness);
  postMid.translate(0, 0.5, 0);
  darkGeos.push(postMid);

  const capMid = new THREE.BoxGeometry(postThickness * 1.25, 0.03, postThickness * 1.25);
  capMid.translate(0, 1.015, 0);
  darkGeos.push(capMid);

  // 4. Slanted top handrail (angle = -45 deg, connecting post tops from y=0 to y=2)
  const handrailH = 0.06;
  const handrailD = 0.10;
  const handrail = new THREE.BoxGeometry(handrailD, handrailH, slopeLength * 1.02);
  handrail.rotateX(-Math.PI / 4);
  handrail.translate(0, 1.0 - handrailH / 2.0, 0);
  darkGeos.push(handrail);

  // 5. Slanted bottom rail (parallel to handrail, ~0.25 above step line)
  const botRailH = 0.04;
  const botRailD = 0.06;
  const botRail = new THREE.BoxGeometry(botRailD, botRailH, slopeLength * 1.02);
  botRail.rotateX(-Math.PI / 4);
  botRail.translate(0, 0.25, 0);
  woodGeos.push(botRail);

  // 6. Vertical balusters for steps (5 steps along the run)
  const balusterThick = 0.035;
  const stepCount = 5;
  const stepD = MODULE_SIZE / stepCount; // 0.4m

  for (let i = 0; i < stepCount; i++) {
    // Skip i = 2 because middle post is at z = 0
    if (i === 2) continue;
    const z = -HALF_SIZE + (i + 0.5) * stepD;
    const stepCenterY = z; // on 45-degree slope, y = z
    const balusterBotY = stepCenterY + 0.25 + botRailH / 2.0;
    const balusterTopY = stepCenterY + 1.0 - handrailH;
    const bH = balusterTopY - balusterBotY;

    const baluster = new THREE.BoxGeometry(balusterThick, bH, balusterThick);
    baluster.translate(0, balusterBotY + bH / 2.0, z);
    woodGeos.push(baluster);
  }

  const mergedWood = mergeGeometries(woodGeos)!;
  woodGeos.forEach((g) => g.dispose());

  const mergedDark = mergeGeometries(darkGeos)!;
  darkGeos.forEach((g) => g.dispose());

  const finalGeo = mergeGeometries([mergedWood, mergedDark], true)!;
  mergedWood.dispose();
  mergedDark.dispose();

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.wood, BUILDING_MATERIALS.woodDark],
    boundingBox: new THREE.Box3(),
  };
}

/**
 * Builds a charming stylized white decorative picket fence 1x1m (Heartopia / Animal Crossing aesthetic)
 * with end newel posts with 4-sided pyramid diamond caps, bottom base plinths,
 * horizontal cross rails, and 4 vertical pickets with pointed spearhead triangular tips and rivet accents.
 */
export function buildWhiteDecorativeFenceGeometry(): PieceMeshTemplate {
  const whiteGeos: THREE.BufferGeometry[] = [];
  const postGeos: THREE.BufferGeometry[] = [];
  const hardwareGeos: THREE.BufferGeometry[] = [];

  const postThickness = 0.08;
  const postHalfW = 0.5 - postThickness / 2.0; // 0.46m

  // 1. Two main end newel posts (Left at -0.46, Right at +0.46)
  for (const px of [-postHalfW, postHalfW]) {
    // Post shaft (height 0.92, from y = -0.475 to y = 0.445)
    const shaft = new THREE.BoxGeometry(postThickness, 0.92, postThickness);
    shaft.translate(px, -0.015, 0);
    postGeos.push(shaft);

    // Base plinth / foot trim
    const base = new THREE.BoxGeometry(postThickness * 1.2, 0.04, postThickness * 1.2);
    base.translate(px, -0.455, 0);
    postGeos.push(base);

    // Neck collar band
    const collar = new THREE.BoxGeometry(postThickness * 1.15, 0.02, postThickness * 1.15);
    collar.translate(px, 0.40, 0);
    postGeos.push(collar);

    // Cap base molding
    const capBase = new THREE.BoxGeometry(postThickness * 1.3, 0.025, postThickness * 1.3);
    capBase.translate(px, 0.445, 0);
    postGeos.push(capBase);

    // Pyramid diamond finial cap atop post (4-sided pyramid)
    const capTop = new THREE.CylinderGeometry(0, postThickness * 0.92, 0.07, 4);
    capTop.rotateY(Math.PI / 4); // Align pyramid faces squarely with post sides
    capTop.translate(px, 0.49, 0);
    postGeos.push(capTop);
  }

  // 2. Horizontal support crossrails (spanning between inner faces of posts, length ~0.84m)
  const railLength = 1.0 - postThickness * 2; // 0.84m
  const railH = 0.04;
  const railD = 0.034;
  const railZ = -0.014;

  const topRail = new THREE.BoxGeometry(railLength, railH, railD);
  topRail.translate(0, 0.18, railZ);
  whiteGeos.push(topRail);

  const botRail = new THREE.BoxGeometry(railLength, railH, railD);
  botRail.translate(0, -0.22, railZ);
  whiteGeos.push(botRail);

  // 3. Four vertical pickets with pointed spearhead tips (fully indexed BufferGeometries)
  const picketX = [-0.315, -0.105, 0.105, 0.315];
  const pw = 0.072;
  const pd = 0.022;
  const bodyH = 0.64;
  const tipH = 0.07; // Pointed spearhead tip

  for (const px of picketX) {
    // Picket body shaft (from y = -0.355 to y = 0.285)
    const body = new THREE.BoxGeometry(pw, bodyH, pd);
    body.translate(px, -0.035, 0.012);
    whiteGeos.push(body);

    // Spearhead 4-sided pointed tip atop picket
    const tip = new THREE.CylinderGeometry(0, pw / Math.SQRT2, tipH, 4);
    tip.rotateY(Math.PI / 4);
    tip.scale(1, 1, pd / pw);
    tip.translate(px, 0.285 + tipH / 2, 0.012);
    whiteGeos.push(tip);

    // Decorative bolt rivets at rail intersections
    for (const py of [0.18, -0.22]) {
      const bolt = new THREE.CylinderGeometry(0.005, 0.005, 0.004, 8);
      bolt.rotateX(Math.PI / 2);
      bolt.translate(px, py, 0.025);
      hardwareGeos.push(bolt);
    }
  }

  const mergedWhite = mergeGeometries(whiteGeos)!;
  whiteGeos.forEach((g) => g.dispose());

  const mergedPost = mergeGeometries(postGeos)!;
  postGeos.forEach((g) => g.dispose());

  const mergedHardware = mergeGeometries(hardwareGeos)!;
  hardwareGeos.forEach((g) => g.dispose());

  const finalGeo = mergeGeometries([mergedWhite, mergedPost, mergedHardware], true)!;
  mergedWhite.dispose();
  mergedPost.dispose();
  mergedHardware.dispose();

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.whiteWood, BUILDING_MATERIALS.whiteWoodPost, BUILDING_MATERIALS.fenceHardware],
    boundingBox: new THREE.Box3(),
  };
}
