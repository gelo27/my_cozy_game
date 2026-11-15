import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MODULE_SIZE, WALL_THICKNESS } from '../BuildingConstants';
import { BUILDING_MATERIALS } from '../BuildingMaterials';
import type { PieceMeshTemplate } from './PieceMeshTemplate';
import { WALL_EDGE_MATERIAL } from '../DefaultWallMaterials';

/**
 * Builds stylized separate window geometry with larger outer frame,
 * smaller inner frame, cross-braces, translucent glass, and warm honey checker texture.
 */
export function buildWindowPieceGeometry(width: number, height: number): PieceMeshTemplate {
  // 1. Larger outer frame (рамка зовнішня більша)
  const outerBorder = 0.12;
  const outerThickness = 0.16; // slightly thicker than wall (0.12)

  const outerTop = new THREE.BoxGeometry(width, outerBorder, outerThickness);
  outerTop.translate(0, height / 2 - outerBorder / 2, 0);

  const outerBottom = new THREE.BoxGeometry(width, outerBorder, outerThickness);
  outerBottom.translate(0, -height / 2 + outerBorder / 2, 0);

  const outerHeight = Math.max(0.1, height - outerBorder * 2);
  const outerLeft = new THREE.BoxGeometry(outerBorder, outerHeight, outerThickness);
  outerLeft.translate(-width / 2 + outerBorder / 2, 0, 0);

  const outerRight = new THREE.BoxGeometry(outerBorder, outerHeight, outerThickness);
  outerRight.translate(width / 2 - outerBorder / 2, 0, 0);

  // 2. Smaller inner frame (рамка внутрішня менша)
  const innerMargin = outerBorder;
  const innerOpeningW = width - innerMargin * 2;
  const innerOpeningH = height - innerMargin * 2;
  const innerBorder = 0.05;
  const innerThickness = 0.13;

  const innerTop = new THREE.BoxGeometry(innerOpeningW, innerBorder, innerThickness);
  innerTop.translate(0, innerOpeningH / 2 - innerBorder / 2, 0);

  const innerBottom = new THREE.BoxGeometry(innerOpeningW, innerBorder, innerThickness);
  innerBottom.translate(0, -innerOpeningH / 2 + innerBorder / 2, 0);

  const innerMidH = Math.max(0.05, innerOpeningH - innerBorder * 2);
  const innerLeft = new THREE.BoxGeometry(innerBorder, innerMidH, innerThickness);
  innerLeft.translate(-innerOpeningW / 2 + innerBorder / 2, 0, 0);

  const innerRight = new THREE.BoxGeometry(innerBorder, innerMidH, innerThickness);
  innerRight.translate(innerOpeningW / 2 - innerBorder / 2, 0, 0);

  // 3. Cross-bracing / crossbars (з перехрестями)
  const crossThickness = 0.11;
  const crossWidth = 0.04;
  const crossHoriz = new THREE.BoxGeometry(innerOpeningW - innerBorder * 2, crossWidth, crossThickness);
  const crossVert = new THREE.BoxGeometry(crossWidth, innerOpeningH - innerBorder * 2, crossThickness);

  // Merge all frame parts together using the windowChecker material (different color checker!)
  const frameParts = [
    outerTop, outerBottom, outerLeft, outerRight,
    innerTop, innerBottom, innerLeft, innerRight,
    crossHoriz, crossVert,
  ];
  const mergedFrame = mergeGeometries(frameParts)!;
  for (const p of frameParts) {
    p.dispose();
  }

  // 4. Glass pane in center
  const glassW = Math.max(0.1, innerOpeningW - innerBorder * 2);
  const glassH = Math.max(0.1, innerOpeningH - innerBorder * 2);
  const glassGeo = new THREE.BoxGeometry(glassW, glassH, 0.02);

  // Combined geometry with material groups:
  // group 0 = windowChecker material (outer/inner frames + cross)
  // group 1 = windowGlass material (center translucent pane)
  const finalGeo = mergeGeometries([mergedFrame, glassGeo], true)!;
  mergedFrame.dispose();
  glassGeo.dispose();

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.windowChecker, BUILDING_MATERIALS.windowGlass],
    boundingBox: new THREE.Box3(),
  };
}

export function buildOuterDoorFrameGeometry(width: number, height: number): PieceMeshTemplate {
  const topHeaderH = 0.12;
  const jambW = width === 2.0 ? 0.10 : 0.08;
  const openingW = width - jambW * 2;
  const openingH = height - topHeaderH;
  const frameDepth = WALL_THICKNESS;
  const trimDepth = WALL_THICKNESS + 0.04;
  const trimW = 0.05;

  // 1. Core door frame posts (top header, left jamb, right jamb) - woodDark material
  const topHeader = new THREE.BoxGeometry(width, topHeaderH, frameDepth);
  topHeader.translate(0, height / 2 - topHeaderH / 2, 0);

  const leftJamb = new THREE.BoxGeometry(jambW, openingH, frameDepth);
  leftJamb.translate(-width / 2 + jambW / 2, -height / 2 + openingH / 2, 0);

  const rightJamb = new THREE.BoxGeometry(jambW, openingH, frameDepth);
  rightJamb.translate(width / 2 - jambW / 2, -height / 2 + openingH / 2, 0);

  const mergedJambs = mergeGeometries([topHeader, leftJamb, rightJamb])!;
  topHeader.dispose(); leftJamb.dispose(); rightJamb.dispose();

  // 2. Decorative outer casing / trim (рамка зверху, зліва, справа)
  const topTrim = new THREE.BoxGeometry(openingW + trimW * 2, trimW, trimDepth);
  topTrim.translate(0, -height / 2 + openingH - trimW / 2, 0);

  const leftTrim = new THREE.BoxGeometry(trimW, openingH, trimDepth);
  leftTrim.translate(-openingW / 2 - trimW / 2, -height / 2 + openingH / 2, 0);

  const rightTrim = new THREE.BoxGeometry(trimW, openingH, trimDepth);
  rightTrim.translate(openingW / 2 + trimW / 2, -height / 2 + openingH / 2, 0);

  const mergedTrim = mergeGeometries([topTrim, leftTrim, rightTrim])!;
  topTrim.dispose(); leftTrim.dispose(); rightTrim.dispose();

  const finalGeo = mergeGeometries([mergedJambs, mergedTrim], true)!;
  mergedJambs.dispose(); mergedTrim.dispose();

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.woodDark, BUILDING_MATERIALS.woodDark],
    boundingBox: new THREE.Box3(),
  };
}

