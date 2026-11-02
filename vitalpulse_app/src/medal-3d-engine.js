import * as THREE from 'three';
import { BADGE_3D_CONTOURS } from './badge-contours';

/**
 * VitalPulse Photorealistic 3D Die-Cast Badge Engine (Three.js WebGL)
 *
 * Supports dual independent WebGL stages:
 * 1. Hero 3D Stage (`mountHero3DMedalViewer`) — Continuous 360° self-rotating showcase of the donor's highest unlocked tier medal.
 * 2. Modal 3D Inspector (`mount3DMedalViewer`) — Interactive 360° drag-to-orbit inspection inside the National Honor Citation Modal.
 */

const _instances = {
  modal: null,
  hero: null,
};

export function resolveBadgeContour(medalData) {
  const medalId = (medalData?.id || '').toLowerCase();
  const tier = (medalData?.tier || '').toLowerCase();

  if (medalId.includes('rapid')) {
    return BADGE_3D_CONTOURS.rapid || BADGE_3D_CONTOURS.bronze;
  }
  if (medalId.includes('standby') || medalId.includes('envoy')) {
    return BADGE_3D_CONTOURS.standby || BADGE_3D_CONTOURS.silver;
  }
  if (medalId.includes('rhythm') || medalId.includes('consistency')) {
    return BADGE_3D_CONTOURS.rhythm || BADGE_3D_CONTOURS.gold;
  }
  if (medalId.includes('silver') || tier.includes('silver')) {
    return BADGE_3D_CONTOURS.silver;
  }
  if (medalId.includes('bronze') || tier.includes('bronze')) {
    return BADGE_3D_CONTOURS.bronze;
  }
  if (medalId.includes('gold') || tier.includes('gold')) {
    return BADGE_3D_CONTOURS.gold;
  }
  if (medalId.includes('platinum') || tier.includes('platinum')) {
    return BADGE_3D_CONTOURS.platinum || BADGE_3D_CONTOURS.diamond;
  }
  if (medalId.includes('diamond') || tier.includes('diamond')) {
    return BADGE_3D_CONTOURS.diamond;
  }

  return BADGE_3D_CONTOURS.bronze;
}

