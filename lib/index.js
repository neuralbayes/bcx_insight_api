'use strict';

var Writable = require('stream').Writable;
var bodyParser = require('body-parser');
var compression = require('compression');
var BaseService = require('./service');
var inherits = require('util').inherits;
var BlockController = require('./blocks');
var TxController = require('./transactions');
var AddressController = require('./addresses');
var StatusController = require('./status');
var MessagesController = require('./messages');
var UtilsController = require('./utils');
var CurrencyController = require('./currency');
var RateLimiter = require('./ratelimiter');
var morgan = require('morgan');
var bitcore = require('bitcore-lib');
var _ = bitcore.deps._;
var $ = bitcore.util.preconditions;
var Transaction = bitcore.Transaction;
var EventEmitter = require('events').EventEmitter;

var StatisticsController = require('./statistics');
var AddressBalanceService = require('../services/AddressBalanceService');
var AddressBalanceRepository = require('../repositories/AddressBalanceRepository');
var async = require('async');
var MarketsService = require('../services/MarketsService');
var LastBlockRepository = require('../repositories/LastBlockRepository');
var TotalStatisticRepository = require('../repositories/TotalStatisticRepository');
var StatisticService = require('../services/StatisticService');
var AddressBlocksMinedRepository = require('../repositories/AddressBlocksMinedRepository');
var AddressBlocksMinedService = require('../services/AddressBlocksMinedService');
var Db = require('../components/Db');

/**
 * A service for Bitcore to enable HTTP routes to query information about the blockchain.
 *
 * @param {Object} options
 * @param {Boolean} options.enableCache - This will enable cache-control headers
 * @param {Number} options.cacheShortSeconds - The time to cache short lived cache responses.
 * @param {Number} options.cacheLongSeconds - The time to cache long lived cache responses.
 * @param {String} options.routePrefix - The URL route prefix
 */
var InsightAPI = function(options) {
  BaseService.call(this, options);

  // in minutes
  this.currencyRefresh = options.currencyRefresh || CurrencyController.DEFAULT_CURRENCY_DELAY;

  this.subscriptions = {
    inv: []
  };

  if (!_.isUndefined(options.enableCache)) {
    $.checkArgument(_.isBoolean(options.enableCache));
    this.enableCache = options.enableCache;
  }
  this.cacheShortSeconds = options.cacheShortSeconds;
  this.cacheLongSeconds = options.cacheLongSeconds;

  this.rateLimiterOptions = options.rateLimiterOptions;
  this.disableRateLimiter = options.disableRateLimiter;

  this.blockSummaryCacheSize = options.blockSummaryCacheSize || BlockController.DEFAULT_BLOCKSUMMARY_CACHE_SIZE;
  this.blockCacheSize = options.blockCacheSize || BlockController.DEFAULT_BLOCK_CACHE_SIZE;

  if (!_.isUndefined(options.routePrefix)) {
    this.routePrefix = options.routePrefix;
  } else {
    this.routePrefix = this.name;
  }

  this.txController = new TxController(this.node);

  this.coinShort = options.coinShort || 'BCX';
  this.coinTicker = options.coinTicker || 'https://api.coinmarketcap.com/v1/ticker/bitcoin/?convert=USD';

  this.dbConfig = options.db;
  if (this.dbConfig) {

        this.db = new Db(this.node, this.dbConfig);

        this.db.connect(function (err) {

            if (err) {
                return this.node.log.error('db.connect error');
            }
        });

    } else {
        this.node.log.warn('dbConfig is empty');
    }  
  this.lastBlockRepository = new LastBlockRepository();

  this.addressBlocksMinedRepository = new AddressBlocksMinedRepository();
  this.marketsService = new MarketsService({node: this.node});
  this.addressBalanceRepository = new AddressBalanceRepository();
  this.statisticService = new StatisticService({node: this.node, statisticDayRepository: this.statisticDayRepository, lastBlockRepository: this.lastBlockRepository, totalStatisticRepository: this.totalStatisticRepository});
  this.addressBalanceService = new AddressBalanceService({marketsService: this.marketsService, lastBlockRepository: this.lastBlockRepository, addressBalanceRepository: this.addressBalanceRepository, node: this.node});
  this.addressBlocksMinedService = new AddressBlocksMinedService({node: this.node, addressBlocksMinedRepository: this.addressBlocksMinedRepository, lastBlockRepository: this.lastBlockRepository});
  this.statisticsController = new StatisticsController({
        node: this.node,
        addressBalanceService: this.addressBalanceService,
        statisticService: this.statisticService,
        addressBlocksMinedRepository: this.addressBlocksMinedRepository
    });
};

InsightAPI.dependencies = ['bitcoind', 'web'];

inherits(InsightAPI, BaseService);

InsightAPI.prototype.cache = function(maxAge) {
  var self = this;
  return function(req, res, next) {
    if (self.enableCache) {
      res.header('Cache-Control', 'public, max-age=' + maxAge);
    }
    next();
  };
};

InsightAPI.prototype.cacheShort = function() {
  var seconds = this.cacheShortSeconds || 30; // thirty seconds
  return this.cache(seconds);
};