export function buildDoorwayWallGeometry(width: number, height: number): PieceMeshTemplate {
  const topHeaderH = 0.12;
  const jambW = width === 2.0 ? 0.10 : 0.08;
  const openingW = width - jambW * 2;
  const openingH = height - topHeaderH;

  // 1. Main wall body lintel & posts (plain white, like the default wall edges)
  const lintelGeo = new THREE.BoxGeometry(width, topHeaderH, WALL_THICKNESS);
  lintelGeo.translate(0, height / 2 - topHeaderH / 2, 0);

  const leftPostGeo = new THREE.BoxGeometry(jambW, openingH, WALL_THICKNESS);
  leftPostGeo.translate(-width / 2 + jambW / 2, -height / 2 + openingH / 2, 0);

  const rightPostGeo = new THREE.BoxGeometry(jambW, openingH, WALL_THICKNESS);
  rightPostGeo.translate(width / 2 - jambW / 2, -height / 2 + openingH / 2, 0);

  const mergedWallBody = mergeGeometries([lintelGeo, leftPostGeo, rightPostGeo])!;
  lintelGeo.dispose(); leftPostGeo.dispose(); rightPostGeo.dispose();

  // 2. Door frame trim (зверху, зліва, справа) - woodDark material
  const trimThickness = WALL_THICKNESS + 0.04;
  const trimBorder = 0.05;

  const topTrim = new THREE.BoxGeometry(openingW + trimBorder * 2, trimBorder, trimThickness);
  topTrim.translate(0, -height / 2 + openingH - trimBorder / 2, 0);

  const leftTrim = new THREE.BoxGeometry(trimBorder, openingH, trimThickness);
  leftTrim.translate(-openingW / 2 - trimBorder / 2, -height / 2 + openingH / 2, 0);

  const rightTrim = new THREE.BoxGeometry(trimBorder, openingH, trimThickness);
  rightTrim.translate(openingW / 2 + trimBorder / 2, -height / 2 + openingH / 2, 0);

  const mergedTrim = mergeGeometries([topTrim, leftTrim, rightTrim])!;
  topTrim.dispose(); leftTrim.dispose(); rightTrim.dispose();

  const finalGeo = mergeGeometries([mergedWallBody, mergedTrim], true)!;
  mergedWallBody.dispose(); mergedTrim.dispose();

  return {
    geometry: finalGeo,
    materials: [WALL_EDGE_MATERIAL, BUILDING_MATERIALS.woodDark],
    boundingBox: new THREE.Box3(),
  };
}

export function buildSingleDoorGeometry(): PieceMeshTemplate {
  const width = 0.84;
  const height = 1.88;
  const thickness = 0.06;

  // 1. Door panel leaf (wood material)
  const leafGeo = new THREE.BoxGeometry(width, height, thickness);

  // 2. Border & cross bracing (woodDark material)
  const borderW = 0.06;
  const topB = new THREE.BoxGeometry(width, borderW, thickness + 0.015);
  topB.translate(0, height / 2 - borderW / 2, 0);

  const botB = new THREE.BoxGeometry(width, borderW, thickness + 0.015);
  botB.translate(0, -height / 2 + borderW / 2, 0);

  const midB = new THREE.BoxGeometry(width, borderW, thickness + 0.015);
  midB.translate(0, 0, 0);

  const leftB = new THREE.BoxGeometry(borderW, height, thickness + 0.015);
  leftB.translate(-width / 2 + borderW / 2, 0, 0);

  const rightB = new THREE.BoxGeometry(borderW, height, thickness + 0.015);
  rightB.translate(width / 2 - borderW / 2, 0, 0);

  const mergedFrame = mergeGeometries([topB, botB, midB, leftB, rightB])!;
  topB.dispose(); botB.dispose(); midB.dispose(); leftB.dispose(); rightB.dispose();

  // 3. Handles & hinges (iron / woodDark material)
  const handleGeo = new THREE.BoxGeometry(0.04, 0.14, 0.12);
  handleGeo.translate(width / 2 - 0.10, 0, 0);

  const topHinge = new THREE.BoxGeometry(0.03, 0.1, 0.08);
  topHinge.translate(-width / 2 + 0.01, height * 0.3, 0);

  const botHinge = new THREE.BoxGeometry(0.03, 0.1, 0.08);
  botHinge.translate(-width / 2 + 0.01, -height * 0.3, 0);

  const mergedIron = mergeGeometries([handleGeo, topHinge, botHinge])!;
  handleGeo.dispose(); topHinge.dispose(); botHinge.dispose();

  const finalGeo = mergeGeometries([leafGeo, mergedFrame, mergedIron], true)!;
  leafGeo.dispose(); mergedFrame.dispose(); mergedIron.dispose();

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.wood, BUILDING_MATERIALS.woodDark, BUILDING_MATERIALS.woodDark],
    boundingBox: new THREE.Box3(),
  };
}

export function buildDoubleDoorGeometry(): PieceMeshTemplate {
  const leafW = 0.90;

  const singleTpl = buildSingleDoorGeometry();

  const leftGeo = singleTpl.geometry.clone();
  leftGeo.translate(-leafW / 2 - 0.005, 0, 0);

  const rightGeo = singleTpl.geometry.clone();
  rightGeo.rotateY(Math.PI);
  rightGeo.translate(leafW / 2 + 0.005, 0, 0);

  const merged = mergeGeometries([leftGeo, rightGeo], true)!;
  leftGeo.dispose();
  rightGeo.dispose();

  return {
    geometry: merged,
    materials: [BUILDING_MATERIALS.wood, BUILDING_MATERIALS.woodDark, BUILDING_MATERIALS.woodDark],
    boundingBox: new THREE.Box3(),
  };
}

// -------------------------------------------------------------------------------------------------
// NEW DOOR GENERATORS (GRAND ENTRY WITH SIDELITES, WHITE SHAKER, COTTAGE WINDOW, COLONIAL 6-PANEL)
// -------------------------------------------------------------------------------------------------

/**
 * 1. Grand Entry Door 2x2m: Stationary frame with left & right sidelites (window glazing & kick panels)
 */
