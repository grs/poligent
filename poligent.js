/*
 * Copyright 2016 Red Hat Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

var fs = require('fs');
var Promise = require('bluebird');
var amqp = require('rhea');
var rtr = require('./qdr.js');

var filename = 'desired.json';
var connection_properties = {product:'poligent', container_id:process.env.HOSTNAME};

var vhosts = {};
var routers = {};

function add_by_name(map, o) {
    map[o.name] = o;
    return map;
}

function index_by_name (a) {
    return a.reduce(add_by_name, {});
}

function is_non_null_object(o) {
    return typeof(o) == "object" && o !== null;
}

function as_expected (desired, actual) {
    if (is_non_null_object(desired) && is_non_null_object(actual)) {
        for (var field in desired) {
            if (!as_expected(desired[field], actual[field])) {
                return false;
            }
        }
        return true;
    } else {
        return desired === actual;
    }
}

function Router(connection) {
    this.agent = new rtr.Router(connection);
    this.id = this.agent.connection.container_id;
}

Router.prototype._sync = function (desired, actual) {
    var futures = [];
    for (var name in desired) {
        if (actual[name] === undefined) {
            console.log('creating vhost ' + name + ' on ' + this.id);
            futures.push(this.agent.create_vhost(desired[name]));
        } else if (!as_expected(desired[name], actual[name])) {
            console.log('updating vhost ' + name + ' on ' + this.id);
            futures.push(this.agent.update_vhost(desired[name]));
        }
    }
    for (var name in actual) {
        if (desired[name] === undefined) {
            console.log('deleting vhost ' + name + ' on ' + this.id);
            futures.push(this.agent.delete_vhost(actual[name]));
        }
    }
    if (futures.length > 0) {
        var self = this;
        return Promise.all(futures).then(function () {
            console.log('updates complete on ' + self.id + ', rechecking...');
            return self.sync_policy(desired);
        });
    } else {
        return Promise.resolve(true);
    }
}

Router.prototype.sync_policy = function (desired) {
    var self = this;
    return this.agent.get_vhosts().then(function (results) {
        console.log('retrieved vhosts from ' + self.id + ': ' + JSON.stringify(results));
        return self._sync(desired, index_by_name(results));
    });
};

function sync(router) {
    return router.sync_policy(vhosts).then(
            function () {
                console.log('policy synced on ' + router.id);
            }
        );
}

function sync_all() {
    //check each connected router's policy matches expectations
    var results = [];
    for (var r in routers) {
        results.push(sync(routers[r]));
    }
    return Promise.all(results);
}

function ensure_name(items) {
    //ensure name is part of each item
    for (var name in items) {
        var item = items[name];
        if (item.name === undefined) {
            item.name = name;
        } else if (item.name !== name) {
            item.name = name;
            console.log('overriding name ' + name + ' instead of ' + item.name);
        }
    }
    return items;
}

function on_file_read(err, data) {
    if (err) {
        console.log('could not read file: ' + err);
    } else {
        try {
            vhosts = ensure_name(JSON.parse(data.toString()));
            console.log('policy updated: ' + JSON.stringify(vhosts));
            sync_all().then(function (results) { if (results.length) console.log('all routers synced'); });
        } catch (e) {
            console.log('could not parse data: ' + e + '[' + data + ']');
        }
    }
}

function on_file_change(current, previous) {
    if (current.mtime > previous.mtime) {
        fs.readFile(filename, on_file_read);
    }
}

function get_product (connection) {
    if (connection.properties) {
	return connection.properties.product;
    } else {
	return undefined;
    }
}

amqp.on('connection_open', function(context) {
    var product = get_product(context.connection);
    if (product === 'qpid-dispatch-router') {
        var r = new Router(context.connection);
        console.log('Router connected from ' + context.connection.container_id);
        routers[context.connection.container_id] = r;
        context.connection.on('disconnected', function (context) {
            routers[context.connection.container_id];
        });
        sync(r);
    }
});

fs.readFile(filename, on_file_read);
fs.watchFile(filename, on_file_change);

amqp.sasl_server_mechanisms.enable_anonymous();
amqp.listen({port:55672, properties:connection_properties});

