/**
 * Load the pinned, self-contained OpenCV.js build from this app's origin.
 * The official 4.8.0 script uses an Emscripten Module global and initializes
 * asynchronously; script.onload alone does not mean its bindings are usable.
 */

const SCRIPT_URL = new URL('../vendor/opencv-4.8.0.js', import.meta.url).href;
let pending;

export function hasOpenCvFeatures(cv) {
  return Boolean(cv?.Mat && cv?.matFromImageData && cv?.matFromArray &&
    cv?.cvtColor && cv?.ORB && cv?.BFMatcher && cv?.findHomography &&
    cv?.KeyPointVector && cv?.DMatchVectorVector &&
    cv?.NORM_HAMMING !== undefined && cv?.RANSAC !== undefined);
}

export function loadLocalOpenCv() {
  // Emscripten Module is thenable. Wrap it so Promise resolution does not
  // recursively assimilate the module instead of completing.
  if (hasOpenCvFeatures(globalThis.cv)) return Promise.resolve({ cv: globalThis.cv });
  if (hasOpenCvFeatures(globalThis.Module)) return Promise.resolve({ cv: globalThis.Module });
  if (!globalThis.document?.createElement) return Promise.resolve({ cv: null });
  if (pending) return pending;

  pending = new Promise(resolve => {
    const script = document.createElement('script');
    let settled = false;
    const finish = cv => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ cv: hasOpenCvFeatures(cv) ? cv : null });
    };
    const module = {
      onRuntimeInitialized() {
        finish(hasOpenCvFeatures(this) ? this : globalThis.Module);
      },
    };
    // OpenCV's UMD wrapper calls cv(Module), so this must exist before the
    // classic script executes. It does not fetch images or send data anywhere.
    globalThis.Module = module;
    script.src = SCRIPT_URL;
    script.async = true;
    script.onerror = () => finish(null);
    script.onload = () => {
      if (hasOpenCvFeatures(globalThis.cv)) finish(globalThis.cv);
      else if (hasOpenCvFeatures(globalThis.Module)) finish(globalThis.Module);
    };
    const timeout = setTimeout(() => finish(null), 20_000);
    (document.head || document.body || document.documentElement).append(script);
  });
  return pending;
}
