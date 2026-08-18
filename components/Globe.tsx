import { useEffect, useRef } from 'react';
import * as THREE from 'three';

/**
 * Globus sa lukovima od Beograda do destinacija koje se STVARNO nalaze
 * u indeksiranim cenovnicima. Nije dekoracija — vizualizuje šta bot zna.
 *
 * Ako dodaš PDF-ove, dopuni ovu listu da se poklopi sa korpusom.
 */
const ORIGIN = { lat: 44.79, lon: 20.45 };

export const DESTINATIONS = [
  { name: 'Rim', lat: 41.9, lon: 12.5 },
  { name: 'Istanbul', lat: 41.01, lon: 28.98 },
  { name: 'Malta', lat: 35.9, lon: 14.51 },
  { name: 'Maroko', lat: 31.63, lon: -7.99 },
  { name: 'Lisabon', lat: 38.72, lon: -9.14 },
  { name: 'Porto', lat: 41.15, lon: -8.61 },
  { name: 'Amsterdam', lat: 52.37, lon: 4.9 },
  { name: 'Sankt Peterburg', lat: 59.93, lon: 30.34 },
  { name: 'Bari', lat: 41.12, lon: 16.87 },
  { name: 'Kairo', lat: 30.04, lon: 31.24 },
  { name: 'Andaluzija', lat: 37.39, lon: -5.98 },
  { name: 'Škotska', lat: 55.95, lon: -3.19 },
  { name: 'Francuska', lat: 48.86, lon: 2.35 },
];

const RADIUS = 1;
const COLOR_GRID = 0x1f3a52;
const COLOR_CORE = 0x0b1a2a;
const COLOR_AMBER = 0xf0a22e;
const COLOR_TEAL = 0x2e8c8c;

/**
 * Početna rotacija dovodi Beograd u centar kadra.
 * Izračunato iz latLonToVector3(44.79, 20.45): tačka pada na +x/-z, pa je
 * potrebna rotacija oko Y da dođe na +z, prema kameri.
 */
const INITIAL_YAW = 1.93;
const INITIAL_PITCH = 0.3;

function latLonToVector3(lat: number, lon: number, radius = RADIUS): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);

  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

function buildArc(from: THREE.Vector3, to: THREE.Vector3): THREE.CatmullRomCurve3 {
  const distance = from.distanceTo(to);
  const peak = 1 + distance * 0.4;
  const shoulder = 1 + distance * 0.2;

  const mid = from.clone().add(to).normalize().multiplyScalar(RADIUS * peak);
  const q1 = from.clone().lerp(mid, 0.5).normalize().multiplyScalar(RADIUS * shoulder);
  const q2 = to.clone().lerp(mid, 0.5).normalize().multiplyScalar(RADIUS * shoulder);

  return new THREE.CatmullRomCurve3([from, q1, mid, q2, to]);
}

interface Route {
  arc: THREE.LineBasicMaterial;
  dot: THREE.MeshBasicMaterial;
  dotMesh: THREE.Mesh;
  traveller: THREE.Mesh;
  curve: THREE.CatmullRomCurve3;
  offset: number;
}

