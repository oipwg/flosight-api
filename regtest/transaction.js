'use strict';

var expect = require('chai').expect;
var spawn = require('child_process').spawn;
var rimraf = require('rimraf');
var mkdirp = require('mkdirp');
var fs = require('fs');
var async = require('async');
var RPC = require('florincoind-rpc');
var http = require('http');

var rpc1Address;
var rpc2Address;
var tx1;
var tx2;
var block;
var blocksGenerated = 0;

var rpcConfig = {
  protocol: 'http',
  user: 'local',
  pass: 'localtest',
  host: '127.0.0.1',
  port: 58332,
  rejectUnauthorized: false
};

var rpc1 = new RPC(rpcConfig);
rpcConfig.port++;
var rpc2 = new RPC(rpcConfig);
var debug = true;
var flocoreDataDir = '/tmp/flocore';
var florincoinDataDirs = ['/tmp/florincoin1', '/tmp/florincoin2'];

var florincoin = {
  args: {
    datadir: null,
    listen: 1,
    regtest: 1,
    server: 1,
    rpcuser: 'local',
    rpcpassword: 'localtest',
    //printtoconsole: 1
    rpcport: 58332,
  },
  datadir: null,
  exec: 'florincoind', //if this isn't on your PATH, then provide the absolute path, e.g. /usr/local/bin/florincoind
  processes: []
};

var flocore = {
  configFile: {
    file: flocoreDataDir + '/flocore-node.json',
    conf: {
      network: 'regtest',
      port: 53001,
      datadir: flocoreDataDir,
      services: [
        'p2p',
        'db',
        'header',
        'block',
        'address',
        'transaction',
        'mempool',
        'web',
        'flosight-api',
        'fee',
        'timestamp'
      ],
      servicesConfig: {
        'p2p': {
          'peers': [
            { 'ip': { 'v4': '127.0.0.1' }, port: 18444 }
          ]
        },
        'flosight-api': {
          'routePrefix': 'api'
        }
      }
    }
  },
  httpOpts: {
    protocol: 'http:',
    hostname: 'localhost',
    port: 53001,
  },
  opts: { cwd: flocoreDataDir },
  datadir: flocoreDataDir,
  exec: 'flocored', //if this isn't on your PATH, then provide the absolute path, e.g. /usr/local/bin/flocored
  args: ['start'],
  process: null
};

var request = function(httpOpts, callback) {

  var request = http.request(httpOpts, function(res) {

    if (res.statusCode !== 200 && res.statusCode !== 201) {
      return callback('Error from flocore-node webserver: ' + res.statusCode);
    }

    var resError;
    var resData = '';

    res.on('error', function(e) {
      resError = e;
    });

    res.on('data', function(data) {
      resData += data;
    });

    res.on('end', function() {

      if (resError) {
        return callback(resError);
      }
      var data = JSON.parse(resData);
      callback(null, data);

    });

  });

  request.on('error', function(err) {
    callback(err);
  });

  if (httpOpts.body) {
    request.write(httpOpts.body);
  } else {
    request.write('');
  }
  request.end();
};

var waitForBlocksGenerated = function(callback) {

  var httpOpts = {
    hostname: 'localhost',
    port: 53001,
    path: '/api/status',
    method: 'GET',
    headers: {
      'Content-Type': 'application/json'
    }
  };

  async.retry({ interval: 1000, times: 100 }, function(next) {

    request(httpOpts, function(err, data) {
      if (err) {
        return next(err);
      }
      if (data.info.blocks < blocksGenerated) {
        return next(data);
      }
      next();
    });

  }, callback);
};

var startFlorincoind = function(count, callback) {

  var listenCount = 0;
  async.timesSeries(count, function(n, next) {

    var datadir = florincoinDataDirs.shift();

    florincoin.datadir = datadir;
    florincoin.args.datadir = datadir;

    if (listenCount++ > 0) {
      florincoin.args.listen = 0;
      florincoin.args.rpcport++;
      florincoin.args.connect = '127.0.0.1';
    }

    rimraf(datadir, function(err) {

      if(err) {
        return next(err);
      }

      mkdirp(datadir, function(err) {

        if(err) {
          return next(err);
        }

        var args = florincoin.args;
        var argList = Object.keys(args).map(function(key) {
          return '-' + key + '=' + args[key];
        });

        var florincoinProcess = spawn(florincoin.exec, argList, florincoin.opts);
        florincoin.processes.push(florincoinProcess);

        florincoinProcess.stdout.on('data', function(data) {

          if (debug) {
            process.stdout.write(data.toString());
          }

        });

        florincoinProcess.stderr.on('data', function(data) {

          if (debug) {
            process.stderr.write(data.toString());
          }

        });

        next();

      });

    });
  }, function(err) {

      if (err) {
        return callback(err);
      }

      var pids = florincoin.processes.map(function(process) {
        return process.pid;
      });

      console.log(count + ' florincoind\'s started at pid(s): ' + pids);

      async.retry({ interval: 1000, times: 1000 }, function(next) {
        rpc1.getInfo(function(err, res) {
          if (err) {
            return next(err);
          }
          // there is a bit of time even after the rpc server comes online that the rpc server is not truly ready
          setTimeout(function(err) {
            next();
          }, 1000);
        });
      }, callback);

  });
};


