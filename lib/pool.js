/* jshint node: true */
"use strict";
var _ = require('lodash');
var asyncjs = require('async');
var uuid = require('node-uuid');
var jinst = require("./jinst");
var dm = require('./drivermanager');
var Connection = require('./connection');
var debug = require('debug')('jdbc');

var java = jinst.getInstance();

if (!jinst.isJvmCreated()) {
  jinst.addOption("-Xrs");
}

var addConnection = function(url, props, callback) {
  debug("addConnection");
  dm.getConnection(url, props, function(err, conn) {
    if (err) {
      return callback(err);
    } else {
      return callback(null, {uuid: uuid.v4(), conn: new Connection(conn)});
    }
  });
};

function Pool(config) {
  this._url = config.url;
  this._props = (function (config) {
    var Properties = java.import('java.util.Properties');
    var properties = new Properties();

    for(var name in config.properties) {
      properties.putSync(name, config.properties[name]);
    }

    if (config.user && properties.getPropertySync('user') === undefined) {
      properties.putSync('user', config.user);
    }

    if (config.password && properties.getPropertySync('password') === undefined) {
      properties.putSync('password', config.password);
    }

    return properties;
  })(config);
  this._driver = null;
  this._drivername = config.drivername ? config.drivername : '';
  this._minpoolsize = config.minpoolsize ? config.minpoolsize : 1;
  this._maxpoolsize = config.maxpoolsize ? config.maxpoolsize : 1;
  this._pool = [];
  this._reserved = [];
}

Pool.prototype.status = function() {
  var self = this;
  console.log("########## POOL STATUS ##########");
  console.log("AVAILABLE: " + self._pool.length);
  _.each(self._pool, function(el) { console.log("  UUID: " + el.uuid); });
  console.log("");
  console.log("RESERVED:  " + self._reserved.length);
  _.each(self._reserved, function(el) { console.log("  UUID: " + el.uuid); });
  console.log("#################################");
  console.log("");
};

Pool.prototype.initialize = function(callback) {
  var self = this;

  // If a drivername is supplied, initialize the via the old method,
  // Class.forName()
  if (this._drivername) {
    java.newInstance(this._drivername, function(err, driver) {
      if (err) {
        return callback(err);
      } else {
        self._driver = driver;
        dm.registerDriver(driver, function(err) {
          if (err) {
            return callback(err);
          }
        });
      }
    });
  }

  asyncjs.times(self._minpoolsize, function(n, next){
    addConnection(self._url, self._props, function(err, conn) {
      next(err, conn);
    });
  }, function(err, conns) {
    if (err) {
      return callback(err);
    } else {
      _.each(conns, function(conn) {
        self._pool.push(conn);
      });
      return callback(null);
    }
  });

  jinst.events.emit('initialized');
};

Pool.prototype.reserve = function(callback) {
  var self = this;

  debug("reserve pool:", self._pool.length, "reserved:", self._reserved.length);

  if (self._pool.length > 0 ) {
    var conn = self._pool.shift();
    self._reserved.unshift(conn);
    return callback(null, conn);
  } else if (self._reserved.length < self._maxpoolsize) {
    addConnection(self._url, self._props, function(err, conn) {
      if (err) {
        return callback(err);
      } else {
        self._reserved.unshift(conn);
        return callback(null, conn);
      }
    });
  } else {
    return callback(new Error("No more pool connections available"));
  }
};

Pool.prototype.release = function(conn, callback) {
  var self = this;
  debug("release pool:", self._pool.length, "reserved:", self._reserved.length);

  if (typeof conn === 'object') {
    var uuid = conn.uuid;
    self._reserved = _.reject(self._reserved, function(conn) {
      return conn.uuid === uuid;
    });
    self._pool.unshift(conn);
    return callback(null);
  } else {
    return callback(new Error("INVALID CONNECTION"));
  }
};


Pool.prototype.info = function(callback) {
  var self = this;
  debug("info on connections",  self._pool.length, "reserved:", self._reserved.length);
  asyncjs.map(self._pool.concat(self._reserved),
    function(conn, cb){  if (conn.conn === null) cb(null, false); else return conn.conn.isValid(2000, cb);},
    function(err, results) {
      debug("results:", results);
      callback();
    });
};

Pool.prototype.purge = function(callback) {
  var self = this;
  debug("purging connections",  self._pool.length, "reserved:", self._reserved.length);
  asyncjs.map(self._pool.concat(self._reserved),
    function(conn, done) {
      if (typeof conn === 'object' && conn.conn !== null) {
        conn.conn.close(function(err) {
          if(err) {
            debug('error when closing connection, perhaps its already closed: ', err);
          } else {
            debug("connection has been closed: ");
          }
          done();
        });
      } else {
        done();
      }
    },
    function() {
      self._pool = [];
      self._reserved = [];

      debug("pool connections have been purged, and pool arrays are re-initiated");

      callback();
    }
  );
};

module.exports = Pool;