export default function Globe({ activeIndex = null }: { activeIndex?: number | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const routesRef = useRef<Route[]>([]);
  const activeRef = useRef<number | null>(null);

  /** Hover u listi destinacija osvetljava odgovarajući luk. */
  useEffect(() => {
    activeRef.current = activeIndex;

    routesRef.current.forEach((route, i) => {
      const isActive = activeIndex === i;
      const isDimmed = activeIndex !== null && !isActive;

      route.arc.color.setHex(isActive ? COLOR_AMBER : COLOR_TEAL);
      route.arc.opacity = isActive ? 1 : isDimmed ? 0.12 : 0.5;
      route.dot.color.setHex(isActive ? COLOR_AMBER : COLOR_TEAL);
      route.dot.opacity = isDimmed ? 0.2 : 1;
      route.dotMesh.scale.setScalar(isActive ? 1.9 : 1);
      route.traveller.visible = !isDimmed;
    });
  }, [activeIndex]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    camera.position.set(0, 0, 3.6);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    const world = new THREE.Group();
    world.rotation.set(INITIAL_PITCH, INITIAL_YAW, 0);
    scene.add(world);

    world.add(
      new THREE.Mesh(
        new THREE.SphereGeometry(RADIUS, 44, 30),
        new THREE.MeshBasicMaterial({
          color: COLOR_GRID,
          wireframe: true,
          transparent: true,
          opacity: 0.3,
        }),
      ),
    );

    // Puna unutrašnja sfera — bez nje lukovi sa druge strane prosijavaju.
    world.add(
      new THREE.Mesh(
        new THREE.SphereGeometry(RADIUS * 0.99, 44, 30),
        new THREE.MeshBasicMaterial({ color: COLOR_CORE }),
      ),
    );

    const originVec = latLonToVector3(ORIGIN.lat, ORIGIN.lon);

    const originDot = new THREE.Mesh(
      new THREE.SphereGeometry(0.024, 14, 14),
      new THREE.MeshBasicMaterial({ color: COLOR_AMBER }),
    );
    originDot.position.copy(originVec);
    world.add(originDot);

    const routes: Route[] = [];

    DESTINATIONS.forEach((dest, i) => {
      const destVec = latLonToVector3(dest.lat, dest.lon);
      const curve = buildArc(originVec, destVec);

      const arcMaterial = new THREE.LineBasicMaterial({
        color: COLOR_TEAL,
        transparent: true,
        opacity: 0.5,
      });
      world.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(curve.getPoints(72)),
          arcMaterial,
        ),
      );

      const dotMaterial = new THREE.MeshBasicMaterial({
        color: COLOR_TEAL,
        transparent: true,
      });
      const dotMesh = new THREE.Mesh(new THREE.SphereGeometry(0.015, 10, 10), dotMaterial);
      dotMesh.position.copy(destVec);
      world.add(dotMesh);

      const traveller = new THREE.Mesh(
        new THREE.SphereGeometry(0.012, 8, 8),
        new THREE.MeshBasicMaterial({ color: COLOR_AMBER }),
      );
      world.add(traveller);

      routes.push({
        arc: arcMaterial,
        dot: dotMaterial,
        dotMesh,
        traveller,
        curve,
        offset: i / DESTINATIONS.length,
      });
    });

    routesRef.current = routes;

    // -----------------------------------------------------------------------

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let velocity = 0;

    const onPointerDown = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      renderer.domElement.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;

      world.rotation.y += dx * 0.005;
      world.rotation.x = THREE.MathUtils.clamp(world.rotation.x + dy * 0.004, -0.4, 0.9);
      velocity = dx * 0.005;
    };

    const onPointerUp = () => {
      dragging = false;
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    const resize = () => {
      const { clientWidth, clientHeight } = container;
      if (!clientWidth || !clientHeight) return;
      renderer.setSize(clientWidth, clientHeight, false);
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    let frame = 0;
    let running = true;
    const clock = new THREE.Clock();
    const autoSpin = reducedMotion ? 0 : 0.0006;

    const tick = () => {
      if (!running) return;
      frame = requestAnimationFrame(tick);

      if (!dragging) {
        // Rotacija staje dok je neka destinacija istaknuta.
        world.rotation.y += (activeRef.current === null ? autoSpin : 0) + velocity;
        velocity *= 0.94;
      }

      if (!reducedMotion) {
        const t = clock.getElapsedTime() * 0.07;
        for (const route of routesRef.current) {
          route.traveller.position.copy(route.curve.getPointAt((t + route.offset) % 1));
        }
      }

      renderer.render(scene, camera);
    };

    tick();

    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(frame);
      } else if (!running) {
        running = true;
        tick();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      running = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      routesRef.current = [];

      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
          obj.geometry.dispose();
          const material = obj.material;
          if (Array.isArray(material)) material.forEach((m) => m.dispose());
          else material.dispose();
        }
      });

      renderer.dispose();
      container.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="h-full w-full cursor-grab active:cursor-grabbing"
      aria-hidden="true"
    />
  );
}