export function buildGrandSideliteDoorFrameGeometry(): PieceMeshTemplate {
  const woodGeos: THREE.BufferGeometry[] = [];
  const glassGeos: THREE.BufferGeometry[] = [];

  const width = MODULE_SIZE; // 2.0m
  const height = MODULE_SIZE; // 2.0m
  const frameD = WALL_THICKNESS; // 0.20m
  const trimD = WALL_THICKNESS + 0.04;

  // Header beam across top
  const headerH = 0.12;
  const header = new THREE.BoxGeometry(width, headerH, frameD);
  header.translate(0, height / 2 - headerH / 2, 0);
  woodGeos.push(header);

  // Bottom threshold / sill
  const threshH = 0.04;
  const thresh = new THREE.BoxGeometry(width, threshH, frameD + 0.02);
  thresh.translate(0, -height / 2 + threshH / 2, 0);
  woodGeos.push(thresh);

  const innerH = height - headerH - threshH; // 1.84m
  const innerCenterY = -height / 2 + threshH + innerH / 2; // -0.04m

  // Outer jamb posts (left at -0.97, right at +0.97)
  const outerPostW = 0.06;
  const leftOuterPost = new THREE.BoxGeometry(outerPostW, innerH, frameD);
  leftOuterPost.translate(-width / 2 + outerPostW / 2, innerCenterY, 0);
  woodGeos.push(leftOuterPost);

  const rightOuterPost = new THREE.BoxGeometry(outerPostW, innerH, frameD);
  rightOuterPost.translate(width / 2 - outerPostW / 2, innerCenterY, 0);
  woodGeos.push(rightOuterPost);

  // Inner vertical mullion posts dividing sidelites from center door opening (center door opening width = 0.88m)
  const mullionW = 0.06;
  const mullionX = 0.44 + mullionW / 2; // 0.47m
  const leftMullion = new THREE.BoxGeometry(mullionW, innerH, frameD);
  leftMullion.translate(-mullionX, innerCenterY, 0);
  woodGeos.push(leftMullion);

  const rightMullion = new THREE.BoxGeometry(mullionW, innerH, frameD);
  rightMullion.translate(mullionX, innerCenterY, 0);
  woodGeos.push(rightMullion);

  // Sidelite openings: from x = -0.94 to -0.44 (width 0.50m, center -0.69m) and x = +0.44 to +0.94
  const sideliteW = 0.50;
  const sideliteCenterX = 0.69;

  for (const sx of [-sideliteCenterX, sideliteCenterX]) {
    // Solid wood bottom kick panel
    const kickH = 0.36;
    const kickY = -height / 2 + threshH + kickH / 2;
    const kick = new THREE.BoxGeometry(sideliteW - 0.02, kickH, frameD * 0.7);
    kick.translate(sx, kickY, 0);
    woodGeos.push(kick);

    // Decorative molding around kick panel
    const kickTrim = new THREE.BoxGeometry(sideliteW - 0.06, kickH - 0.06, frameD * 0.76);
    kickTrim.translate(sx, kickY, 0);
    woodGeos.push(kickTrim);

    // Translucent glass pane for sidelite window
    const glassH = innerH - kickH - 0.02; // ~1.46m
    const glassY = -height / 2 + threshH + kickH + glassH / 2;
    const glass = new THREE.BoxGeometry(sideliteW - 0.04, glassH, 0.012);
    glass.translate(sx, glassY, 0);
    glassGeos.push(glass);

    // 4 horizontal wooden muntin dividing bars across glass
    const muntinH = 0.025;
    const muntinD = 0.035;
    const barSpacing = glassH / 5;
    for (let b = 1; b <= 4; b++) {
      const by = glassY - glassH / 2 + b * barSpacing;
      const muntin = new THREE.BoxGeometry(sideliteW - 0.04, muntinH, muntinD);
      muntin.translate(sx, by, 0);
      woodGeos.push(muntin);
    }
  }

  // Exterior & interior decorative casing trim around frame
  const trimW = 0.06;
  const topTrim = new THREE.BoxGeometry(width + 0.08, trimW, trimD);
  topTrim.translate(0, height / 2 - headerH + trimW / 2, 0);
  woodGeos.push(topTrim);

  const leftTrim = new THREE.BoxGeometry(trimW, height, trimD);
  leftTrim.translate(-width / 2 + trimW / 2, 0, 0);
  woodGeos.push(leftTrim);

  const rightTrim = new THREE.BoxGeometry(trimW, height, trimD);
  rightTrim.translate(width / 2 - trimW / 2, 0, 0);
  woodGeos.push(rightTrim);

  const mergedWood = mergeGeometries(woodGeos)!;
  woodGeos.forEach((g) => g.dispose());

  const mergedGlass = mergeGeometries(glassGeos)!;
  glassGeos.forEach((g) => g.dispose());

  const finalGeo = mergeGeometries([mergedWood, mergedGlass], true)!;
  mergedWood.dispose();
  mergedGlass.dispose();

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.woodMahogany, BUILDING_MATERIALS.windowGlass],
    boundingBox: new THREE.Box3(),
  };
}

/**
 * 1b. Grand Mahogany Center Door Leaf (8 molded recessed panels with rich dark bronze pull hardware)
 */
export function buildGrandMahoganyDoorLeaf(): PieceMeshTemplate {
  const woodGeos: THREE.BufferGeometry[] = [];
  const hardwareGeos: THREE.BufferGeometry[] = [];

  const width = 0.88;
  const height = 1.84;
  const thickness = 0.055;

  // Main door leaf slab core
  const core = new THREE.BoxGeometry(width, height, thickness * 0.7);
  woodGeos.push(core);

  // Outer stiles & rails framing
  const stileW = 0.10;
  const railH = 0.12;

  // Perimeter bevel frame
  const leftStile = new THREE.BoxGeometry(stileW, height, thickness);
  leftStile.translate(-width / 2 + stileW / 2, 0, 0);
  woodGeos.push(leftStile);

  const rightStile = new THREE.BoxGeometry(stileW, height, thickness);
  rightStile.translate(width / 2 - stileW / 2, 0, 0);
  woodGeos.push(rightStile);

  const topRail = new THREE.BoxGeometry(width - stileW * 2, railH, thickness);
  topRail.translate(0, height / 2 - railH / 2, 0);
  woodGeos.push(topRail);

  const botRail = new THREE.BoxGeometry(width - stileW * 2, railH * 1.3, thickness);
  botRail.translate(0, -height / 2 + (railH * 1.3) / 2, 0);
  woodGeos.push(botRail);

  // Center vertical mullion stile
  const midMullionW = 0.06;
  const midMullion = new THREE.BoxGeometry(midMullionW, height - railH * 2.3, thickness);
  midMullion.translate(0, -railH * 0.15, 0);
  woodGeos.push(midMullion);

  // 8 Recessed Panels (2 columns x 4 rows):
  // Left column center: -0.19, Right column center: +0.19
  const panelW = (width - stileW * 2 - midMullionW) / 2 - 0.01; // ~0.30m
  const colX = [-0.185, 0.185];

  const rowSpecs = [
    { y: 0.60, h: 0.22 },  // Row 1: small top panel
    { y: 0.20, h: 0.48 },  // Row 2: tall vertical panel
    { y: -0.20, h: 0.22 }, // Row 3: small middle panel
    { y: -0.56, h: 0.38 }, // Row 4: medium bottom panel
  ];

  for (const rx of colX) {
    for (const spec of rowSpecs) {
      // Recessed field
      const field = new THREE.BoxGeometry(panelW, spec.h, thickness * 0.82);
      field.translate(rx, spec.y, 0);
      woodGeos.push(field);

      // Molded raised bevel border
      const border = new THREE.BoxGeometry(panelW - 0.03, spec.h - 0.03, thickness * 0.95);
      border.translate(rx, spec.y, 0);
      woodGeos.push(border);
    }
  }

  // Cross horizontal rails separating rows
  const crossH = 0.05;
  for (let r = 0; r < rowSpecs.length - 1; r++) {
    const cy = (rowSpecs[r].y - rowSpecs[r].h / 2 + rowSpecs[r + 1].y + rowSpecs[r + 1].h / 2) / 2;
    const crossRail = new THREE.BoxGeometry(width - stileW * 2, crossH, thickness);
    crossRail.translate(0, cy, 0);
    woodGeos.push(crossRail);
  }

  // Dark Bronze Hardware:
  // Long vertical backplate escutcheon on right stile (front & back)
  const plateW = 0.032;
  const plateH = 0.36;
  const plateD = 0.075;
  const plate = new THREE.BoxGeometry(plateW, plateH, plateD);
  plate.translate(width / 2 - stileW / 2, -0.05, 0);
  hardwareGeos.push(plate);

  // Curved pull handle front
  const pullFront = new THREE.BoxGeometry(0.018, 0.24, 0.04);
  pullFront.translate(width / 2 - stileW / 2, -0.05, 0.055);
  hardwareGeos.push(pullFront);

  // Curved pull handle back
  const pullBack = new THREE.BoxGeometry(0.018, 0.24, 0.04);
  pullBack.translate(width / 2 - stileW / 2, -0.05, -0.055);
  hardwareGeos.push(pullBack);

  // Hinges on left edge (3 heavy-duty bronze cylinders)
  for (const hy of [-0.60, 0.0, 0.60]) {
    const hinge = new THREE.CylinderGeometry(0.012, 0.012, 0.09, 10);
    hinge.translate(-width / 2 + 0.005, hy, 0);
    hardwareGeos.push(hinge);
  }

  const mergedWood = mergeGeometries(woodGeos)!;
  woodGeos.forEach((g) => g.dispose());

  const mergedHardware = mergeGeometries(hardwareGeos)!;
  hardwareGeos.forEach((g) => g.dispose());

  const finalGeo = mergeGeometries([mergedWood, mergedHardware], true)!;
  mergedWood.dispose();
  mergedHardware.dispose();

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.woodMahogany, BUILDING_MATERIALS.bronzeHardware],
    boundingBox: new THREE.Box3(),
  };
}

