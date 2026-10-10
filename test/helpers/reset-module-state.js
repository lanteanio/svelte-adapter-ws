import { vi } from 'vitest';

// A VM worker may execute several files in one module registry. Reset it
// before the other setup files capture globals or runtime cleanup registries.
// Each file then owns its client singleton and injected runtime environment.
vi.resetModules();
