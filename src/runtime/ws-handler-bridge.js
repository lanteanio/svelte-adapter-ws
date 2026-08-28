// Placeholder bridge: `WS_HANDLER` is substituted by the adapter's build step
// with a path relative to the runtime payload ROOT. Modules under handler/
// import the app's WebSocket handler module through this root-level bridge so
// they need no substitution of their own.

import * as wsModule from 'WS_HANDLER';

export { wsModule };
