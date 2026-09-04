// Contract: every label key EMITTED into a metrics instrument must be
// DECLARED at that instrument's registration.
//
// The adapter documents a Prometheus-shaped registry for `websocket.metrics`:
// counter(name, help, labelNames). A strict registry (the extensions
// createMetrics(), prom-client) THROWS when inc() carries a label that was
// never declared - and containMetricInstrument swallows that throw after one
// console.error, so on the documented registry the counter silently never
// increments. This shipped once: upgrade_rate_map_evicted_total emitted
// { door: 'upgrade' | 'auth' } from both rate limiters while the registration
// declared no labels, so the door split (and the whole counter) was dead
// everywhere except the fixture's aggregating registry, which deliberately
// ignores labels and therefore cannot see the class.
//
// What this pins: for every instrument registered in the runtime sources,
// every label key any emit site passes is a subset of the declared
// labelNames. Scanned statically (the only complete view - no test boots
// every emit path), then replayed against a strict registry so the failure
// mode itself is exercised.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import {
	SIGNALS,
	validateObservabilityContract
} from '../src/runtime/observability-manifest.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');


// Every file that registers instruments on the operator-supplied registry
// (the `websocket.metrics` contract). wireAssertionMetrics receives that same
// registry from the handler, so its registration and emit are in scope too.
const FILES = [
	'src/runtime/handler/realtime.js',
	'src/testing.js',
	'src/runtime/utils/assertions.js'
];

const FACTORY_METHODS = new Set(['counter', 'gauge', 'histogram']);
const EMIT_METHODS = new Set(['inc', 'dec', 'set', 'observe']);

/** Flatten an acorn tree into an array of nodes (same idiom as the option contract). */
function nodes(root) {
	const out = [];
	const visit = (node) => {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node)) { for (const item of node) visit(item); return; }
		if (typeof node.type !== 'string') return;
		out.push(node);
		for (const [key, value] of Object.entries(node)) {
			if (key === 'type' || key === 'start' || key === 'end') continue;
			visit(value);
		}
	};
	visit(root);
	return out;
}

/** Property name of a member/optional-member expression, else null. */
function memberName(expr) {
	if (!expr || (expr.type !== 'MemberExpression' && expr.type !== 'OptionalMemberExpression')) return null;
	return !expr.computed && expr.property?.type === 'Identifier' ? expr.property.name : null;
}

/** The counter/gauge/histogram factory call inside an expression, if any. */
function findFactoryCall(expr) {
	if (!expr) return null;
	// METRICS?.counter(...) parses as a ChainExpression wrapping the call.
	if (expr.type === 'ChainExpression') return findFactoryCall(expr.expression);
	if (expr.type !== 'CallExpression') return null;
	if (FACTORY_METHODS.has(memberName(expr.callee))) return expr;
	// containMetricInstrument(<factory>) - the emit wrapper used everywhere.
	if (expr.callee?.type === 'Identifier' && expr.callee.name === 'containMetricInstrument') {
		return expr.arguments.length > 0 ? findFactoryCall(expr.arguments[0]) : null;
	}
	return null;
}

/**
 * Unwrap the shapes an instrument binding takes in these sources:
 *   containMetricInstrument(METRICS?.counter(...))
 *   cond ? containMetricInstrument(METRICS?.gauge(...)) : undefined
 *   metrics.counter(...)                       (wireAssertionMetrics)
 */
function unwrapFactory(expr) {
	if (!expr) return null;
	const direct = findFactoryCall(expr);
	if (direct) return direct;
	if (expr.type === 'ConditionalExpression') {
		return unwrapFactory(expr.consequent) ?? unwrapFactory(expr.alternate);
	}
	return null;
}

/**
 * Scan one source file. Returns:
 *   registrations: Map<varName, { metric, labels: Set<string>, file }>
 *   emits: [{ varName, method, keys: string[], file }]
 */
