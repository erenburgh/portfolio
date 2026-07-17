// Интерактивная стеклянная голова для главной.
//
// Оригинальная картинка лежит на плоскости, карта глубины приподнимает
// рельеф (нос — ближняя точка), голова плавно наклоняется за курсором.
// Поверх — стеклянные эффекты из градиента глубины: френель, мягкий блик,
// лёгкое преломление и призматическая полоса-блик (та же, что бегает по
// Let's create): позицию полосы и её видимость сайт задаёт через
// handle.glare.{sweep,strength}, сглаживание — внутри цикла.
// В покое (без наклона и блика) картинка попиксельно равна оригиналу.
import * as THREE from 'three';

const MAX_TILT_X = THREE.MathUtils.degToRad(4); // вертикальный наклон, ±4°
const MAX_TILT_Y = THREE.MathUtils.degToRad(6); // горизонтальный, ±6°
const DEPTH_SCALE = 0.18;   // высота рельефа (плоскость 2x2 юнита)
const SEGMENTS = 220;
const EASE = 4.0;           // сглаживание наклона, 1/с
const GLARE_EASE = 5.6;     // сглаживание блика (~0.09/кадр при 60 fps, как у текста)
const IDLE_AFTER = 2500;    // мс без мыши до автодрейфа
const NORMAL_BOOST = 1.5;
const FOV = 30;
const EXPOSURE = 0.76;      // общая яркость стекла (1 = оригинал картинки)

const vertexShader = /* glsl */ `
  uniform sampler2D uDepth;
  uniform float uDepthScale;

  varying vec2 vUv;
  varying float vDepth;
  varying vec3 vPos;

  void main() {
    vUv = uv;
    float d = texture2D(uDepth, uv).r;
    vDepth = d;
    vec3 p = position;
    p.z += d * uDepthScale;
    vPos = p;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  uniform sampler2D uMap;
  uniform sampler2D uDepth;
  uniform vec2  uTexel;
  uniform float uNormalScale;
  uniform vec3  uCamModel;
  uniform vec2  uTilt;
  uniform float uTiltNorm;
  uniform float uRefract;
  uniform float uAberration;
  uniform float uRim;
  uniform float uSheen;
  uniform float uExposure; // общая яркость стекла
  uniform float uSweep;   // центр полосы блика вдоль её оси
  uniform float uGlare;   // видимость блика 0..1

  varying vec2 vUv;
  varying float vDepth;
  varying vec3 vPos;

  vec3 surfaceNormal() {
    float l = texture2D(uDepth, vUv - vec2(uTexel.x, 0.0)).r;
    float r = texture2D(uDepth, vUv + vec2(uTexel.x, 0.0)).r;
    float b = texture2D(uDepth, vUv - vec2(0.0, uTexel.y)).r;
    float t = texture2D(uDepth, vUv + vec2(0.0, uTexel.y)).r;
    return normalize(vec3((l - r) * uNormalScale, (b - t) * uNormalScale, 1.0));
  }

  void main() {
    vec3 n = surfaceNormal();
    vec3 V = normalize(uCamModel - vPos);
    float ndv = clamp(dot(n, V), 0.0, 1.0);
    float sil = smoothstep(0.015, 0.06, vDepth);

    vec2 shift = n.xy * uRefract * uTiltNorm * (0.35 + 0.65 * vDepth);
    vec2 ca = n.xy * uAberration * uTiltNorm;

    vec3 col;
    col.r = texture2D(uMap, vUv + shift + ca).r;
    col.g = texture2D(uMap, vUv + shift).g;
    col.b = texture2D(uMap, vUv + shift - ca).b;
    col *= uExposure; // притушенное стекло: эффекты ниже масштабируются через lum

    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));

    float fres = pow(1.0 - ndv, 3.2) * sil;
    col += fres * vec3(0.72, 0.80, 0.95) * uRim * (0.18 + 0.82 * lum);

    vec3 L = normalize(vec3(uTilt.y * 1.6, -uTilt.x * 1.6 + 0.25, 0.9));
    vec3 H = normalize(L + V);
    float spec = pow(clamp(dot(n, H), 0.0, 1.0), 120.0) * sil;
    col += spec * vec3(0.85, 0.90, 1.0) * uSheen * (0.15 + 0.85 * lum);

    // призматическая полоса: тот же наклон 112°, что у блика Let's create.
    // Узкий штрих + слабый хвост; светятся в основном рёбра стекла (lum),
    // тёмные зоны получают лишь лёгкую вуаль — блик по грани, не засветка
    float t = dot(vUv - 0.5, vec2(0.927, -0.374)) + 0.5;
    float d = t - uSweep;
    float band = exp(-pow(d / 0.035, 2.0)) + 0.18 * exp(-pow((d - 0.06) / 0.08, 2.0));
    col += band * uGlare * vec3(0.96, 0.98, 1.05) * 1.4 * (0.10 + 0.90 * lum) * sil;

    float dn = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    col += (dn - 0.5) / 255.0;

    // тени пропускают фон страницы заметнее, чем светлые грани
    float a = sil * clamp(0.56 + lum * 1.3, 0.0, 1.0);
    a = max(a, fres * 0.28);
    gl_FragColor = vec4(col, a);
  }
`;

