import * as THREE from 'three';

const textureCache = new Map<number, THREE.CanvasTexture>();

export function getGlowTexture(colorHex: number): THREE.CanvasTexture {
  if (textureCache.has(colorHex)) return textureCache.get(colorHex)!;

  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  const r = (colorHex >> 16) & 255;
  const g = (colorHex >> 8) & 255;
  const b = colorHex & 255;

  const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  gradient.addColorStop(0,   `rgba(${r},${g},${b},0.9)`);
  gradient.addColorStop(0.2, `rgba(${r},${g},${b},0.5)`);
  gradient.addColorStop(0.5, `rgba(${r},${g},${b},0.15)`);
  gradient.addColorStop(1,   `rgba(${r},${g},${b},0)`);

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);

  const texture = new THREE.CanvasTexture(canvas);
  textureCache.set(colorHex, texture);
  return texture;
}

export function createGlowSprite(
  colorHex: number,
  radius: number,
  isGodNode: boolean,
): THREE.Sprite {
  const texture = getGlowTexture(colorHex);
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const sprite = new THREE.Sprite(material);
  const scale = radius * (isGodNode ? 12 : 7);
  sprite.scale.setScalar(scale);
  return sprite;
}

export function createGodNodeOuterHalo(colorHex: number, radius: number): THREE.Sprite {
  const texture = getGlowTexture(0xffffff);
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    opacity: 0.15,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.setScalar(radius * 22);
  return sprite;
}