function scan(file) {
	const src = readFileSync(path.join(ROOT, file), 'utf8');
	const tree = nodes(parse(src, { ecmaVersion: 'latest', sourceType: 'module' }));
	const registrations = new Map();
	const emits = [];

	for (const node of tree) {
		// const mX = <wrapped factory>   |   boundCounter = metrics.counter(...)
		let varName = null;
		let init = null;
		if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
			varName = node.id.name;
			init = node.init;
		} else if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier') {
			varName = node.left.name;
			init = node.right;
		}
		if (varName && init) {
			const factory = unwrapFactory(init);
			if (factory && factory.arguments[0]?.type === 'Literal' && typeof factory.arguments[0].value === 'string') {
				const factoryType = memberName(factory.callee);
				let labelsArg = factory.arguments[2];
				if (factoryType === 'histogram') {
					const options = factory.arguments[2];
					expect(
						options?.type === 'ObjectExpression',
						`${file}: ${factory.arguments[0].value} histogram options must be a literal object`
					).toBe(true);
					const optionProperty = (name) => options.properties.find((property) =>
						property.type === 'Property' && !property.computed &&
						((property.key.type === 'Identifier' && property.key.name === name) ||
						(property.key.type === 'Literal' && property.key.value === name))
					);
					labelsArg = optionProperty('labelNames')?.value;
					const bucketsArg = optionProperty('buckets')?.value;
					expect(
						bucketsArg?.type === 'Identifier' || bucketsArg?.type === 'ArrayExpression',
						`${file}: ${factory.arguments[0].value} must pass explicit buckets`
					).toBe(true);
				}
				const labels = new Set();
				if (labelsArg) {
					// Declared labelNames must be a literal array of strings - anything
					// dynamic defeats this scan and is itself a failure below.
					expect(
						labelsArg.type === 'ArrayExpression' &&
						labelsArg.elements.every((el) => el?.type === 'Literal' && typeof el.value === 'string'),
						`${file}: ${factory.arguments[0].value} labelNames must be a literal string array`
					).toBe(true);
					for (const el of labelsArg.elements) labels.add(el.value);
				}
				const helpArg = factory.arguments[1];
				expect(
					helpArg?.type === 'Literal' && typeof helpArg.value === 'string',
					`${file}: ${factory.arguments[0].value} help must be a literal string so parity is auditable`
				).toBe(true);
				registrations.set(varName, {
					metric: factory.arguments[0].value,
					type: factoryType,
					help: helpArg.value,
					labels,
					file
				});
			}
		}

		// mX?.inc({ ... }) / mX.inc({ ... }) / gX?.set(n) / boundCounter.inc({ ... })
		if (node.type === 'CallExpression') {
			const method = memberName(node.callee);
			if (!method || !EMIT_METHODS.has(method)) continue;
			const object = node.callee.object;
			if (object?.type !== 'Identifier') continue;
			const labelsArg = node.arguments[0];
			if (!labelsArg || labelsArg.type !== 'ObjectExpression') continue;
			const keys = [];
			/** @type {Record<string, string>} label -> the literal VALUE emitted, where it is one */
			const literals = {};
			for (const prop of labelsArg.properties) {
				// A spread or computed key cannot be checked statically; fail loudly
				// rather than letting an unchecked label through.
				expect(
					prop.type === 'Property' && !prop.computed &&
					((prop.key.type === 'Identifier') || (prop.key.type === 'Literal' && typeof prop.key.value === 'string')),
					`${file}: ${object.name}.${method}() labels must be literal keys`
				).toBe(true);
				const key = prop.key.type === 'Identifier' ? prop.key.name : prop.key.value;
				keys.push(key);
				// A computed value cannot be checked statically and is simply not
				// recorded; a literal one is, and is checked against the manifest's
				// enum below.
				if (prop.value.type === 'Literal' && typeof prop.value.value === 'string') {
					literals[key] = prop.value.value;
				}
			}
			emits.push({ varName: object.name, method, keys, literals, file });
		}
	}
	return { registrations, emits };
}