/**
 * 2. White 2-Panel Shaker Door Frame (1x2m) with prominent architectural Architrave Casing
 */
export function buildWhite2PanelDoorFrameGeometry(): PieceMeshTemplate {
  const width = 1.0;
  const height = MODULE_SIZE; // 2.0m
  const frameD = WALL_THICKNESS;
  const casingD = WALL_THICKNESS + 0.046; // Extends 23mm on front & back beyond wall plane for clear architectural relief

  const headerH = 0.12;
  const jambW = 0.08;
  const openingW = width - jambW * 2; // 0.84m
  const openingH = height - headerH;  // 1.88m

  const geos: THREE.BufferGeometry[] = [];

  // 1. Inner Frame Core (Jambs & Header flush with wall depth)
  const header = new THREE.BoxGeometry(width, headerH, frameD);
  header.translate(0, height / 2 - headerH / 2, 0);
  geos.push(header);

  const leftJamb = new THREE.BoxGeometry(jambW, openingH, frameD);
  leftJamb.translate(-width / 2 + jambW / 2, -height / 2 + openingH / 2, 0);
  geos.push(leftJamb);

  const rightJamb = new THREE.BoxGeometry(jambW, openingH, frameD);
  rightJamb.translate(width / 2 - jambW / 2, -height / 2 + openingH / 2, 0);
  geos.push(rightJamb);

  // Inner door stop bead (притворна планка)
  const stopD = 0.03;
  const stopW = 0.02;
  const topStop = new THREE.BoxGeometry(openingW, stopW, stopD);
  topStop.translate(0, -height / 2 + openingH - stopW / 2, 0);
  geos.push(topStop);

  const leftStop = new THREE.BoxGeometry(stopW, openingH, stopD);
  leftStop.translate(-openingW / 2 + stopW / 2, -height / 2 + openingH / 2, 0);
  geos.push(leftStop);

  const rightStop = new THREE.BoxGeometry(stopW, openingH, stopD);
  rightStop.translate(openingW / 2 - stopW / 2, -height / 2 + openingH / 2, 0);
  geos.push(rightStop);

  // 2. ARCHITRAVE CASINGS (Top, Left, Right surrounding doorway on both faces)
  const casingW = 0.08;
  const plinthH = 0.22;
  const plinthW = 0.088;
  const plinthD = casingD + 0.016;

  // --- A. Left Architrave Casing Leg (Зліва) ---
  // Main vertical casing leg (from plinth top to header bottom)
  const legH = openingH - plinthH;
  const legCenterY = -height / 2 + plinthH + legH / 2;
  const leftCasingX = -openingW / 2 - casingW / 2;

  const leftCasing = new THREE.BoxGeometry(casingW, legH, casingD);
  leftCasing.translate(leftCasingX, legCenterY, 0);
  geos.push(leftCasing);

  // Stepped outer relief band on left leg
  const leftRelief = new THREE.BoxGeometry(0.024, legH, casingD + 0.008);
  leftRelief.translate(leftCasingX - (casingW / 2 - 0.012), legCenterY, 0);
  geos.push(leftRelief);

  // Left Plinth Block at floor level (Опорний плінт)
  const leftPlinth = new THREE.BoxGeometry(plinthW, plinthH, plinthD);
  leftPlinth.translate(-openingW / 2 - plinthW / 2 + 0.004, -height / 2 + plinthH / 2, 0);
  geos.push(leftPlinth);

  // --- B. Right Architrave Casing Leg (Справа) ---
  const rightCasingX = openingW / 2 + casingW / 2;

  const rightCasing = new THREE.BoxGeometry(casingW, legH, casingD);
  rightCasing.translate(rightCasingX, legCenterY, 0);
  geos.push(rightCasing);

  // Stepped outer relief band on right leg
  const rightRelief = new THREE.BoxGeometry(0.024, legH, casingD + 0.008);
  rightRelief.translate(rightCasingX + (casingW / 2 - 0.012), legCenterY, 0);
  geos.push(rightRelief);

  // Right Plinth Block at floor level (Опорний плінт)
  const rightPlinth = new THREE.BoxGeometry(plinthW, plinthH, plinthD);
  rightPlinth.translate(openingW / 2 + plinthW / 2 - 0.004, -height / 2 + plinthH / 2, 0);
  geos.push(rightPlinth);

  // --- C. Top Architrave Header / Entablature (Зверху) ---
  const headerFriezeH = 0.085;
  const headerFriezeY = -height / 2 + openingH + headerFriezeH / 2;
  const headerFriezeW = openingW + casingW * 2 + 0.02; // 1.02m

  // Lower fillet bead strip below header
  const headerBead = new THREE.BoxGeometry(headerFriezeW + 0.01, 0.014, casingD + 0.012);
  headerBead.translate(0, -height / 2 + openingH + 0.007, 0);
  geos.push(headerBead);

  // Main header frieze board
  const topHeaderCasing = new THREE.BoxGeometry(headerFriezeW, headerFriezeH, casingD);
  topHeaderCasing.translate(0, headerFriezeY, 0);
  geos.push(topHeaderCasing);

  // Stepped crown cap cornice molding (Верхній карнизний козирок)
  const crownH = 0.026;
  const crownW = headerFriezeW + 0.05;
  const crownD = casingD + 0.026;
  const crownY = -height / 2 + openingH + headerFriezeH + crownH / 2;
  const topCrown = new THREE.BoxGeometry(crownW, crownH, crownD);
  topCrown.translate(0, crownY, 0);
  geos.push(topCrown);

  // Overhanging top crown fillet
  const topFillet = new THREE.BoxGeometry(crownW + 0.02, 0.012, crownD + 0.012);
  topFillet.translate(0, crownY + crownH / 2 + 0.006, 0);
  geos.push(topFillet);

  // --- D. Ground Threshold Sill (Поріг) ---
  const threshH = 0.02;
  const threshW = openingW + 0.02;
  const threshD = frameD + 0.02;
  const thresh = new THREE.BoxGeometry(threshW, threshH, threshD);
  thresh.translate(0, -height / 2 + threshH / 2, 0);
  geos.push(thresh);

  const finalGeo = mergeGeometries(geos)!;
  geos.forEach((g) => g.dispose());
  if (finalGeo.groups.length === 0 && finalGeo.index) {
    finalGeo.addGroup(0, finalGeo.index.count, 0);
  }

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.woodWhiteDoor],
    boundingBox: new THREE.Box3(),
  };
}

