import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const original = WebSocket.prototype.emit;
let failedConnections = 0;
WebSocket.prototype.emit = function (event, ...args) {
	if (event === 'close' && this.url && args[0] === 1011) {
		assert.equal(args[1].toString(), 'Connection setup failed');
		failedConnections++;
	}
	return original.call(this, event, ...args);
};
try {
	await import('./setup-failure-child.mjs');
	assert.equal(failedConnections, 1, 'one failed setup carries the close reason');
} finally {
	WebSocket.prototype.emit = original;
}