var shutdownFlorincoind = function(callback) {
  florincoin.processes.forEach(function(process) {
    process.kill();
  });
  setTimeout(callback, 3000);
};

var shutdownFlocore = function(callback) {
  if (flocore.process) {
    flocore.process.kill();
  }
  callback();
};


var buildInitialChain = function(callback) {
  async.waterfall([
    function(next) {
      console.log('checking to see if florincoind\'s are connected to each other.');
      rpc1.getinfo(function(err, res) {
        if (err || res.result.connections !== 1) {
          next(err || new Error('florincoind\'s not connected to each other.'));
        }
        next();
      });
    },
    function(next) {
      console.log('generating 101 blocks');
      blocksGenerated += 101;
      rpc1.generate(101, next);
    },
    function(res, next) {
      console.log('getting new address from rpc2');
      rpc2.getNewAddress(function(err, res) {
        if (err) {
          return next(err);
        }
        rpc2Address = res.result;
        console.log(rpc2Address);
        next(null, rpc2Address);
      });
    },
    function(addr, next) {
      rpc1.sendToAddress(rpc2Address, 25, next);
    },
    function(res, next) {
      tx1 = res.result;
      console.log('TXID: ' + res.result);
      console.log('generating 6 blocks');
      blocksGenerated += 6;
      rpc1.generate(7, next);
    },
    function(res, next) {
      block = res.result[res.result.length - 1];
      rpc2.getBalance(function(err, res) {
        console.log(res);
        next();
      });
    },
    function(next) {
      console.log('getting new address from rpc1');
      rpc1.getNewAddress(function(err, res) {
        if (err) {
          return next(err);
        }
        rpc1Address = res.result;
        next(null, rpc1Address);
      });
    },
    function(addr, next) {
      rpc2.sendToAddress(rpc1Address, 20, next);
    },
    function(res, next) {
      tx2 = res.result;
      console.log('sending from rpc2Address TXID: ', res);
      console.log('generating 6 blocks');
      blocksGenerated += 6;
      rpc2.generate(6, next);
    }
  ], function(err) {

    if (err) {
      return callback(err);
    }
    rpc1.getInfo(function(err, res) {
      console.log(res);
      callback();
    });
  });

};

var startFlocore = function(callback) {

  rimraf(flocoreDataDir, function(err) {

    if(err) {
      return callback(err);
    }

    mkdirp(flocoreDataDir, function(err) {

      if(err) {
        return callback(err);
      }

      fs.writeFileSync(flocore.configFile.file, JSON.stringify(flocore.configFile.conf));

      var args = flocore.args;
      flocore.process = spawn(flocore.exec, args, flocore.opts);

      flocore.process.stdout.on('data', function(data) {

        if (debug) {
          process.stdout.write(data.toString());
        }

      });
      flocore.process.stderr.on('data', function(data) {

        if (debug) {
          process.stderr.write(data.toString());
        }

      });

      waitForBlocksGenerated(callback);
    });

  });


};

describe('Transaction', function() {

  this.timeout(60000);

  before(function(done) {

    async.series([
      function(next) {
        startFlorincoind(2, next);
      },
      function(next) {
        buildInitialChain(next);
      },
      function(next) {
        startFlocore(next);
      }
    ], function(err) {
        if (err) {
          return done(err);
        }
        setTimeout(done, 2000);
    });

  });

  after(function(done) {
    shutdownFlocore(function() {
      shutdownFlorincoind(done);
    });
  });

  it('should get a transaction: /tx/:txid', function(done) {

    var httpOpts = {
      hostname: 'localhost',
      port: 53001,
      path: 'http://localhost:53001/api/tx/' + tx1,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    };

    request(httpOpts, function(err, data) {

      if(err) {
        return done(err);
      }

      expect(data.txid).to.equal(tx1);
      done();

    });
  });

  it('should get transactions: /txs', function(done) {

    var httpOpts = {
      hostname: 'localhost',
      port: 53001,
      path: 'http://localhost:53001/api/txs?block=' + block,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    };

    request(httpOpts, function(err, data) {

      if(err) {
        return done(err);
      }

      console.log(data);
      expect(data.txs.length).to.equal(1);
      done();

    });
  });

  it('should get a raw transactions: /rawtx/:txid', function(done) {

    var httpOpts = {
      hostname: 'localhost',
      port: 53001,
      path: 'http://localhost:53001/api/rawtx/' + tx2,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    };

    request(httpOpts, function(err, data) {

      if(err) {
        return done(err);
      }

      console.log(data);
      expect(data.rawtx).to.not.be.null;
      done();

    });
  });
});