/**
 * 2b. White 2-Panel Shaker Door Leaf (with polished brass round knob)
 */
export function buildWhite2PanelDoorLeaf(): PieceMeshTemplate {
  const whiteGeos: THREE.BufferGeometry[] = [];
  const brassGeos: THREE.BufferGeometry[] = [];

  const width = 0.84;
  const height = 1.88;
  const thickness = 0.048;

  const stileW = 0.10;
  const panelW = width - stileW * 2; // 0.64m

  // 1. Stiles (Left & Right)
  const leftStile = new THREE.BoxGeometry(stileW, height, thickness);
  leftStile.translate(-width / 2 + stileW / 2, 0, 0);
  whiteGeos.push(leftStile);

  const rightStile = new THREE.BoxGeometry(stileW, height, thickness);
  rightStile.translate(width / 2 - stileW / 2, 0, 0);
  whiteGeos.push(rightStile);

  // 2. Rails
  const topRailH = 0.12;
  const topRail = new THREE.BoxGeometry(panelW, topRailH, thickness);
  topRail.translate(0, height / 2 - topRailH / 2, 0);
  whiteGeos.push(topRail);

  const botRailH = 0.18;
  const botRail = new THREE.BoxGeometry(panelW, botRailH, thickness);
  botRail.translate(0, -height / 2 + botRailH / 2, 0);
  whiteGeos.push(botRail);

  const midRailH = 0.14;
  const midRailY = -0.08;
  const midRail = new THREE.BoxGeometry(panelW, midRailH, thickness);
  midRail.translate(0, midRailY, 0);
  whiteGeos.push(midRail);

  // 3. Panels (Upper tall shaker panel & Lower shaker panel)
  // Upper panel
  const topPanelH = height / 2 - topRailH - (midRailY + midRailH / 2); // 0.83m
  const topPanelY = (height / 2 - topRailH + midRailY + midRailH / 2) / 2; // 0.405m
  const topPanel = new THREE.BoxGeometry(panelW, topPanelH, thickness * 0.50);
  topPanel.translate(0, topPanelY, 0);
  whiteGeos.push(topPanel);

  const topPanelBevel = new THREE.BoxGeometry(panelW - 0.05, topPanelH - 0.05, thickness * 0.85);
  topPanelBevel.translate(0, topPanelY, 0);
  whiteGeos.push(topPanelBevel);

  // Lower panel
  const botPanelH = midRailY - midRailH / 2 - (-height / 2 + botRailH); // 0.61m
  const botPanelY = (midRailY - midRailH / 2 + (-height / 2 + botRailH)) / 2; // -0.455m
  const botPanel = new THREE.BoxGeometry(panelW, botPanelH, thickness * 0.50);
  botPanel.translate(0, botPanelY, 0);
  whiteGeos.push(botPanel);

  const botPanelBevel = new THREE.BoxGeometry(panelW - 0.05, botPanelH - 0.05, thickness * 0.85);
  botPanelBevel.translate(0, botPanelY, 0);
  whiteGeos.push(botPanelBevel);

  // 4. Polished Brass Hardware: round knob & rosette on front & back
  const knobX = width / 2 - 0.085;
  const knobY = midRailY;

  // Rosette disks
  const rosetteFront = new THREE.CylinderGeometry(0.026, 0.026, 0.006, 12);
  rosetteFront.rotateX(Math.PI / 2);
  rosetteFront.translate(knobX, knobY, thickness / 2 + 0.003);
  brassGeos.push(rosetteFront);

  const rosetteBack = new THREE.CylinderGeometry(0.026, 0.026, 0.006, 12);
  rosetteBack.rotateX(Math.PI / 2);
  rosetteBack.translate(knobX, knobY, -thickness / 2 - 0.003);
  brassGeos.push(rosetteBack);

  // Round spherical knobs
  const knobFront = new THREE.SphereGeometry(0.024, 10, 8);
  knobFront.translate(knobX, knobY, thickness / 2 + 0.028);
  brassGeos.push(knobFront);

  const knobBack = new THREE.SphereGeometry(0.024, 10, 8);
  knobBack.translate(knobX, knobY, -thickness / 2 - 0.028);
  brassGeos.push(knobBack);

  // Brass hinges on left edge
  for (const hy of [-0.55, 0.55]) {
    const hinge = new THREE.CylinderGeometry(0.009, 0.009, 0.08, 8);
    hinge.translate(-width / 2 + 0.004, hy, 0);
    brassGeos.push(hinge);
  }

  const mergedWhite = mergeGeometries(whiteGeos)!;
  whiteGeos.forEach((g) => g.dispose());

  const mergedBrass = mergeGeometries(brassGeos)!;
  brassGeos.forEach((g) => g.dispose());

  const finalGeo = mergeGeometries([mergedWhite, mergedBrass], true)!;
  mergedWhite.dispose();
  mergedBrass.dispose();

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.woodWhiteDoor, BUILDING_MATERIALS.brassHardware],
    boundingBox: new THREE.Box3(),
  };
}

/**
 * 3. Cottage / Farmhouse Door Frame (1x2m) in dark charcoal finish with robust timber Architrave Casing
 */