describe('metrics label contract', () => {
	const scanned = FILES.map(scan);
	const registrations = new Map();
	const emits = [];
	for (const { registrations: r, emits: e } of scanned) {
		for (const [k, v] of r) registrations.set(k, v);
		emits.push(...e);
	}

	it('every emitted label key is declared at the instrument registration', () => {
		const violations = [];
		for (const emit of emits) {
			const reg = registrations.get(emit.varName);
			if (!reg) continue; // not an instrument variable (no factory binding found)
			for (const key of emit.keys) {
				if (!reg.labels.has(key)) {
					violations.push(
						`${emit.file}: ${emit.varName}.${emit.method}() emits label "${key}" ` +
						`not declared on "${reg.metric}" (declared: ${[...reg.labels].join(', ') || '(none)'})`
					);
				}
			}
		}
		expect(violations).toEqual([]);
	});

	it('the scan is not vacuous and pins the shipped door-label regression', () => {
		// Self-check: if the scan silently stops finding registrations or emits,
		// the contract above is proving nothing.
		expect(registrations.size).toBeGreaterThanOrEqual(12);
		expect(emits.length).toBeGreaterThanOrEqual(12);
		const door = [...registrations.values()].find((r) => r.metric === 'upgrade_rate_map_evicted_total');
		expect(door, 'upgrade_rate_map_evicted_total registration not found').toBeTruthy();
		expect([...door.labels]).toEqual(['door']);
		const doorEmit = emits.find((e) => e.varName === 'mUpgradeRateEvicted');
		expect(doorEmit?.keys).toEqual(['door']);
	});

	// The scan above proves what the code DOES. These prove that the manifest
	// and the two hand-written inventories agree with it. The scan cannot know
	// a metric's unit or how it combines across workers, and the manifest
	// cannot know whether the code actually registers what it declares, so the
	// two are complementary and each catches what the other cannot see.
	describe('signal manifest and documentation parity', () => {
		it('the shared observability schema is complete', () => {
			expect(validateObservabilityContract()).toEqual([]);
		});

		/** Metric name -> exact factory contract, as the code registers it. */
		const registered = new Map();
		for (const reg of registrations.values()) {
			const existing = registered.get(reg.metric);
			// The same metric is registered by both the production handler and the
			// test harness; the declarations must not disagree.
			if (existing !== undefined) {
				expect(
					{ type: reg.type, help: reg.help, labels: [...reg.labels] },
					`"${reg.metric}" is registered twice with different factory contracts`
				).toEqual({ type: existing.type, help: existing.help, labels: [...existing.labels] });
			}
			registered.set(reg.metric, reg);
		}
		const manifest = new Map(SIGNALS.map((s) => [s.name, s]));
		const fromRegistry = SIGNALS.filter((s) => s.merged !== true).map((s) => s.name);

		it('every registered metric exactly matches manifest factory type, labels, and help', () => {
			const undeclared = [...registered.keys()].filter((n) => !manifest.has(n)).sort();
			expect(
				undeclared,
				'registered in code but absent from src/runtime/observability-manifest.js: ' + JSON.stringify(undeclared) +
				'. A metric with no manifest entry has no declared aggregation law, so platform.metricsSnapshot() cannot merge it across workers and will pass it through per-worker as if it were the app\'s own.'
			).toEqual([]);

			const mismatched = [];
			for (const [name, reg] of registered) {
				const signal = manifest.get(name);
				if (signal === undefined) continue;
				const code = { type: reg.type, labels: [...reg.labels], help: reg.help };
				const claimed = { type: signal.type, labels: [...signal.labels], help: signal.help };
				if (JSON.stringify(code) !== JSON.stringify(claimed)) mismatched.push(`${name}: code ${JSON.stringify(code)} vs manifest ${JSON.stringify(claimed)}`);
			}
			expect(mismatched).toEqual([]);
		});

		it('every manifest signal that a worker registers is registered in code', () => {
			const phantom = fromRegistry.filter((n) => !registered.has(n)).sort();
			expect(
				phantom,
				'declared in the manifest but never registered in code: ' + JSON.stringify(phantom) +
				'. Either the registration was removed and the manifest entry is stale, or the entry needs `merged: true` because the cluster merge writes it rather than a worker registering it.'
			).toEqual([]);
		});

		it('the testing declaration names every harness metric and distinguishes event-driven headroom', () => {
			const text = readFileSync(path.join(ROOT, 'src/testing.d.ts'), 'utf8');
			const declaration = text.indexOf('metrics?: MetricsRegistry;');
			expect(declaration, 'the testing metrics option declaration was not found').toBeGreaterThan(-1);
			const start = text.lastIndexOf('/**', declaration);
			const docs = text.slice(start, declaration);
			const harnessMetrics = new Set(
				[...scanned.find((entry) => [...entry.registrations.values()].some((reg) => reg.file === 'src/testing.js')).registrations.values()]
					.filter((reg) => reg.file === 'src/testing.js')
					.map((reg) => reg.metric)
			);
			for (const metric of harnessMetrics) {
				expect(
					new RegExp('`' + metric + '(?:\\{[^}]*\\})?`').test(docs),
					`src/testing.d.ts does not name the harness metric ${metric}`
				).toBe(true);
			}
			expect(harnessMetrics).toContain('ws_connection_headroom');
			expect(docs).toMatch(/event-driven `ws_connection_headroom` gauge/);
			expect(docs).toMatch(/pressure-sampled gauges[\s\S]*production-only/);
		});

		it('the manifest is internally coherent', () => {
			const problems = [];
			for (const s of SIGNALS) {
				if (!['counter', 'gauge', 'histogram'].includes(s.type)) problems.push(`${s.name}: unknown type ${s.type}`);
				if (!['sum', 'max', 'min'].includes(s.aggregate)) problems.push(`${s.name}: unknown aggregation ${s.aggregate}`);
				if (!['worker', 'process'].includes(s.scope)) problems.push(`${s.name}: unknown scope ${s.scope}`);
				// A process-wide reading is the same number on every worker, so
				// adding them up multiplies one truth by the worker count.
				if (s.scope === 'process' && s.aggregate === 'sum') {
					problems.push(`${s.name}: process-scoped values must not sum across workers`);
				}
				// A counter only ever accumulates, so summing is the only law that
				// preserves what it counted.
				if (s.type === 'counter' && s.aggregate !== 'sum') {
					problems.push(`${s.name}: counters must sum across workers, not ${s.aggregate}`);
				}
				if (s.type === 'histogram' && s.aggregate !== 'sum') {
					problems.push(`${s.name}: histograms must sum across workers, not ${s.aggregate}`);
				}
				if (s.name.endsWith('_total') !== (s.type === 'counter')) {
					problems.push(`${s.name}: the _total suffix and the counter type must agree`);
				}
				if (s.unit === 'bytes' && !(s.type === 'counter'
					? s.name.endsWith('_bytes_total')
					: s.name.endsWith('_bytes'))) {
					problems.push(`${s.name}: byte-valued metrics end in _bytes (before _total for counters)`);
				}
				if (s.unit === 'seconds' && !s.name.endsWith('_seconds')) problems.push(`${s.name}: second-valued metrics end in _seconds`);
				// The house convention is no millisecond-valued metric at all -
				// a mixed-unit metric set is how a dashboard silently reads 1000x.
				if (/_ms$|_milliseconds$/.test(s.name)) problems.push(`${s.name}: durations are seconds, never milliseconds`);
			}
			expect(problems).toEqual([]);
		});

		it('no label can carry client identity', () => {
			// The privacy fence the runtime already keeps by hand: no topic
			// string, IP, session or user identifier is ever a label value, so no
			// label NAME may suggest one either. Cardinality follows from the same
			// rule - every declared label is a bounded, source-declared vocabulary.
			const forbidden = /ip|addr|user|session|client|topic|token|email|account|tenant|key/i;
			const offenders = [];
			for (const s of SIGNALS) {
				for (const label of s.labels) {
					if (forbidden.test(label)) offenders.push(`${s.name}{${label}}`);
				}
			}
			expect(
				offenders,
				'these labels read as client identity, which must never reach a metric: ' + JSON.stringify(offenders)
			).toEqual([]);
		});

	});

	it('replay against a strict registry: no emit throws on an undeclared label', () => {
		// Mirrors the extensions createMetrics()/prom-client failure mode:
		// inc() with an undeclared label throws; containMetricInstrument would
		// swallow it in production, which is exactly why this is a test and not
		// a log line.
		const strict = {
			counter: (name, help, labelNames = []) => ({
				inc(labels = {}) {
					for (const key of Object.keys(labels)) {
						if (!labelNames.includes(key)) {
							throw new Error(`unexpected label "${key}" for metric "${name}" (no labels declared)`);
						}
					}
				}
			})
		};
		strict.gauge = strict.counter;
		strict.histogram = strict.counter;
		for (const reg of registrations.values()) {
			const instrument = strict.counter(reg.metric, '', [...reg.labels]);
			for (const emit of emits.filter((e) => registrations.get(e.varName) === reg)) {
				const labels = Object.fromEntries(emit.keys.map((k) => [k, 'x']));
				expect(() => instrument.inc(labels), `${reg.metric} emit threw`).not.toThrow();
			}
		}
	});
});