InsightAPI.prototype.cacheLong = function() {
  var seconds = this.cacheLongSeconds || 86400; // one day
  return this.cache(seconds);
};

InsightAPI.prototype.getRoutePrefix = function() {
  return this.routePrefix;
};

InsightAPI.prototype.start = function(callback) {
  this.node.services.bitcoind.on('tx', this.transactionEventHandler.bind(this));
  this.node.services.bitcoind.on('block', this.blockEventHandler.bind(this));
  //setImmediate(callback);

  this.statisticService.on('updated', function (updInfo) {

      if (!this.subscriptions.inv.length) {
          return false;
      }

      var dataFlow = {
          info: null,
          stakingInfo: null,
          supply: null
      };

      return async.waterfall([function (callback) {
          return this.statusController.getInfo(function (err, info) {
              if (err) {
                  this.node.log.error('getInfo', err);
                  return callback(err);
              }

              dataFlow.info = info;

              return callback();
          });
      }, function (callback) {
          return this.statusController.getStakingInfo(function (err, stakingInfo) {

              if (err) {
                  this.node.log.error('getStakingInfo', err);
                  return callback(err);
              }

              dataFlow.stakingInfo = stakingInfo;

              return callback();
          });
      }], function (err) {

          if (err) {
              return false;
          }

          if (!this.subscriptions.inv.length) {
              return false;
          }

          dataFlow.supply = SupplyHelper.getTotalSupplyByHeight(updInfo.height).toString(10);

          for (var i = 0; i < this.subscriptions.inv.length; i++) {
              this.subscriptions.inv[i].emit('info', dataFlow);
          }

      });

  });

  var self = this;

  return async.waterfall([function (callback) {
      return self.addressBalanceService.start(function (err) {
          return callback(err);
      });
  },function (callback) {
      return self.statisticService.start(function (err) {
          return callback(err);
      })
  }, function (callback) {
      return self.addressBlocksMinedService.start(function (err) {
         return callback(err);
      });
  }], function (err) {
      console.log('finished...');
      if (err) {
          this.node.log.error('START ERROR', err);
      }
      setImmediate(callback);
  });
  //setImmediate(callback);
};

InsightAPI.prototype.createLogInfoStream = function() {
  var self = this;

  function Log(options) {
    Writable.call(this, options);
  }
  inherits(Log, Writable);

  Log.prototype._write = function (chunk, enc, callback) {
    self.node.log.info(chunk.slice(0, chunk.length - 1)); // remove new line and pass to logger
    callback();
  };
  var stream = new Log();

  return stream;
};

InsightAPI.prototype.getRemoteAddress = function(req) {
  if (req.headers['cf-connecting-ip']) {
    return req.headers['cf-connecting-ip'];
  }
  return req.socket.remoteAddress;
};

InsightAPI.prototype._getRateLimiter = function() {
  var rateLimiterOptions = _.isUndefined(this.rateLimiterOptions) ? {} : _.clone(this.rateLimiterOptions);
  rateLimiterOptions.node = this.node;
  var limiter = new RateLimiter(rateLimiterOptions);
  return limiter;
};