export function buildCottageWindowDoorFrameGeometry(): PieceMeshTemplate {
  const width = 1.0;
  const height = MODULE_SIZE;
  const frameD = WALL_THICKNESS;
  const casingD = WALL_THICKNESS + 0.048; // Robust craftsman timber projection

  const headerH = 0.12;
  const jambW = 0.08;
  const openingW = width - jambW * 2;
  const openingH = height - headerH;

  const geos: THREE.BufferGeometry[] = [];

  // 1. Inner Core Frame (Jambs & Header)
  const header = new THREE.BoxGeometry(width, headerH, frameD);
  header.translate(0, height / 2 - headerH / 2, 0);
  geos.push(header);

  const leftJamb = new THREE.BoxGeometry(jambW, openingH, frameD);
  leftJamb.translate(-width / 2 + jambW / 2, -height / 2 + openingH / 2, 0);
  geos.push(leftJamb);

  const rightJamb = new THREE.BoxGeometry(jambW, openingH, frameD);
  rightJamb.translate(width / 2 - jambW / 2, -height / 2 + openingH / 2, 0);
  geos.push(rightJamb);

  // Door stop bead
  const stopD = 0.032;
  const stopW = 0.022;
  const topStop = new THREE.BoxGeometry(openingW, stopW, stopD);
  topStop.translate(0, -height / 2 + openingH - stopW / 2, 0);
  geos.push(topStop);

  const leftStop = new THREE.BoxGeometry(stopW, openingH, stopD);
  leftStop.translate(-openingW / 2 + stopW / 2, -height / 2 + openingH / 2, 0);
  geos.push(leftStop);

  const rightStop = new THREE.BoxGeometry(stopW, openingH, stopD);
  rightStop.translate(openingW / 2 - stopW / 2, -height / 2 + openingH / 2, 0);
  geos.push(rightStop);

  // 2. ARCHITRAVE CASINGS (Top, Left, Right surrounding doorway)
  const casingW = 0.085;
  const plinthH = 0.24;
  const plinthW = 0.092;
  const plinthD = casingD + 0.018;

  // --- A. Left Architrave Casing Leg (Зліва) ---
  const legH = openingH - plinthH;
  const legCenterY = -height / 2 + plinthH + legH / 2;
  const leftCasingX = -openingW / 2 - casingW / 2;

  const leftCasing = new THREE.BoxGeometry(casingW, legH, casingD);
  leftCasing.translate(leftCasingX, legCenterY, 0);
  geos.push(leftCasing);

  // Chamfered craftsman inner band on left leg
  const leftBand = new THREE.BoxGeometry(0.028, legH, casingD + 0.008);
  leftBand.translate(leftCasingX + (casingW / 2 - 0.014), legCenterY, 0);
  geos.push(leftBand);

  // Left Plinth Block (Опорний плінт)
  const leftPlinth = new THREE.BoxGeometry(plinthW, plinthH, plinthD);
  leftPlinth.translate(-openingW / 2 - plinthW / 2 + 0.003, -height / 2 + plinthH / 2, 0);
  geos.push(leftPlinth);

  // --- B. Right Architrave Casing Leg (Справа) ---
  const rightCasingX = openingW / 2 + casingW / 2;

  const rightCasing = new THREE.BoxGeometry(casingW, legH, casingD);
  rightCasing.translate(rightCasingX, legCenterY, 0);
  geos.push(rightCasing);

  // Chamfered craftsman inner band on right leg
  const rightBand = new THREE.BoxGeometry(0.028, legH, casingD + 0.008);
  rightBand.translate(rightCasingX - (casingW / 2 - 0.014), legCenterY, 0);
  geos.push(rightBand);

  // Right Plinth Block (Опорний плінт)
  const rightPlinth = new THREE.BoxGeometry(plinthW, plinthH, plinthD);
  rightPlinth.translate(openingW / 2 + plinthW / 2 - 0.003, -height / 2 + plinthH / 2, 0);
  geos.push(rightPlinth);

  // --- C. Top Architrave Header Beam (Зверху) ---
  const headerLintelH = 0.095;
  const headerLintelY = -height / 2 + openingH + headerLintelH / 2;
  const headerLintelW = openingW + casingW * 2 + 0.03; // 1.04m

  // Lower support astragal bead
  const headerAstragal = new THREE.BoxGeometry(headerLintelW + 0.015, 0.016, casingD + 0.014);
  headerAstragal.translate(0, -height / 2 + openingH + 0.008, 0);
  geos.push(headerAstragal);

  // Main thick timber lintel header
  const topHeaderCasing = new THREE.BoxGeometry(headerLintelW, headerLintelH, casingD);
  topHeaderCasing.translate(0, headerLintelY, 0);
  geos.push(topHeaderCasing);

  // Overhanging timber cap ledge (Масивний карнизний козирок)
  const crownH = 0.028;
  const crownW = headerLintelW + 0.06;
  const crownD = casingD + 0.028;
  const crownY = -height / 2 + openingH + headerLintelH + crownH / 2;
  const topCrown = new THREE.BoxGeometry(crownW, crownH, crownD);
  topCrown.translate(0, crownY, 0);
  geos.push(topCrown);

  // Top drip edge
  const topEdge = new THREE.BoxGeometry(crownW + 0.02, 0.012, crownD + 0.012);
  topEdge.translate(0, crownY + crownH / 2 + 0.006, 0);
  geos.push(topEdge);

  // --- D. Threshold Sill (Поріг) ---
  const threshH = 0.024;
  const threshW = openingW + 0.02;
  const threshD = frameD + 0.025;
  const thresh = new THREE.BoxGeometry(threshW, threshH, threshD);
  thresh.translate(0, -height / 2 + threshH / 2, 0);
  geos.push(thresh);

  const finalGeo = mergeGeometries(geos)!;
  geos.forEach((g) => g.dispose());
  if (finalGeo.groups.length === 0 && finalGeo.index) {
    finalGeo.addGroup(0, finalGeo.index.count, 0);
  }

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.woodCharcoal],
    boundingBox: new THREE.Box3(),
  };
}

/**
 * 3b. Cottage Door Leaf (Upper 4-pane window, lower panel, brass lever handle)
 */
export function buildCottageWindowDoorLeaf(): PieceMeshTemplate {
  const woodGeos: THREE.BufferGeometry[] = [];
  const glassGeos: THREE.BufferGeometry[] = [];
  const brassGeos: THREE.BufferGeometry[] = [];

  const width = 0.84;
  const height = 1.88;
  const thickness = 0.052;

  const stileW = 0.10;
  const panelW = width - stileW * 2; // 0.64m

  // Left & Right Stiles
  const leftStile = new THREE.BoxGeometry(stileW, height, thickness);
  leftStile.translate(-width / 2 + stileW / 2, 0, 0);
  woodGeos.push(leftStile);

  const rightStile = new THREE.BoxGeometry(stileW, height, thickness);
  rightStile.translate(width / 2 - stileW / 2, 0, 0);
  woodGeos.push(rightStile);

  // Top, Mid, Bottom Rails
  const topRailH = 0.12;
  const topRail = new THREE.BoxGeometry(panelW, topRailH, thickness);
  topRail.translate(0, height / 2 - topRailH / 2, 0);
  woodGeos.push(topRail);

  const botRailH = 0.18;
  const botRail = new THREE.BoxGeometry(panelW, botRailH, thickness);
  botRail.translate(0, -height / 2 + botRailH / 2, 0);
  woodGeos.push(botRail);

  const midRailH = 0.14;
  const midRailY = -0.08;
  const midRail = new THREE.BoxGeometry(panelW, midRailH, thickness);
  midRail.translate(0, midRailY, 0);
  woodGeos.push(midRail);

  // Upper Window Section (4-pane window)
  const winH = height / 2 - topRailH - (midRailY + midRailH / 2); // 0.83m
  const winY = (height / 2 - topRailH + midRailY + midRailH / 2) / 2; // 0.405m

  // Translucent window glass
  const glass = new THREE.BoxGeometry(panelW - 0.02, winH - 0.02, 0.012);
  glass.translate(0, winY, 0);
  glassGeos.push(glass);

  // Muntin bars dividing window into 4 equal panes (cross grid)
  const muntinW = 0.024;
  const vertMuntin = new THREE.BoxGeometry(muntinW, winH - 0.02, 0.032);
  vertMuntin.translate(0, winY, 0);
  woodGeos.push(vertMuntin);

  const horizMuntin = new THREE.BoxGeometry(panelW - 0.02, muntinW, 0.032);
  horizMuntin.translate(0, winY, 0);
  woodGeos.push(horizMuntin);

  // Lower Section: Recessed Panel with cottage style field
  const botPanelH = midRailY - midRailH / 2 - (-height / 2 + botRailH); // 0.61m
  const botPanelY = (midRailY - midRailH / 2 + (-height / 2 + botRailH)) / 2; // -0.455m

  const botPanel = new THREE.BoxGeometry(panelW, botPanelH, thickness * 0.50);
  botPanel.translate(0, botPanelY, 0);
  woodGeos.push(botPanel);

  const botPanelMolding = new THREE.BoxGeometry(panelW - 0.05, botPanelH - 0.05, thickness * 0.80);
  botPanelMolding.translate(0, botPanelY, 0);
  woodGeos.push(botPanelMolding);

  // Brass Lever Handle Hardware
  const handleX = width / 2 - 0.085;
  const handleY = midRailY;

  // Rectangular backplate
  const backplate = new THREE.BoxGeometry(0.032, 0.16, 0.068);
  backplate.translate(handleX, handleY, 0);
  brassGeos.push(backplate);

  // Horizontal brass lever handle (front & back)
  const leverFront = new THREE.BoxGeometry(0.10, 0.018, 0.018);
  leverFront.translate(handleX - 0.035, handleY + 0.025, thickness / 2 + 0.025);
  brassGeos.push(leverFront);

  const leverBack = new THREE.BoxGeometry(0.10, 0.018, 0.018);
  leverBack.translate(handleX - 0.035, handleY + 0.025, -thickness / 2 - 0.025);
  brassGeos.push(leverBack);

  // Brass hinges on left edge
  for (const hy of [-0.55, 0.55]) {
    const hinge = new THREE.CylinderGeometry(0.009, 0.009, 0.08, 8);
    hinge.translate(-width / 2 + 0.004, hy, 0);
    brassGeos.push(hinge);
  }

  const mergedWood = mergeGeometries(woodGeos)!;
  woodGeos.forEach((g) => g.dispose());

  const mergedGlass = mergeGeometries(glassGeos)!;
  glassGeos.forEach((g) => g.dispose());

  const mergedBrass = mergeGeometries(brassGeos)!;
  brassGeos.forEach((g) => g.dispose());

  const finalGeo = mergeGeometries([mergedWood, mergedGlass, mergedBrass], true)!;
  mergedWood.dispose();
  mergedGlass.dispose();
  mergedBrass.dispose();

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.woodCharcoal, BUILDING_MATERIALS.windowGlass, BUILDING_MATERIALS.brassHardware],
    boundingBox: new THREE.Box3(),
  };
}

