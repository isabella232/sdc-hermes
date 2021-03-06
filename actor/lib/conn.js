/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var mod_assert = require('assert-plus');
var mod_watershed = require('watershed');
var mod_http = require('http');
var mod_once = require('once');

var WATERSHED = new mod_watershed.Watershed();

function
connect_server(server, callback)
{
	var t = server.split(':');
	mod_assert.strictEqual(t.length, 2);
	mod_assert.func(callback);

	callback = mod_once(callback);

	var wskey = WATERSHED.generateKey();
	var wsc;

	var options = {
		host: t[0],
		port: t[1],
		method: 'GET',
		path: '/attach',
		headers: {
			'connection': 'upgrade',
			'upgrade': 'websocket',
			'sec-websocket-key': wskey
		}
	};

	var req = mod_http.request(options);

	req.on('error', function (err) {
		if (wsc)
			wsc.destroy();
		wsc = null;
		callback(err);
	});

	req.on('upgrade', function (res, socket, head) {
		socket.setKeepAlive(true);
		try {
			wsc = WATERSHED.connect(res, socket, head, wskey);
		} catch (ex) {
			callback(ex);
			return;
		}
		callback(null, wsc);
	});

	req.on('response', function () {
		callback(new Error('server did not upgrade'));
	});

	req.end();
}

module.exports = {
	connect_server: connect_server
};

/* vim: set syntax=javascript ts=8 sts=8 sw=8 noet: */