function createMedalViewerInstance(slotKey, container, medalData, options = {}) {
  if (!container) return;

  destroyViewerInstance(slotKey);

  const autoRotate360 = Boolean(options.autoRotate360);
  const onClickCallback = typeof options.onClick === 'function' ? options.onClick : null;

  const width = container.clientWidth || (slotKey === 'hero' ? 224 : 240);
  const height = container.clientHeight || (slotKey === 'hero' ? 224 : 240);

  // 1. Scene & Camera — Calibrated for large, prominent, die-cast badge inspection
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, width / height, 0.1, 100);
  // Distance: modal=6.4 frames the 3.7-unit medal at ~215px (large prominent die-cast display); hero=8.8 frames it at ~148px (matching pedestal)
  camera.position.set(0, 0, slotKey === 'hero' ? 8.8 : 6.4);

  // 2. WebGL Renderer with High-DPI and ACES Filmic Tone Mapping
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
  } catch (err) {
    console.warn('[VitalPulse 3D] WebGL fallback triggered:', err);
    return;
  }

  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // Preserve any hidden test fallback elements (like #donor3DMedalImg) while mounting canvas
  const fallbackImg = container.querySelector('#donor3DMedalImg');
  if (fallbackImg) fallbackImg.style.display = 'none';
  Array.from(container.querySelectorAll('canvas')).forEach((c) => c.remove());
  container.appendChild(renderer.domElement);
  renderer.domElement.style.outline = 'none';
  renderer.domElement.style.cursor = 'grab';
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';

  // Ensure correct sizing immediately after DOM mount
  requestAnimationFrame(() => {
    if (container && renderer && camera) {
      const rw = container.clientWidth;
      const rh = container.clientHeight;
      if (rw > 0 && rh > 0 && (rw !== width || rh !== height)) {
        camera.aspect = rw / rh;
        camera.updateProjectionMatrix();
        renderer.setSize(rw, rh);
      }
    }
  });

  // 3. Studio 4-Point Lighting Rig
  const ambLight = new THREE.AmbientLight(0xffffff, 2.25);
  scene.add(ambLight);

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.35);
  keyLight.position.set(2.8, 3.6, 4.2);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xe2e8f0, 0.85);
  fillLight.position.set(-2.8, -1.8, 3.5);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0xfef3c7, 1.75);
  rimLight.position.set(0, 3.2, -4.2);
  scene.add(rimLight);

  // 4. Build 3D Shape from Exact Badge Contour
  const contour = resolveBadgeContour(medalData);
  const shape = new THREE.Shape();
  contour.points.forEach((pt, idx) => {
    if (idx === 0) shape.moveTo(pt[0], pt[1]);
    else shape.lineTo(pt[0], pt[1]);
  });
  shape.closePath();

  // 5. Extrude Geometry with Physical Thickness & Chiseled Metallic Chamfers
  const depth = 0.24;
  const extrudeSettings = {
    steps: 1,
    depth,
    bevelEnabled: true,
    bevelThickness: 0.055,
    bevelSize: 0.042,
    bevelSegments: 3,
  };

  const badgeGeom = new THREE.ExtrudeGeometry(shape, extrudeSettings);

  // 6. Exact 1:1 Pixel-to-Vertex UV Mapping for Front & Reverse Faces
  const pos = badgeGeom.attributes.position;
  const uvs = badgeGeom.attributes.uv;
  const halfVertices = pos.count / 2;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // Mirror X on reverse cap (z <= 0.01) so back side reads cleanly when rotating 360°
    const sampleX = z <= 0.01 ? -x : x;
    const px = sampleX / contour.scale + contour.cx;
    const py = -y / contour.scale + contour.cy;

    const u = Math.max(0, Math.min(1, px / 1024.0));
    const v = Math.max(0, Math.min(1, 1.0 - py / 1024.0));
    uvs.setXY(i, u, v);
  }
  uvs.needsUpdate = true;

  badgeGeom.translate(0, 0, -(depth / 2));
  badgeGeom.computeVertexNormals();

  // 7. Split Material Groups: Front Face [0], Polished Metallic Rim [1], Sculpted Reverse Face [2]
  if (badgeGeom.groups && badgeGeom.groups.length >= 2) {
    const halfCount = Math.floor(badgeGeom.groups[0].count / 2);
    badgeGeom.groups = [
      { start: halfCount, count: halfCount, materialIndex: 0 }, // Front face
      { start: badgeGeom.groups[1].start, count: badgeGeom.groups[1].count, materialIndex: 1 }, // Polished metallic rim
      { start: 0, count: halfCount, materialIndex: 2 }, // Reverse engraved face
    ];
  }

  // 8. Load High-Res Artwork & Normal Map
  const textureLoader = new THREE.TextureLoader();
  const imgUrl = medalData?.image || contour.image;
  const frontTex = textureLoader.load(imgUrl, (tex) => {
    tex.needsUpdate = true;
    if (faceMat) faceMat.needsUpdate = true;
    if (backMat) backMat.needsUpdate = true;
  });
  frontTex.colorSpace = THREE.SRGBColorSpace;
  frontTex.generateMipmaps = true;
  frontTex.minFilter = THREE.LinearMipmapLinearFilter;

  const normalTex = textureLoader.load(contour.normalMap, (tex) => {
    tex.needsUpdate = true;
    if (faceMat) faceMat.needsUpdate = true;
    if (backMat) backMat.needsUpdate = true;
  });
  normalTex.generateMipmaps = true;
  normalTex.minFilter = THREE.LinearMipmapLinearFilter;

  // 9. Calibrated Double-Sided Die-Cast Materials
  const faceMat = new THREE.MeshStandardMaterial({
    map: frontTex,
    normalMap: normalTex,
    normalScale: new THREE.Vector2(0.88, 0.88),
    metalness: 0.2,
    roughness: 0.52,
    transparent: true,
    alphaTest: 0.02,
    side: THREE.DoubleSide,
  });

  const sideMat = new THREE.MeshStandardMaterial({
    color: contour.metalColor,
    metalness: contour.metalness,
    roughness: contour.roughness,
  });

  // Reverse face also displays the engraved relief so 360° hero rotation looks authentic from every angle
  const backMat = new THREE.MeshStandardMaterial({
    map: frontTex,
    normalMap: normalTex,
    normalScale: new THREE.Vector2(0.75, 0.75),
    metalness: 0.28,
    roughness: 0.58,
    transparent: true,
    alphaTest: 0.02,
    side: THREE.DoubleSide,
  });

  const badgeMesh = new THREE.Mesh(badgeGeom, [faceMat, sideMat, backMat]);
  scene.add(badgeMesh);

  // 10. Interactive Orbit & Self-Rotation State
  const state = {
    renderer,
    scene,
    camera,
    mesh: badgeMesh,
    animFrameId: null,
    isDragging: false,
    dragDistance: 0,
    prevMousePos: { x: 0, y: 0 },
    targetRotX: 0,
    targetRotY: 0,
    currentRotX: 0,
    currentRotY: 0,
    rotVelX: 0,
    rotVelY: autoRotate360 ? 0.0085 : 0.005,
    idleClock: 0,
    cleanupEvents: null,
    heroKey: medalData?.id || medalData?.tier || '',
  };

  const domEl = renderer.domElement;

  const onPointerDown = (e) => {
    state.isDragging = true;
    state.dragDistance = 0;
    domEl.style.cursor = 'grabbing';
    state.prevMousePos = {
      x: e.touches ? e.touches[0].clientX : e.clientX,
      y: e.touches ? e.touches[0].clientY : e.clientY,
    };
    state.rotVelX = 0;
    state.rotVelY = 0;
  };

  const onPointerMove = (e) => {
    if (!state.isDragging) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    const dx = clientX - state.prevMousePos.x;
    const dy = clientY - state.prevMousePos.y;
    state.dragDistance += Math.abs(dx) + Math.abs(dy);

    state.prevMousePos = { x: clientX, y: clientY };

    state.rotVelY = dx * 0.013;
    state.rotVelX = dy * 0.011;

    state.targetRotY += state.rotVelY;
    state.targetRotX = Math.max(-0.32, Math.min(0.32, state.targetRotX + state.rotVelX));
  };

  const onPointerUp = () => {
    if (!state.isDragging) return;
    state.isDragging = false;
    domEl.style.cursor = 'grab';
    if (state.dragDistance < 6 && onClickCallback) {
      onClickCallback();
    }
  };

  domEl.addEventListener('mousedown', onPointerDown);
  window.addEventListener('mousemove', onPointerMove);
  window.addEventListener('mouseup', onPointerUp);

  domEl.addEventListener('touchstart', onPointerDown, { passive: true });
  window.addEventListener('touchmove', onPointerMove, { passive: true });
  window.addEventListener('touchend', onPointerUp);

  const onResize = () => {
    if (!state.renderer || !state.camera || !container) return;
    const w = container.clientWidth || (slotKey === 'hero' ? 224 : 240);
    const h = container.clientHeight || (slotKey === 'hero' ? 224 : 240);
    if (w > 0 && h > 0) {
      state.camera.aspect = w / h;
      state.camera.updateProjectionMatrix();
      state.renderer.setSize(w, h);
    }
  };
  window.addEventListener('resize', onResize);

  state.cleanupEvents = () => {
    domEl.removeEventListener('mousedown', onPointerDown);
    window.removeEventListener('mousemove', onPointerMove);
    window.removeEventListener('mouseup', onPointerUp);
    domEl.removeEventListener('touchstart', onPointerDown);
    window.removeEventListener('touchmove', onPointerMove);
    window.removeEventListener('touchend', onPointerUp);
    window.removeEventListener('resize', onResize);
  };

  // 11. 60fps Animation Loop
  const animate = () => {
    state.animFrameId = requestAnimationFrame(animate);

    // If container is inside a hidden view, skip rendering to save battery/GPU
    if (container.offsetParent === null && slotKey === 'hero') {
      return;
    }

    // Auto-adjust if container was previously 0x0 when tab was hidden
    if (container.clientWidth > 0 && container.clientHeight > 0) {
      const canvas = state.renderer.domElement;
      if (Math.abs(canvas.clientWidth - container.clientWidth) > 4 || Math.abs(canvas.clientHeight - container.clientHeight) > 4) {
        onResize();
      }
    }

    state.idleClock += 0.02;

    if (!state.isDragging) {
      if (autoRotate360) {
        // Continuous smooth 360-degree self-rotation in Hero Section
        state.rotVelY = THREE.MathUtils.lerp(state.rotVelY, 0.011, 0.04);
        state.targetRotY += state.rotVelY;
        state.targetRotX = THREE.MathUtils.lerp(state.targetRotX, Math.sin(state.idleClock * 0.6) * 0.06, 0.05);
      } else {
        // Modal inspector: momentum decay + gentle specular sway
        state.rotVelY *= 0.95;
        state.rotVelX *= 0.95;
        const idleSway = Math.sin(state.idleClock * 0.75) * 0.24;
        if (Math.abs(state.rotVelY) > 0.001) {
          state.targetRotY += state.rotVelY;
        } else {
          state.targetRotY = THREE.MathUtils.lerp(state.targetRotY, idleSway, 0.05);
        }
      }
    }

    state.currentRotX = THREE.MathUtils.lerp(state.currentRotX, state.targetRotX, 0.14);
    state.currentRotY = THREE.MathUtils.lerp(state.currentRotY, state.targetRotY, 0.14);

    if (state.mesh) {
      state.mesh.rotation.x = state.currentRotX;
      state.mesh.rotation.y = state.currentRotY;
      state.mesh.position.y = Math.sin(state.idleClock) * 0.045;
    }

    state.renderer.render(state.scene, state.camera);
  };

  _instances[slotKey] = state;
  animate();
}