function loadTexture(url) {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(url, resolve, undefined, reject);
  });
}

export async function mountGlassHead(stage, urls = {}) {
  const face = urls.face || 'assets/hero/face.png';
  const depthUrl = urls.depth || 'assets/hero/depth.png';
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const [map, depth] = await Promise.all([loadTexture(face), loadTexture(depthUrl)]);

  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: false,
    powerPreference: 'low-power',
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  map.magFilter = THREE.LinearFilter;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  depth.magFilter = THREE.LinearFilter;
  depth.minFilter = THREE.LinearFilter;
  depth.generateMipmaps = false;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 10);
  camera.position.z = 1 / Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * 1.02;

  const uniforms = {
    uMap: { value: map },
    uDepth: { value: depth },
    uDepthScale: { value: DEPTH_SCALE },
    uTexel: { value: new THREE.Vector2(1 / depth.image.width, 1 / depth.image.height) },
    uNormalScale: { value: DEPTH_SCALE * depth.image.width / 4 * NORMAL_BOOST },
    uCamModel: { value: new THREE.Vector3(0, 0, camera.position.z) },
    uTilt: { value: new THREE.Vector2() },
    uTiltNorm: { value: 0 },
    uRefract: { value: 0.0035 },
    uAberration: { value: 0.0010 },
    uRim: { value: 0.26 },      // френель мягче — без «рентгена»
    uSheen: { value: 0.24 },
    uExposure: { value: EXPOSURE },
    uSweep: { value: -0.4 },   // полоса за левым краем — не видна
    uGlare: { value: 0 },
  };

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms,
    transparent: true,
    depthWrite: false,
    // premultiplied-вывод: в покое картинка равна оригиналу,
    // фон страницы подмешивается только добавлением
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2, SEGMENTS, SEGMENTS), material);
  scene.add(mesh);

  stage.appendChild(renderer.domElement);

  // цели блика — их задаёт сайт (mousemove по интро), лерп внутри цикла
  const glare = { sweep: -0.4, strength: 0 };

  const camLocal = new THREE.Vector3();
  function render() {
    camLocal.copy(camera.position);
    mesh.worldToLocal(camLocal);
    uniforms.uCamModel.value.copy(camLocal);
    uniforms.uTilt.value.set(mesh.rotation.x, mesh.rotation.y);
    uniforms.uTiltNorm.value = Math.min(
      1,
      Math.hypot(mesh.rotation.x / MAX_TILT_X, mesh.rotation.y / MAX_TILT_Y),
    );
    renderer.render(scene, camera);
  }

  function resize() {
    const w = stage.clientWidth || 1;
    renderer.setSize(w, w, false);
    if (reducedMotion) render();
  }
  new ResizeObserver(resize).observe(stage);
  resize();

  renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    stage.classList.remove('live'); // возвращаем статичный <img>
  });

  const handle = { renderer, scene, camera, mesh, uniforms, render, glare };

  if (reducedMotion) {
    render();
    stage.classList.add('live');
    return handle;
  }

  const target = new THREE.Vector2(); // x = rotX, y = rotY
  let lastPointer = -IDLE_AFTER;
  let idle = 0;

  window.addEventListener('pointermove', (e) => {
    const nx = (e.clientX / window.innerWidth) * 2 - 1;
    const ny = (e.clientY / window.innerHeight) * 2 - 1;
    target.set(ny * MAX_TILT_X, nx * MAX_TILT_Y);
    lastPointer = performance.now();
  }, { passive: true });

  let visible = true;
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; })
    .observe(stage);

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    if (!visible) return;

    const t = clock.elapsedTime;
    const idleTarget = performance.now() - lastPointer > IDLE_AFTER ? 1 : 0;
    idle += (idleTarget - idle) * (1 - Math.exp(-1.2 * dt));
    const driftX = Math.sin(t * 0.23 + 1.7) * THREE.MathUtils.degToRad(0.8) * idle;
    const driftY = Math.sin(t * 0.31) * THREE.MathUtils.degToRad(1.4) * idle;

    const s = 1 - Math.exp(-EASE * dt);
    mesh.rotation.x += (target.x + driftX - mesh.rotation.x) * s;
    mesh.rotation.y += (target.y + driftY - mesh.rotation.y) * s;

    const g = 1 - Math.exp(-GLARE_EASE * dt);
    uniforms.uSweep.value += (glare.sweep - uniforms.uSweep.value) * g;
    uniforms.uGlare.value += (glare.strength - uniforms.uGlare.value) * g;

    render();
  });

  render();
  stage.classList.add('live');
  return handle;
}
