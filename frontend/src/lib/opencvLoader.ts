// Lazily loads OpenCV.js from a CDN — only needed on the Scan page, so we
// don't pay its ~8MB wasm cost on every route. jscanify's browser build
// expects a global `cv` with `cv.Mat` ready.
let loadPromise: Promise<void> | null = null;

export function loadOpenCv(): Promise<void> {
  const w = window as unknown as { cv?: any };
  if (w.cv?.Mat) return Promise.resolve();
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://docs.opencv.org/4.7.0/opencv.js';
    script.async = true;
    script.onload = () => {
      const cv = (window as unknown as { cv: any }).cv;
      if (!cv) { reject(new Error('OpenCV failed to attach to window')); return; }
      if (cv.Mat) { resolve(); return; }
      cv['onRuntimeInitialized'] = () => resolve();
    };
    script.onerror = () => reject(new Error('Failed to load OpenCV script'));
    document.body.appendChild(script);
  });
  return loadPromise;
}