function destroyViewerInstance(slotKey) {
  const inst = _instances[slotKey];
  if (!inst) return;

  if (inst.animFrameId) {
    cancelAnimationFrame(inst.animFrameId);
    inst.animFrameId = null;
  }
  if (inst.cleanupEvents) {
    inst.cleanupEvents();
    inst.cleanupEvents = null;
  }
  if (inst.mesh) {
    if (inst.mesh.geometry) inst.mesh.geometry.dispose();
    if (Array.isArray(inst.mesh.material)) {
      inst.mesh.material.forEach((m) => m.dispose());
    } else if (inst.mesh.material) {
      inst.mesh.material.dispose();
    }
    inst.mesh = null;
  }
  if (inst.renderer) {
    inst.renderer.dispose();
    if (inst.renderer.domElement && inst.renderer.domElement.parentElement) {
      const parent = inst.renderer.domElement.parentElement;
      const fallbackImg = parent.querySelector('#donor3DMedalImg');
      if (fallbackImg) fallbackImg.style.display = '';
      parent.removeChild(inst.renderer.domElement);
    }
    inst.renderer = null;
  }
  _instances[slotKey] = null;
}

/**
 * Mounts the interactive 3D Medal Inspector inside `#badgeCertModal`.
 */
export function mount3DMedalViewer(container, medalData) {
  createMedalViewerInstance('modal', container, medalData, { autoRotate360: false });
}

export function destroy3DMedalViewer() {
  destroyViewerInstance('modal');
}

/**
 * Mounts the live, self-rotating 3D Tier Medal inside the Hero Section (`#hero3DMedalStage`).
 * Automatically updates whenever the donor unlocks a higher tier.
 */
export function mountHero3DMedalViewer(container, medalData, onClick) {
  if (!container) return;
  const incomingKey = medalData?.id || medalData?.tier || '';
  const existing = _instances.hero;
  // If already mounted with the exact same tier medal and canvas is still in container, just keep spinning smoothly
  if (existing && existing.heroKey === incomingKey && container.contains(existing.renderer?.domElement)) {
    return;
  }
  createMedalViewerInstance('hero', container, medalData, {
    autoRotate360: true,
    onClick,
  });
}

export function destroyHero3DMedalViewer() {
  destroyViewerInstance('hero');
}