/**
 * 4. Colonial 6-Panel Door Frame (1x2m) in warm cream / ivory wood with Classical Georgian Architrave Casing
 */
export function buildColonial6PanelDoorFrameGeometry(): PieceMeshTemplate {
  const width = 1.0;
  const height = MODULE_SIZE;
  const frameD = WALL_THICKNESS;
  const casingD = WALL_THICKNESS + 0.050; // Deep classical relief

  const headerH = 0.12;
  const jambW = 0.08;
  const openingW = width - jambW * 2;
  const openingH = height - headerH;

  const geos: THREE.BufferGeometry[] = [];

  // 1. Inner Core Frame (Jambs & Header)
  const header = new THREE.BoxGeometry(width, headerH, frameD);
  header.translate(0, height / 2 - headerH / 2, 0);
  geos.push(header);

  const leftJamb = new THREE.BoxGeometry(jambW, openingH, frameD);
  leftJamb.translate(-width / 2 + jambW / 2, -height / 2 + openingH / 2, 0);
  geos.push(leftJamb);

  const rightJamb = new THREE.BoxGeometry(jambW, openingH, frameD);
  rightJamb.translate(width / 2 - jambW / 2, -height / 2 + openingH / 2, 0);
  geos.push(rightJamb);

  // Door stop bead
  const stopD = 0.03;
  const stopW = 0.02;
  const topStop = new THREE.BoxGeometry(openingW, stopW, stopD);
  topStop.translate(0, -height / 2 + openingH - stopW / 2, 0);
  geos.push(topStop);

  const leftStop = new THREE.BoxGeometry(stopW, openingH, stopD);
  leftStop.translate(-openingW / 2 + stopW / 2, -height / 2 + openingH / 2, 0);
  geos.push(leftStop);

  const rightStop = new THREE.BoxGeometry(stopW, openingH, stopD);
  rightStop.translate(openingW / 2 - stopW / 2, -height / 2 + openingH / 2, 0);
  geos.push(rightStop);

  // 2. CLASSICAL ARCHITRAVE CASINGS (Top, Left, Right surrounding doorway)
  const casingW = 0.085;
  const plinthH = 0.25;
  const plinthW = 0.092;
  const plinthD = casingD + 0.020;

  // --- A. Left Architrave Casing Leg (Зліва - Fluted Pilaster Style) ---
  const legH = openingH - plinthH;
  const legCenterY = -height / 2 + plinthH + legH / 2;
  const leftCasingX = -openingW / 2 - casingW / 2;

  const leftCasing = new THREE.BoxGeometry(casingW, legH, casingD);
  leftCasing.translate(leftCasingX, legCenterY, 0);
  geos.push(leftCasing);

  // Double flute / stepped reed profiles on left leg
  for (const offset of [-0.022, 0.022]) {
    const reed = new THREE.BoxGeometry(0.016, legH - 0.02, casingD + 0.010);
    reed.translate(leftCasingX + offset, legCenterY, 0);
    geos.push(reed);
  }

  // Left Classical Plinth Block (Опорний плінт)
  const leftPlinth = new THREE.BoxGeometry(plinthW, plinthH, plinthD);
  leftPlinth.translate(-openingW / 2 - plinthW / 2 + 0.003, -height / 2 + plinthH / 2, 0);
  geos.push(leftPlinth);

  // --- B. Right Architrave Casing Leg (Справа - Fluted Pilaster Style) ---
  const rightCasingX = openingW / 2 + casingW / 2;

  const rightCasing = new THREE.BoxGeometry(casingW, legH, casingD);
  rightCasing.translate(rightCasingX, legCenterY, 0);
  geos.push(rightCasing);

  // Double flute / stepped reed profiles on right leg
  for (const offset of [-0.022, 0.022]) {
    const reed = new THREE.BoxGeometry(0.016, legH - 0.02, casingD + 0.010);
    reed.translate(rightCasingX + offset, legCenterY, 0);
    geos.push(reed);
  }

  // Right Classical Plinth Block (Опорний плінт)
  const rightPlinth = new THREE.BoxGeometry(plinthW, plinthH, plinthD);
  rightPlinth.translate(openingW / 2 + plinthW / 2 - 0.003, -height / 2 + plinthH / 2, 0);
  geos.push(rightPlinth);

  // --- C. Classical Corner Rosette Blocks (Кутові розетки / капітелі) ---
  const rosetteSize = 0.088;
  const rosetteD = casingD + 0.014;
  const rosetteY = -height / 2 + openingH + rosetteSize / 2;

  const leftRosette = new THREE.BoxGeometry(rosetteSize, rosetteSize, rosetteD);
  leftRosette.translate(leftCasingX, rosetteY, 0);
  geos.push(leftRosette);

  const rightRosette = new THREE.BoxGeometry(rosetteSize, rosetteSize, rosetteD);
  rightRosette.translate(rightCasingX, rosetteY, 0);
  geos.push(rightRosette);

  // --- D. Top Architrave Header / Classical Entablature (Зверху) ---
  const headerFriezeH = 0.088;
  const headerFriezeY = rosetteY;
  const headerFriezeW = openingW; // Spanning between corner rosette blocks

  const headerFrieze = new THREE.BoxGeometry(headerFriezeW, headerFriezeH, casingD);
  headerFrieze.translate(0, headerFriezeY, 0);
  geos.push(headerFrieze);

  // Stepped architrave lower bead
  const lowerBead = new THREE.BoxGeometry(width + 0.04, 0.016, casingD + 0.012);
  lowerBead.translate(0, -height / 2 + openingH + 0.008, 0);
  geos.push(lowerBead);

  // Classical Cyma Crown Cornice (Класичний карниз з виступом)
  const crownH = 0.032;
  const crownW = width + 0.08;
  const crownD = casingD + 0.032;
  const crownY = rosetteY + rosetteSize / 2 + crownH / 2;
  const topCrown = new THREE.BoxGeometry(crownW, crownH, crownD);
  topCrown.translate(0, crownY, 0);
  geos.push(topCrown);

  // Top entablature cap ledge
  const topCap = new THREE.BoxGeometry(crownW + 0.024, 0.014, crownD + 0.014);
  topCap.translate(0, crownY + crownH / 2 + 0.007, 0);
  geos.push(topCap);

  // --- E. Threshold Sill (Поріг) ---
  const threshH = 0.02;
  const threshW = openingW + 0.02;
  const threshD = frameD + 0.02;
  const thresh = new THREE.BoxGeometry(threshW, threshH, threshD);
  thresh.translate(0, -height / 2 + threshH / 2, 0);
  geos.push(thresh);

  const finalGeo = mergeGeometries(geos)!;
  geos.forEach((g) => g.dispose());
  if (finalGeo.groups.length === 0 && finalGeo.index) {
    finalGeo.addGroup(0, finalGeo.index.count, 0);
  }

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.woodCream],
    boundingBox: new THREE.Box3(),
  };
}