describe('every enum label VALUE emitted is declared in the manifest', () => {
	// The case above pins label KEYS. A key can be declared while the VALUE
	// carried on it is not: `upgrade_rejected_total{reason}` shipped with
	// `deferred_overflow` emitted from two surfaces and absent from the
	// manifest's enum, and nothing noticed - the label-name comparison passes,
	// and the README/manifest table comparison is over metric ROWS, not over the
	// prose reason list inside a cell.
	//
	// It costs more than tidiness: everything generated from the manifest treats
	// an undeclared value as one that cannot occur, so the alert and dashboard
	// pack has no case for it and a refusal reason is invisible to the operator
	// who is looking for exactly that shed.
	it('emits no reason, outcome or door the manifest does not declare', () => {
		const scanned = FILES.map(scan);
		const registrations = new Map();
		const emits = [];
		for (const { registrations: r, emits: e } of scanned) {
			for (const [k, v] of r) registrations.set(k, v);
			emits.push(...e);
		}
		/** @type {string[]} */
		const undeclared = [];
		for (const emit of emits) {
			const reg = registrations.get(emit.varName);
			if (!reg) continue;
			const signal = SIGNALS.find((sig) => sig.name === reg.metric);
			if (!signal) continue;
			for (const [label, value] of Object.entries(emit.literals ?? {})) {
				const domain = (signal.labelDomains ?? {})[label];
				if (!domain || domain.kind !== 'enum') continue;
				if (!domain.values.includes(value)) {
					undeclared.push(`${reg.metric}{${label}="${value}"} emitted in ${emit.file} but not declared`);
				}
			}
		}
		expect(undeclared, 'an emitted enum value the manifest does not declare is invisible to everything generated from it').toEqual([]);
	});
});