InsightAPI.prototype.setupRoutes = function(app) {

  var self = this;

  //Enable rate limiter
  if (!this.disableRateLimiter) {
    var limiter = this._getRateLimiter();
    app.use(limiter.middleware());
  }

  //Setup logging
  morgan.token('remote-forward-addr', function(req){
    return self.getRemoteAddress(req);
  });
  var logFormat = ':remote-forward-addr ":method :url" :status :res[content-length] :response-time ":user-agent" ';
  var logStream = this.createLogInfoStream();
  app.use(morgan(logFormat, {stream: logStream}));

  //Enable compression
  app.use(compression());

  //Enable urlencoded data
  app.use(bodyParser.urlencoded({extended: true}));

  app.use(function(req, res, next) {
    var origin = req.get('origin');
    if (origin == null) {
      // either browser directly, or via insight on the same server
      next();
    } else if (!(self.node.allowedOriginRegexp.test(origin))) {
      res.status(405).send('Origin ' + origin + ' not allowed.');
    } else {
      next();
    }
  });

  app.get('/statistics/richest-addresses-list', this.cacheShort(), this.statisticsController.getRichestAddressesList.bind(this.statisticsController));

  //Block routes
  var blockOptions = {
    node: this.node,
    blockSummaryCacheSize: this.blockSummaryCacheSize,
    blockCacheSize: this.blockCacheSize
  };
  var blocks = new BlockController(blockOptions);
  app.get('/blocks', this.cacheShort(), blocks.list.bind(blocks));

  app.get('/block/:blockHash', this.cacheShort(), blocks.checkBlockHash.bind(blocks), blocks.show.bind(blocks));
  app.param('blockHash', blocks.block.bind(blocks));

  app.get('/rawblock/:blockHash', this.cacheLong(), blocks.checkBlockHash.bind(blocks), blocks.showRaw.bind(blocks));
  app.param('blockHash', blocks.rawBlock.bind(blocks));

  app.get('/block-index/:height', this.cacheShort(), blocks.blockIndex.bind(blocks));
  app.param('height', blocks.blockIndex.bind(blocks));

  // Transaction routes
  var transactions = new TxController(this.node);
  app.get('/tx/:txid', this.cacheShort(), transactions.show.bind(transactions));
  app.param('txid', transactions.transaction.bind(transactions));
  app.get('/txs', this.cacheShort(), transactions.list.bind(transactions));
  app.post('/tx/send', transactions.send.bind(transactions));

  // Raw Routes
  app.get('/rawtx/:txid', this.cacheLong(), transactions.showRaw.bind(transactions));
  app.param('txid', transactions.rawTransaction.bind(transactions));

  // Address routes
  var addresses = new AddressController(this.node);
  app.get('/addr/:addr', this.cacheShort(), addresses.checkAddr.bind(addresses), addresses.show.bind(addresses));
  app.get('/addr/:addr/utxo', this.cacheShort(), addresses.checkAddr.bind(addresses), addresses.utxo.bind(addresses));
  app.get('/addrs/:addrs/utxo', this.cacheShort(), addresses.checkAddrs.bind(addresses), addresses.multiutxo.bind(addresses));
  app.post('/addrs/utxo', this.cacheShort(), addresses.checkAddrs.bind(addresses), addresses.multiutxo.bind(addresses));
  app.get('/addrs/:addrs/txs', this.cacheShort(), addresses.checkAddrs.bind(addresses), addresses.multitxs.bind(addresses));
  app.post('/addrs/txs', this.cacheShort(), addresses.checkAddrs.bind(addresses), addresses.multitxs.bind(addresses));

  // Address property routes
  app.get('/addr/:addr/balance', this.cacheShort(), addresses.checkAddr.bind(addresses), addresses.balance.bind(addresses));
  app.get('/addr/:addr/totalReceived', this.cacheShort(), addresses.checkAddr.bind(addresses), addresses.totalReceived.bind(addresses));
  app.get('/addr/:addr/totalSent', this.cacheShort(), addresses.checkAddr.bind(addresses), addresses.totalSent.bind(addresses));
  app.get('/addr/:addr/unconfirmedBalance', this.cacheShort(), addresses.checkAddr.bind(addresses), addresses.unconfirmedBalance.bind(addresses));

  // Status route
  var status = new StatusController(this.node);
  app.get('/status', this.cacheShort(), status.show.bind(status));
  app.get('/sync', this.cacheShort(), status.sync.bind(status));
  app.get('/peer', this.cacheShort(), status.peer.bind(status));
  app.get('/version', this.cacheShort(), status.version.bind(status));

  // Address routes
  var messages = new MessagesController(this.node);
  app.get('/messages/verify', messages.verify.bind(messages));
  app.post('/messages/verify', messages.verify.bind(messages));

  // Utils route
  var utils = new UtilsController(this.node);
  app.get('/utils/estimatefee', utils.estimateFee.bind(utils));
  app.get('/utils/estimatesmartfee', utils.estimateSmartFee.bind(utils));

  // Currency
  var currency = new CurrencyController({
    node: this.node,
    currencyRefresh: this.currencyRefresh,
    coinTicker: this.coinTicker,
    coinShort: this.coinShort
  });
  app.get('/currency', currency.index.bind(currency));

  // Not Found
  app.use(function(req, res) {
    res.status(404).jsonp({
      status: 404,
      url: req.originalUrl,
      error: 'Not found'
    });
  });

};

InsightAPI.prototype.getPublishEvents = function() {
  return [
    {
      name: 'inv',
      scope: this,
      subscribe: this.subscribe.bind(this),
      unsubscribe: this.unsubscribe.bind(this),
      extraEvents: ['tx', 'block']
    }
  ];
};

InsightAPI.prototype.blockEventHandler = function(hashBuffer) {
  // Notify inv subscribers
  for (var i = 0; i < this.subscriptions.inv.length; i++) {
    this.subscriptions.inv[i].emit('block', hashBuffer.toString('hex'));
  }
};
InsightAPI.prototype.transactionEventHandler = function(txBuffer) {
  var tx = new Transaction().fromBuffer(txBuffer);
  var result = this.txController.transformInvTransaction(tx);

  for (var i = 0; i < this.subscriptions.inv.length; i++) {
    this.subscriptions.inv[i].emit('tx', result);
  }
};

InsightAPI.prototype.subscribe = function(emitter) {
  $.checkArgument(emitter instanceof EventEmitter, 'First argument is expected to be an EventEmitter');

  var emitters = this.subscriptions.inv;
  var index = emitters.indexOf(emitter);
  if(index === -1) {
    emitters.push(emitter);
  }
};

InsightAPI.prototype.unsubscribe = function(emitter) {
  $.checkArgument(emitter instanceof EventEmitter, 'First argument is expected to be an EventEmitter');

  var emitters = this.subscriptions.inv;
  var index = emitters.indexOf(emitter);
  if(index > -1) {
    emitters.splice(index, 1);
  }
};

module.exports = InsightAPI;