/**
 * 4b. Colonial 6-Panel Door Leaf (3 rows x 2 columns of raised panels, brass knob)
 * Mathematically aligned with stiles, vertical mullion, 4 horizontal rails, and 6 raised panels.
 */
export function buildColonial6PanelDoorLeaf(): PieceMeshTemplate {
  const creamGeos: THREE.BufferGeometry[] = [];
  const brassGeos: THREE.BufferGeometry[] = [];

  const width = 0.84;
  const height = 1.88;
  const thickness = 0.048;

  const stileW = 0.10;
  const midMullionW = 0.08;
  const panelW = (width - stileW * 2 - midMullionW) / 2; // 0.28m
  const colX = [-0.18, 0.18]; // Left column center -0.18, Right column center +0.18

  // Outer Stiles
  const leftStile = new THREE.BoxGeometry(stileW, height, thickness);
  leftStile.translate(-width / 2 + stileW / 2, 0, 0);
  creamGeos.push(leftStile);

  const rightStile = new THREE.BoxGeometry(stileW, height, thickness);
  rightStile.translate(width / 2 - stileW / 2, 0, 0);
  creamGeos.push(rightStile);

  // Rails spanning between outer stiles (width = 0.64m)
  const innerW = width - stileW * 2; // 0.64m

  const topRailH = 0.12;
  const topRail = new THREE.BoxGeometry(innerW, topRailH, thickness);
  topRail.translate(0, height / 2 - topRailH / 2, 0); // Y: 0.82 to 0.94, center 0.88
  creamGeos.push(topRail);

  const botRailH = 0.20;
  const botRail = new THREE.BoxGeometry(innerW, botRailH, thickness);
  botRail.translate(0, -height / 2 + botRailH / 2, 0); // Y: -0.94 to -0.74, center -0.84
  creamGeos.push(botRail);

  // Intermediate Cross Rail (between Tier 1 and Tier 2)
  const rail1H = 0.07;
  const rail1Y = 0.44; // Y: 0.405 to 0.475
  const rail1 = new THREE.BoxGeometry(innerW, rail1H, thickness);
  rail1.translate(0, rail1Y, 0);
  creamGeos.push(rail1);

  // Lock Rail (between Tier 2 and Tier 3)
  const lockRailH = 0.12;
  const lockRailY = -0.10; // Y: -0.16 to -0.04
  const lockRail = new THREE.BoxGeometry(innerW, lockRailH, thickness);
  lockRail.translate(0, lockRailY, 0);
  creamGeos.push(lockRail);

  // Center vertical mullion (between top rail and bottom rail)
  const mullionH = (height / 2 - topRailH) - (-height / 2 + botRailH); // 0.82 - (-0.74) = 1.56m
  const mullionY = ((height / 2 - topRailH) + (-height / 2 + botRailH)) / 2; // 0.04m
  const centerMullion = new THREE.BoxGeometry(midMullionW, mullionH, thickness);
  centerMullion.translate(0, mullionY, 0);
  creamGeos.push(centerMullion);

  // 6 Panels in 3 Tiers (mathematically fitted flush between rails and mullion)
  const panelSpecs = [
    { y: 0.6475, h: 0.345 }, // Tier 1 (top): Y from 0.475 to 0.82
    { y: 0.1825, h: 0.445 }, // Tier 2 (middle): Y from -0.04 to 0.405
    { y: -0.450, h: 0.580 }, // Tier 3 (bottom): Y from -0.74 to -0.16
  ];

  for (const cx of colX) {
    for (const spec of panelSpecs) {
      // Recessed field
      const groove = new THREE.BoxGeometry(panelW, spec.h, thickness * 0.55);
      groove.translate(cx, spec.y, 0);
      creamGeos.push(groove);

      // Raised center bevel field with classic colonial ovolo profile
      const raisedField = new THREE.BoxGeometry(panelW - 0.04, spec.h - 0.04, thickness * 0.92);
      raisedField.translate(cx, spec.y, 0);
      creamGeos.push(raisedField);
    }
  }

  // Polished Brass Round Knob & Rosettes
  const knobX = width / 2 - 0.085;
  const knobY = lockRailY; // Centered on the lock rail

  const rosetteFront = new THREE.CylinderGeometry(0.026, 0.026, 0.006, 12);
  rosetteFront.rotateX(Math.PI / 2);
  rosetteFront.translate(knobX, knobY, thickness / 2 + 0.003);
  brassGeos.push(rosetteFront);

  const rosetteBack = new THREE.CylinderGeometry(0.026, 0.026, 0.006, 12);
  rosetteBack.rotateX(Math.PI / 2);
  rosetteBack.translate(knobX, knobY, -thickness / 2 - 0.003);
  brassGeos.push(rosetteBack);

  const knobFront = new THREE.SphereGeometry(0.024, 10, 8);
  knobFront.translate(knobX, knobY, thickness / 2 + 0.028);
  brassGeos.push(knobFront);

  const knobBack = new THREE.SphereGeometry(0.024, 10, 8);
  knobBack.translate(knobX, knobY, -thickness / 2 - 0.028);
  brassGeos.push(knobBack);

  // Brass hinges on left edge
  for (const hy of [-0.55, 0.55]) {
    const hinge = new THREE.CylinderGeometry(0.009, 0.009, 0.08, 8);
    hinge.translate(-width / 2 + 0.004, hy, 0);
    brassGeos.push(hinge);
  }

  const mergedCream = mergeGeometries(creamGeos)!;
  creamGeos.forEach((g) => g.dispose());

  const mergedBrass = mergeGeometries(brassGeos)!;
  brassGeos.forEach((g) => g.dispose());

  const finalGeo = mergeGeometries([mergedCream, mergedBrass], true)!;
  mergedCream.dispose();
  mergedBrass.dispose();

  return {
    geometry: finalGeo,
    materials: [BUILDING_MATERIALS.woodCream, BUILDING_MATERIALS.brassHardware],
    boundingBox: new THREE.Box3(),
  };
}
