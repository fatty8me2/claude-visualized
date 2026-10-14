import { nativeImage, type NativeImage } from 'electron';

/** Paint a filled, anti-aliased circle into a BGRA bitmap (Electron's native bitmap order on every platform). */
export function paintDot(bitmap: Buffer, width: number, height: number, cx: number, cy: number, r: number, rgb: [number, number, number]) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const cover = Math.max(0, Math.min(1, r + 0.5 - d));
      if (cover <= 0) continue;
      const o = (y * width + x) * 4;
      const a = cover * 255;
      const inv = 1 - cover;
      bitmap[o] = Math.round(rgb[2] * cover + bitmap[o] * inv);
      bitmap[o + 1] = Math.round(rgb[1] * cover + bitmap[o + 1] * inv);
      bitmap[o + 2] = Math.round(rgb[0] * cover + bitmap[o + 2] * inv);
      bitmap[o + 3] = Math.max(bitmap[o + 3], Math.round(a));
    }
  }
}

const ALERT: [number, number, number] = [255, 90, 70];
const RING: [number, number, number] = [255, 255, 255];

/** A copy of the tray image with a red dot in its top-right corner. */
export function withDot(img: NativeImage): NativeImage {
  if (img.isEmpty()) return img;
  const sf = img.getScaleFactors()[0] || 1;
  const size = img.getSize();
  const w = Math.round(size.width * sf);
  const h = Math.round(size.height * sf);
  const bmp = Buffer.from(img.toBitmap({ scaleFactor: sf }));
  if (bmp.length !== w * h * 4) return img;
  const r = Math.max(3, Math.round(Math.min(w, h) * 0.2));
  paintDot(bmp, w, h, w - r - 1, r + 1, r + 1.2, RING);
  paintDot(bmp, w, h, w - r - 1, r + 1, r, ALERT);
  return nativeImage.createFromBitmap(bmp, { width: w, height: h, scaleFactor: sf });
}
/** 16x16 overlay for the Windows taskbar button. */
export function overlayIcon(): NativeImage {
  const size = 16;
  const bmp = Buffer.alloc(size * size * 4);
  paintDot(bmp, size, size, size / 2, size / 2, 7.5, RING);
  paintDot(bmp, size, size, size / 2, size / 2, 6, ALERT);
  return nativeImage.createFromBitmap(bmp, { width: size, height: size, scaleFactor: 1 });
}
