var Backbone = require('backbone');
var _ = require('underscore');
var async = require('async');
var redis = require('redis');

module.exports = function(port, host, options) {
    var db = redis.createClient(port, host, options);

    // Starts modifying a model with a given ID. Ensures that the _rev numbers
    // match and monitors the key for changes.
    function modify(id, model, callback) {
        var key = model.name + ':' + id;

        db.watch(key);
        db.hget(key, '_rev', function(err, rev) {
            if (rev === null || (rev|0) === model.get('_rev')) {
                callback(null, (rev|0) + 1);
            } else {
                db.unwatch(function(err) {
                    if (!err) {
                        err = new Error('Revision number mismatch');
                        err.status = 409; // HTTP status code for Conflict
                    }
                    callback(err);
                });
            }
        });
    }

    function storeDependencies(data, callback) {
        async.forEach(_.values(data), function(item, done) {
            if (item.attributes && !item.id) {
                // Call save before continuing
                item.save({}, {
                    success: function(model, resp) { done(); },
                    error: function(model, error) { done(error); }
                });
            } else {
                // This is a literal value. We don't need to do anything.
                done();
            }
        }, callback);
    }

    function store(id, model, options) {
        // TODO: determine if a Lua script makes sense instead of multi
        modify(id, model, function(err, rev) {
            if (err) return options.error(err);

            var data = model.toJSON();

            if (typeof data.id !== 'undefined' && data.id !== id) {
                // TODO: Enable this by creating a copy, then deleting the current one.
                return options.error(new Error('Changing the ID of an existing model is not possible'));
            }

            // console.trace(data);
            storeDependencies(data, function(err) {
                if (err) return options.error(err);

                for (var props in data) {
                    if (data[props].attributes) {
                        data[props] = data[props].id;
                    }
                }

                if (rev === 1) {
                    return execMulti(null);
                } else {
                    return get(model.name, id, execMulti);
                }
            });

            function execMulti(err, previous) {
                if (err) return options.error(err);

                var multi = db.multi();
                // Store the actual data.
                // TODO: When this contains references to other models,
                //       we should just store the model ID
                // TODO: Handle member collections

                data.id = id;
                data._rev = rev;
                var args = [ model.name + ':' + id ];
                for (var prop in data) {
                    args.push(prop, JSON.stringify(data[prop]));
                }
                multi.hmset.apply(multi, args);

                // Store by-property lookups
                // as set with key model:property:value = id
                var lookup;
                if (previous) {
                    for (lookup in model.lookups) {
                        if (previous[lookup] !== data[lookup]) {
                            multi.srem(model.name + ':' + lookup + ':' + JSON.stringify(previous[lookup]), id);
                        }
                    }
                }
                for (lookup in model.lookups) {
                    multi.sadd(model.name + ':' + lookup + ':' + JSON.stringify(data[lookup]), id);
                }

                // TODO: By-property lookup for members which are collections

                // Add this model to the set of models of this type if it's the
                // first time we save this model.
                if (rev === 1) {
                    multi.sadd(model.name, id);
                }

                // Commit everything to the database.
                multi.exec(function(err) {
                    if (err) {
                        options.error(err);
                    } else if (rev === 1) {
                        // When creating this model, we also need to set the ID.
                        options.success({ id: id, _rev: rev });
                    } else {
                        // Otherwise, just return the updated revision number.
                        options.success({ _rev: rev });
                    }
                });
            }
        });
    }

    function get(type, id, done) {
        db.hgetall(type + ':' + id, function(err, data) {
            if (err) return done(err);
            if (!data) return done(new Error('Model does not exist: ' + type + ':' + id));

            for (var key in data) {
                data[key] = JSON.parse(data[key]);
            }
            done(null, data);
        });
    }

    function retrieveAll(type, collection, options) {
        db.smembers(type, function(err, members) {
            if (err) return options.error(err);

            async.map(members, function(id, done) {
                get(type, id, done);
            }, function(err, results) {
                if (err) return options.error(err);
                options.success(results);
            });
        });
    }

    function retrieveByProperty(type, collection, key, value, options, done){
        var lookup = type + ':' + key + ':' + JSON.stringify(value);
        db.smembers(lookup, function(err, members) {
            if (err) return options.error(err);

            async.map(members, function(id, done) {
                get(type, id, done);
            }, function(err, results) {
                if (err) return options.error(err);
                options.success(results);
            });
        });
    }

    function retrieve(id, model, options) {
        // Retrieves all values in that hash.
        get(model.name, id, function(err, data) {
            if(err) {
                options.error(err);
            } else {
                options.success(data);
            }
        });
    }

    function destroy(id, model, options) {
        modify(id, model, function(err, rev) {
            get(model.name, id, function(err, data) {
                if (err) return options.error(err);

                var multi = db.multi();
                multi.del(model.name + ':' + id);
                multi.srem(model.name, id);

                for (var lookup in model.lookups) {
                    data[lookup] = JSON.stringify(data[lookup]);
                    multi.srem(model.name + ':' + lookup + ':' + data[lookup], id);
                }

                // Commit everything to the database.
                multi.exec(function(err) {
                    if(err) {
                        options.error(err);
                    } else {
                        options.success({});
                    }
                });
            });
        });
    }


    function sync(method, model, options) {
        if (model instanceof Backbone.Model && !model.name) {
            throw new Error('A "name" property must be specified');
        }

        switch (method) {
        case 'create':
            db.incr('id:' + model.name, function(err, id) {
                if (err) return options.error(err);
                store(id, model, options);
            });
            break;
        case 'read':
            if (model instanceof Backbone.Collection) {
                if (options.lookup) {
                    if (typeof model.model.prototype.lookups[options.lookup.key] === 'undefined') {
                        options.error(new Error('Cannot lookup by property "' + options.lookup.key + '"'));
                        break;
                    }
                    retrieveByProperty(model.model.prototype.name, model,
                        options.lookup.key, options.lookup.value, options);
                } else {
                    retrieveAll(model.model.prototype.name, model, options);
                }
            } else {
                // TODO: Handle loading models based on other parameters than id.
                if (!model.id) {
                    options.error(new Error('An id is required to load models'));
                    break;
                }
                retrieve(model.id, model, options);
            }
            break;
        case 'update':
            store(model.id, model, options);
            break;
        case 'delete':
            destroy(model.id, model, options);
            break;
        default:
            options.error(new Error('Invalid method ' + method));
        }
    }

    function quit() {
        db.quit();
    }

    return {
        db: db,
        quit: quit,
        sync: sync
    };
};
