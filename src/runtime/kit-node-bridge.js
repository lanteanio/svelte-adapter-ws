// Placeholder bridge: `KIT_NODE` is substituted by the adapter's build step
// with a path relative to the runtime payload ROOT. Modules under handler/
// cannot carry that substitution themselves (their relative position differs),
// so they import the bundled @sveltejs/kit/node primitives through this
// root-level bridge instead.

export { getRequest, setResponse, createReadableStream } from 'KIT_NODE';
