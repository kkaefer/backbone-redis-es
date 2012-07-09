var assert = require('assert');
var async = require('async');
var _ = require('underscore');
var Backbone = require('backbone');
Backbone.sync = require('..')().sync;

// Setup data model.
var Customer = Backbone.Model.extend({ name: 'customer', lookups: {address: true}});
var Customers = Backbone.Collection.extend({ model: Customer });




function error(model, err) { throw err; }

// Actual tests.
describe('backbone redis', function() {

describe('CRUD workflow', function() {
    var customer = new Customer({
        name: "Horst Meyer",
        address: "23 Example st",
        priority: 3
    });

    it('should store a model', function(done) {
        customer.save(null, {
            error: error,
            success: function(model, resp) {
                assert.ok(model.id);
                done();
            }
        });
    });

    it('should retrieve the model it just stored', function(done) {
        new Customer({ id: customer.id }).fetch({
            error: error,
            success: function(model, resp) {
                assert.deepEqual(model.attributes, customer.attributes);
                done();
            }
        });
    });

    it('should update a model', function(done) {
        customer.save({
            priority: 1
        }, {
            error: error,
            success: function(model, resp) {
                assert.equal(model.get('priority'), 1);
                assert.equal(model.get('_rev'), 2);
                done();
            }
        });
    });

    it('should delete a model', function(done) {
        customer.destroy({
            error: error,
            success: function(model, resp) {
                assert.deepEqual(resp, {});
                done();
            }
        });
    });

    it('should fail to load the deleted model', function(done) {
        new Customer({ id: customer.id }).fetch({
            error: function(model, err) {
                assert.equal(err.message, 'Model does not exist: ' + model.name + ':' + customer.id);
                done();
            },
            success: function(model) {
                throw new Error('Load was successful but should not have been');
            }
        });
    });

}); // end "CRUD workflow"


describe('prevent creation with dupe ID', function() {
    var customer = new Customer({ name: "Joachim Müller"});

    it('should store the initial model', function(done) {
        customer.save(null, {
            error: error,
            success: done.bind(null, null)
        });
    });

    it('should fail to store another model with the same ID', function(done) {
        new Customer({ name: "Joachim Müller", id: customer.id }).save(null, {
            success: function() { throw new Error('Should not have saved this model'); },
            error: function(model, err) {
                assert.equal(err.message, 'Revision number mismatch');
                assert.equal(err.status, 409);
                done();
            }
        });
    });

    after(function(done) {
        customer.destroy({
            error: error,
            success: done.bind(null, null)
        });
    });
}); // end "prevent creation with dupe ID"


describe('collections', function() {
    var data = [
        new Customer({ name: "Peter Müller", priority: 1 }),
        new Customer({ name: "Fritz Mayer", priority: 1 }),
        new Customer({ name: "Anne Gürkner", priority: 2 }),
        new Customer({ name: "Florian Hübner", priority: 3 })
    ];

    var customers = new Customers();

    it('should save the entire collection', function(done) {
        async.forEach(data, function(model, done) {
            model.save(null, {
                error: function(model, err) { done(err); },
                success: function(model, resp) { done(); }
            });
        }, done);
    });

    it('should retrieve the selection', function(done) {
        customers.fetch({
            error: error,
            success: function(collection, resp) {
                assert.deepEqual(
                    collection.toJSON(),
                    data.map(function(a) { return a.toJSON(); })
                );
                done();
            }
        });
    });

    after(function(done) {
        async.forEach(data, function(model, done) {
            model.destroy({
                error: function(model, err) { done(err); },
                success: function(model, resp) { done(); }
            });
        }, done);
    });
});  // end "collections"


describe('lookup by property', function() {
    var data = [
        new Customer({ name: "Ferdinand Müller", priority: 1, address: 'Berlin' }),
        new Customer({ name: "Anke Müller", priority: 1, address: 'Berlin' }),
        new Customer({ name: "Peter Müller", priority: 1, address: 'Dresden' })
    ];

    var customers = new Customers;

    it('should save the entire collection', function(done) {
        async.forEach(data, function(model, done) {
            model.save(null, {
                error: function(model, err) { done(err); },
                success: function(model, resp) { done(); }
            });
        }, done);
    });

    it('should retrieve two customers', function(done) {
        customers.fetch({
            lookup: {
                key: "address",
                value: "Berlin"
            },
            error: error,
            success: function(collection, resp) {
                // TODO: Be sure about collection order
                assert.deepEqual(
                    collection.toJSON(),
                    data.slice(0, 2).map(function(a) { return a.toJSON(); })
                );
                done();
            }
        });
    });

    it('should update lookups', function(done) {
        var firstCustomer = customers.at(0);

        firstCustomer.save({'address': 'Dortmund'}, {
            success: function(){
                customers.fetch({
                    lookup: {
                        key: "address",
                        value: "Dortmund"
                    },
                    error: error,
                    success: function(collection, resp){
                        assert.deepEqual(
                            collection.toJSON(),
                            [firstCustomer.toJSON()]
                        );
                        done();
                    }
                });
            },
            error: error
        });
    });

    it('should fail to retrieve', function(done) {
        customers.fetch({
            lookup: {
                key: "name",
                value: "Ferdinand Müller"
            },
            error: function(model, err) {
                assert.equal(err.message, 'Cannot lookup by property "name"');
                done();
            },
            success: error
        });
    });

    after(function(done) {
        customers.fetch({
            error: error,
            success: function(collection, resp){
                // clone collection.models: can't destroy models while
                // iterating over collection!
                async.forEach(_.clone(collection.models), function(model, done) {
                    model.destroy({
                        error: function(model, err) { done(err); },
                        success: function(model, resp) { done(); }
                    });
                }, done);
            }
        });
    });
}); // end "lookup by property"

}); // end "backbone redis"
