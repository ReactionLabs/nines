"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/**
 * The Nines mascot: chrome robot GLB in a circular bubble.
 * - Faces the camera on load (face features sit on +z, toward the camera)
 * - Idle loops; Blink and LookAround fire on timers so he looks alive
 * - Drag to spin him around
 * - connected: driven by the live data stream. Data flowing = solid green
 *   dot; stream quiet = dimmed, degraded look. No pulse animations: the
 *   stream state IS the indicator.
 */
export function Mascot({
  size = 220,
  connected = true,
}: {
  size?: number;
  connected?: boolean;
}) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    camera.position.set(0, 0.1, 4.2);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(size, size);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    mount.appendChild(renderer.domElement);

    // Lighting: soft key + green rim to match the terminal theme.
    scene.add(new THREE.HemisphereLight(0xffffff, 0x0a0f14, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(2.5, 3, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x55d187, 1.6);
    rim.position.set(-3, 1.5, -2.5);
    scene.add(rim);

    const rig = new THREE.Group();
    scene.add(rig);

    const loader = new GLTFLoader();
    let mixer: THREE.AnimationMixer | null = null;
    const clips: Record<string, THREE.AnimationClip> = {};
    let idleAction: THREE.AnimationAction | null = null;
    let cancelled = false;

    loader.load(
      "/mascot/nines-mascot-app.glb",
      (gltf) => {
        if (cancelled) return;
        const model = gltf.scene;
        // Center and scale to fit the bubble.
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        const dims = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(dims.x, dims.y, dims.z);
        const scale = 2.1 / maxDim;
        model.scale.setScalar(scale);
        model.position.sub(center.multiplyScalar(scale));
        rig.add(model);

        // Face features (eyes, mouth) sit on +z, already toward the camera.
        rig.rotation.y = 0;

        mixer = new THREE.AnimationMixer(model);
        for (const clip of gltf.animations ?? []) {
          clips[clip.name] = clip;
        }
        if (clips["Idle"]) {
          idleAction = mixer.clipAction(clips["Idle"]);
          idleAction.play();
        }

        // He looks busy: blink every few seconds, glance around occasionally.
        const blinkTimer = window.setInterval(() => {
          if (!mixer || !clips["Blink"] || cancelled) return;
          const a = mixer.clipAction(clips["Blink"]);
          a.setLoop(THREE.LoopOnce, 1);
          a.reset().play();
        }, 4200);
        const lookTimer = window.setInterval(() => {
          if (!mixer || !clips["LookAround"] || cancelled) return;
          const a = mixer.clipAction(clips["LookAround"]);
          a.setLoop(THREE.LoopOnce, 1);
          a.reset().play();
        }, 11000);
        (rig as unknown as { __timers: number[] }).__timers = [
          blinkTimer,
          lookTimer,
        ];
      },
      undefined,
      () => {
        /* GLB missing: bubble stays empty, never crashes the page */
      }
    );

    // Drag to spin.
    let dragging = false;
    let lastX = 0;
    let velocity = 0;
    const el = renderer.domElement;
    el.style.cursor = "grab";
    el.style.touchAction = "pan-y";
    const onDown = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      velocity = 0;
      el.style.cursor = "grabbing";
      el.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      velocity = dx * 0.012;
      rig.rotation.y += velocity;
    };
    const onUp = () => {
      dragging = false;
      el.style.cursor = "grab";
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);

    const clock = new THREE.Clock();
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(clock.getDelta(), 0.05);
      if (mixer) mixer.update(dt);
      if (!dragging && Math.abs(velocity) > 0.0004) {
        rig.rotation.y += velocity;
        velocity *= 0.94; // spin-down friction
      }
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      const timers = (rig as unknown as { __timers?: number[] }).__timers;
      timers?.forEach((t) => clearInterval(t));
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      renderer.dispose();
      mount.removeChild(el);
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      });
    };
  }, [size]);

  return (
    <div
      className="relative mx-auto"
      style={{ width: size, height: size }}
      aria-label="The Nines mascot"
    >
      {/* bubble */}
      <div
        className="absolute inset-0 rounded-full border border-up/30 bg-gradient-to-b from-surface to-bg shadow-[0_0_60px_-12px_rgba(85,209,135,0.35)]"
      />
      <div
        ref={mountRef}
        className="absolute inset-0 overflow-hidden rounded-full"
        style={
          connected
            ? undefined
            : { filter: "grayscale(0.7) brightness(0.6)", opacity: 0.7 }
        }
      />
      {/* WATCHING badge: solid dot, no animation. Stream state is the indicator. */}
      <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-up/40 bg-bg/90 px-3 py-1 font-mono text-[10px] tracking-widest text-up">
        <span
          className={
            connected
              ? "mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-up"
              : "mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-mut/40"
          }
        />
        {connected ? "WATCHING" : "OFFLINE"}
      </div>
    </div>
  );
}
