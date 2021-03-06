/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var mod_assert = require('assert-plus');
var mod_sdc = require('sdc-clients');
var mod_vasync = require('vasync');
var mod_once = require('once');
var mod_verror = require('verror');

var VError = mod_verror.VError;


function
ZoneList(log, sapi_url, vmapi_url, appname)
{
	mod_assert.object(log);
	mod_assert.string(sapi_url);
	mod_assert.string(vmapi_url);
	mod_assert.string(appname);

	this.zl_log = log;
	this.zl_sapi_url = sapi_url;
	this.zl_vmapi_url = vmapi_url;
	this.zl_appname = appname;

	this.zl_sapi = new mod_sdc.SAPI({
		log: this.zl_log,
		url: this.zl_sapi_url
	});

	this.zl_vmapi = new mod_sdc.VMAPI({
		log: this.zl_log,
		url: this.zl_vmapi_url
	});

	this.zl_timeout = null;

	this._resched(1);

	this.zl_application = null;
}

ZoneList.prototype.ready = function
ready()
{
	var self = this;

	return (!!self.zl_application);
};

ZoneList.prototype.get_zones_for_server = function
get_zones_for_server(server_uuid)
{
	var self = this;

	if (!self.zl_application)
		return ([]);

	var out = [];

	for (var i = 0; i < self.zl_application.app_zones.length; i++) {
		var z = self.zl_application.app_zones[i];
		if (z.zone_server === server_uuid) {
			out.push({
				uuid: z.zone_uuid,
				role: z.zone_role
			});
		}
	}

	return (out);
};

ZoneList.prototype._resched = function
_resched(to)
{
	var self = this;

	if (!to && to !== 0)
		to = 60;

	if (!self.zl_timeout) {
		self.zl_timeout = setTimeout(function () {
			self._prefetch_zone_list();
		}, to * 1000);
	}
};

ZoneList.prototype._prefetch_zone_list = function
_prefetch_zone_list()
{
	var self = this;

	if (self.zl_timeout) {
		clearTimeout(self.zl_timeout);
		self.zl_timeout = null;
	}

	var opts = {
		name: self.zl_appname
	};
	self.zl_sapi.listApplications(opts, function (err, apps) {
		if (err) {
			self.zl_log.error({
				err: err
			}, 'SAPI Error');
			self._resched();
			return;
		}

		if (apps.length !== 1) {
			self.zl_log.error({
				search_opts: opts,
				apps: apps
			}, 'there was more than 1 matching SAPI application');
			self._resched();
			return;
		}

		var appobj = {
			app_name: apps[0].name,
			app_uuid: apps[0].uuid,
			app_zones: []
		};
		self.zl_log.debug(appobj, 'selected SAPI application');

		self.__get_services(appobj, function (err) {
			if (err) {
				err = new VError(err, 'error getting services');
				self.zl_log.error({
					err: err
				}, 'error getting services');
				self._resched();
				return;
			}

			/*
			 * We don't want to try and archive logs unless the
			 * zone actually exists:
			 */
			appobj.app_zones = appobj.app_zones.filter(
			    function __filter_extant_zones(zone) {
				return (zone.zone_state === 'running' ||
				    zone.zone_state === 'stopped');
			});

			/*
			 * Swap in our new view of the application:
			 * TODO could potentially _diff_ the two, and produce
			 * events for zones that "go away."
			 */
			self.zl_application = appobj;
			self.zl_log.debug({
				appobj: appobj
			}, 'UPDATED VIEW');
			self._resched();
		});
	});
};

ZoneList.prototype.__get_services = function
__get_services(appobj, callback)
{
	callback = mod_once(callback);
	var self = this;

	var q = mod_vasync.queuev({
		worker: self.__get_instances.bind(self),
		concurrency: 1
	});
	q.drain = function () {
		mod_vasync.forEachPipeline({
			func: self.__get_instance_server.bind(self),
			inputs: appobj.app_zones
		}, callback);
	};

	var opts = {
		application_uuid: appobj.app_uuid,
		type: 'vm'
	};
	self.zl_sapi.listServices(opts, function (err, svcs) {
		if (err) {
			err = new VError(err, 'SAPI list services failed ' +
			    'for application "%s", "%s"', appobj.app_name,
			    appobj.app_uuid);
			callback(err);
			return;
		}

		for (var i = 0; i < svcs.length; i++) {
			q.push({
				app: appobj,
				svc_uuid: svcs[i].uuid,
				svc_name: svcs[i].name
			});
		}
		if (q.npending === 0 && q.queued.length === 0)
			q.drain();
	});
};

ZoneList.prototype.__get_instances = function
__get_instances(task, callback)
{
	var self = this;

	var opts = {
		service_uuid: task.svc_uuid
	};
	self.zl_sapi.listInstances(opts, function (err, insts) {
		if (err) {
			err = new VError(err, 'SAPI list instances failed ' +
			    'for service "%s", "%s"', task.svc_name,
			    task.svc_uuid);
			callback(err);
			return;
		}

		for (var i = 0; i < insts.length; i++) {
			task.app.app_zones.push({
				zone_role: task.svc_name,
				zone_uuid: insts[i].uuid,
				zone_server: null,
				zone_state: null
			});
		}

		callback();
	});
};

ZoneList.prototype.__get_instance_server = function
__get_instance_server(zone, callback)
{
	var self = this;

	var params = {
		uuid: zone.zone_uuid
	};
	self.zl_vmapi.getVm(params, function (err, vm) {
		if (err) {
			err = new VError(err, 'get VM failed for "%s"',
			     zone.zone_uuid);
			callback(err);
			return;
		}

		zone.zone_server = vm.server_uuid;
		zone.zone_state = vm.state;
		callback();
	});
};

module.exports = {
	ZoneList: ZoneList
};

/* vim: set syntax=javascript ts=8 sts=8 sw=8 noet: */
