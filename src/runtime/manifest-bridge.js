// Placeholder bridge: `MANIFEST` is substituted by the adapter's build step
// with a path relative to the runtime payload ROOT. Modules under handler/
// cannot carry that substitution themselves (their relative position differs),
// so they import the manifest exports through this root-level bridge instead.

export { manifest, prerendered, base } from 'MANIFEST';
